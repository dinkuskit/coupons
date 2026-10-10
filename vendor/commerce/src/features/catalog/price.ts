import { isRecord } from "../../shared/record.js";
import { CatalogError, catalogFail, catalogStorage } from "./errors.js";
import { moneyEquals, normalizeMoney, saleIsStrictlyLower } from "./money.js";
import type {
  CatalogItemPriceResolution,
  CatalogPriceRecord,
  CatalogPriceStorage,
  ClearCatalogItemPriceInput,
  Money,
  SetCatalogItemPriceInput,
  SetCatalogItemPriceResult,
  SetCatalogItemPriceStorage,
} from "./types.js";

export function catalogPriceRecord(catalogItemId: string, regular: Money, sale?: Money | null): CatalogPriceRecord {
  return { recordKind: "catalog-price", recordId: catalogItemId, catalogItemId, regular, ...(sale ? { sale } : {}) };
}

function requireCatalogItemId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    catalogFail("INVALID_INPUT", "catalogItemId must be a non-empty string");
  }
  return value.trim();
}

function normalizeSetInput(value: unknown): SetCatalogItemPriceInput {
  if (!isRecord(value)) {
    catalogFail("INVALID_INPUT", "price input must be an object");
  }
  if (Object.keys(value).length !== 2) {
    catalogFail("INVALID_INPUT", "price setting accepts only catalogItemId and amount",);
  }
  return {
    catalogItemId: requireCatalogItemId(value.catalogItemId),
    amount: normalizeMoney(value.amount, "amount"),
  };
}

function normalizeClearInput(value: unknown): ClearCatalogItemPriceInput {
  if (!isRecord(value)) {
    catalogFail("INVALID_INPUT", "price clear input must be an object");
  }
  if (Object.keys(value).length !== 1) {
    catalogFail("INVALID_INPUT", "price clear accepts only catalogItemId");
  }
  return { catalogItemId: requireCatalogItemId(value.catalogItemId) };
}

function assertCatalogItem(
  value: Awaited<ReturnType<SetCatalogItemPriceStorage["catalog"]["get"]>>,
  catalogItemId: string,
): void {
  if (value === null || value.recordKind !== "catalog-item") {
    catalogFail("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  if (value.itemId !== catalogItemId) {
    catalogFail("STORAGE_UNAVAILABLE", "stored catalog item identity does not match its key",);
  }
}

function storedPriceError(error: unknown): CatalogError {
  return error instanceof CatalogError && error.code !== "INVALID_INPUT"
    ? error
    : new CatalogError("STORAGE_UNAVAILABLE", "stored catalog price is invalid", { cause: error });
}

function normalizeStoredPrice(
  value: CatalogPriceRecord | null,
  catalogItemId: string,
): CatalogPriceRecord | null {
  if (value === null) return null;
  if (
    value.recordKind !== "catalog-price" ||
    value.recordId !== catalogItemId ||
    value.catalogItemId !== catalogItemId
  ) {
    catalogFail("STORAGE_UNAVAILABLE", "stored catalog price is invalid");
  }
  try {
    const regular = normalizeMoney(value.regular, "stored regular");
    const sale = Object.hasOwn(value, "sale") ? normalizeMoney(value.sale, "stored sale") : undefined;
    if (sale && !saleIsStrictlyLower(sale, regular)) {
      catalogFail("STORAGE_UNAVAILABLE", "stored catalog price is invalid");
    }
    return catalogPriceRecord(catalogItemId, regular, sale);
  } catch (error) {
    throw storedPriceError(error);
  }
}

async function readPrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<CatalogPriceRecord | null> {
  const stored: CatalogPriceRecord | null = await catalogStorage(() => storage.get(catalogItemId), "catalog price lookup failed");
  return normalizeStoredPrice(stored, catalogItemId);
}

async function writePrice(
  storage: CatalogPriceStorage,
  record: CatalogPriceRecord,
): Promise<void> {
  await catalogStorage(() => storage.put(record.recordId, record), "catalog price update failed");
}

async function deletePrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<void> {
  await catalogStorage(() => storage.delete(catalogItemId), "catalog price delete failed");
}

async function requireCatalogItem(
  storage: SetCatalogItemPriceStorage["catalog"],
  catalogItemId: string,
): Promise<void> {
  const item = await catalogStorage(() => storage.get(catalogItemId), "catalog item lookup failed");
  assertCatalogItem(item, catalogItemId);
}

function toResolution(
  catalogItemId: string,
  price: CatalogPriceRecord | null,
): CatalogItemPriceResolution {
  if (price === null) {
    return { catalogItemId, listable: false };
  }
  return {
    catalogItemId,
    listable: true,
    regular: price.regular,
    ...(price.sale === undefined ? {} : { sale: price.sale }),
    customerPays: price.sale ?? price.regular,
  };
}

export async function loadCatalogItemPrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<CatalogPriceRecord | null> {
  return readPrice(storage, catalogItemId);
}

export async function resolveCatalogItemPrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<CatalogItemPriceResolution> {
  if (typeof catalogItemId !== "string" || catalogItemId.trim().length === 0) {
    catalogFail("INVALID_INPUT", "catalogItemId must be a non-empty string");
  }
  const price = await readPrice(storage, catalogItemId.trim());
  return toResolution(catalogItemId.trim(), price);
}

export async function commitCatalogItemPrice(
  storage: SetCatalogItemPriceStorage,
  input: { catalogItemId: string; regular: Money | null; sale: Money | null },
): Promise<CatalogPriceRecord | null> {
  await requireCatalogItem(storage.catalog, input.catalogItemId);
  if (input.sale !== null && input.regular === null) {
    catalogFail("SALE_REQUIRES_REGULAR", "Sale cannot be set until Regular exists",);
  }
  if (
    input.sale !== null &&
    input.regular !== null &&
    !saleIsStrictlyLower(input.sale, input.regular)
  ) {
    catalogFail("SALE_NOT_LOWER_THAN_REGULAR", "Sale must be strictly lower than Regular",);
  }
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (input.regular === null) {
    if (existing === null) return null;
    await deletePrice(storage.prices, input.catalogItemId);
    return null;
  }
  const price = catalogPriceRecord(input.catalogItemId, input.regular, input.sale);
  if (
    existing !== null &&
    moneyEquals(existing.regular, price.regular) &&
    ((existing.sale === undefined && price.sale === undefined) ||
      (existing.sale !== undefined &&
        price.sale !== undefined &&
        moneyEquals(existing.sale, price.sale)))
  ) {
    return existing;
  }
  await writePrice(storage.prices, price);
  return price;
}

export async function setCatalogItemRegularPrice(
  storage: SetCatalogItemPriceStorage,
  rawInput: unknown,
): Promise<SetCatalogItemPriceResult> {
  const input = normalizeSetInput(rawInput);
  await requireCatalogItem(storage.catalog, input.catalogItemId);
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (existing?.sale !== undefined && !saleIsStrictlyLower(existing.sale, input.amount)) {
    catalogFail("SALE_NOT_LOWER_THAN_REGULAR", "Sale must be strictly lower than Regular",);
  }
  if (existing !== null && moneyEquals(existing.regular, input.amount)) {
    return { changed: false, price: existing };
  }
  const price = catalogPriceRecord(input.catalogItemId, input.amount, existing?.sale);
  await writePrice(storage.prices, price);
  return { changed: true, price };
}

export async function setCatalogItemSalePrice(
  storage: SetCatalogItemPriceStorage,
  rawInput: unknown,
): Promise<SetCatalogItemPriceResult> {
  const input = normalizeSetInput(rawInput);
  await requireCatalogItem(storage.catalog, input.catalogItemId);
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (existing === null) {
    catalogFail("SALE_REQUIRES_REGULAR", "Sale cannot be set until Regular exists",);
  }
  if (!saleIsStrictlyLower(input.amount, existing.regular)) {
    catalogFail("SALE_NOT_LOWER_THAN_REGULAR", "Sale must be strictly lower than Regular",);
  }
  if (existing.sale !== undefined && moneyEquals(existing.sale, input.amount)) {
    return { changed: false, price: existing };
  }
  const price = catalogPriceRecord(input.catalogItemId, existing.regular, input.amount);
  await writePrice(storage.prices, price);
  return { changed: true, price };
}

export async function clearCatalogItemSalePrice(
  storage: SetCatalogItemPriceStorage,
  rawInput: unknown,
): Promise<SetCatalogItemPriceResult> {
  const input = normalizeClearInput(rawInput);
  await requireCatalogItem(storage.catalog, input.catalogItemId);
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (existing === null || existing.sale === undefined) {
    return { changed: false, price: existing };
  }
  const price = catalogPriceRecord(input.catalogItemId, existing.regular);
  await writePrice(storage.prices, price);
  return { changed: true, price };
}

export async function clearCatalogItemRegularPrice(
  storage: SetCatalogItemPriceStorage,
  rawInput: unknown,
): Promise<SetCatalogItemPriceResult> {
  const input = normalizeClearInput(rawInput);
  await requireCatalogItem(storage.catalog, input.catalogItemId);
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (existing === null) {
    return { changed: false, price: null };
  }
  if (existing.sale !== undefined) {
    catalogFail("REGULAR_HAS_SALE", "Regular cannot be cleared while Sale exists",);
  }
  await deletePrice(storage.prices, input.catalogItemId);
  return { changed: true, price: null };
}
