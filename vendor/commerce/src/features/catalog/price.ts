import { CatalogError } from "./errors.js";
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCatalogItemId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError("INVALID_INPUT", "catalogItemId must be a non-empty string");
  }
  return value.trim();
}

function normalizeSetInput(value: unknown): SetCatalogItemPriceInput {
  if (!isPlainObject(value)) {
    throw new CatalogError("INVALID_INPUT", "price input must be an object");
  }
  if (Object.keys(value).length !== 2) {
    throw new CatalogError(
      "INVALID_INPUT",
      "price setting accepts only catalogItemId and amount",
    );
  }
  return {
    catalogItemId: requireCatalogItemId(value.catalogItemId),
    amount: normalizeMoney(value.amount, "amount"),
  };
}

function normalizeClearInput(value: unknown): ClearCatalogItemPriceInput {
  if (!isPlainObject(value)) {
    throw new CatalogError("INVALID_INPUT", "price clear input must be an object");
  }
  if (Object.keys(value).length !== 1) {
    throw new CatalogError("INVALID_INPUT", "price clear accepts only catalogItemId");
  }
  return { catalogItemId: requireCatalogItemId(value.catalogItemId) };
}

function assertCatalogItem(
  value: Awaited<ReturnType<SetCatalogItemPriceStorage["catalog"]["get"]>>,
  catalogItemId: string,
): void {
  if (value === null || value.recordKind !== "catalog-item") {
    throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  if (value.itemId !== catalogItemId) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "stored catalog item identity does not match its key",
    );
  }
}

function storedPriceError(error: unknown): CatalogError {
  if (error instanceof CatalogError && error.code === "INVALID_INPUT") {
    return new CatalogError("STORAGE_UNAVAILABLE", "stored catalog price is invalid", {
      cause: error,
    });
  }
  return error instanceof CatalogError
    ? error
    : new CatalogError("STORAGE_UNAVAILABLE", "stored catalog price is invalid", {
        cause: error,
      });
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
    throw new CatalogError("STORAGE_UNAVAILABLE", "stored catalog price is invalid");
  }
  try {
    const regular = normalizeMoney(value.regular, "stored regular");
    if (!Object.hasOwn(value, "sale")) {
      return {
        recordKind: "catalog-price",
        recordId: catalogItemId,
        catalogItemId,
        regular,
      };
    }
    const sale = normalizeMoney(value.sale, "stored sale");
    if (!saleIsStrictlyLower(sale, regular)) {
      throw new CatalogError("STORAGE_UNAVAILABLE", "stored catalog price is invalid");
    }
    return {
      recordKind: "catalog-price",
      recordId: catalogItemId,
      catalogItemId,
      regular,
      sale,
    };
  } catch (error) {
    throw storedPriceError(error);
  }
}

async function readPrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<CatalogPriceRecord | null> {
  let stored: CatalogPriceRecord | null;
  try {
    stored = await storage.get(catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog price lookup failed", {
      cause: error,
    });
  }
  return normalizeStoredPrice(stored, catalogItemId);
}

async function writePrice(
  storage: CatalogPriceStorage,
  record: CatalogPriceRecord,
): Promise<void> {
  try {
    await storage.put(record.recordId, record);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog price update failed", {
      cause: error,
    });
  }
}

async function deletePrice(
  storage: CatalogPriceStorage,
  catalogItemId: string,
): Promise<void> {
  try {
    await storage.delete(catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog price delete failed", {
      cause: error,
    });
  }
}

async function requireCatalogItem(
  storage: SetCatalogItemPriceStorage["catalog"],
  catalogItemId: string,
): Promise<void> {
  let item;
  try {
    item = await storage.get(catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog item lookup failed", {
      cause: error,
    });
  }
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
    throw new CatalogError("INVALID_INPUT", "catalogItemId must be a non-empty string");
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
    throw new CatalogError(
      "SALE_REQUIRES_REGULAR",
      "Sale cannot be set until Regular exists",
    );
  }
  if (
    input.sale !== null &&
    input.regular !== null &&
    !saleIsStrictlyLower(input.sale, input.regular)
  ) {
    throw new CatalogError(
      "SALE_NOT_LOWER_THAN_REGULAR",
      "Sale must be strictly lower than Regular in the same currency",
    );
  }
  const existing = await readPrice(storage.prices, input.catalogItemId);
  if (input.regular === null) {
    if (existing === null) return null;
    await deletePrice(storage.prices, input.catalogItemId);
    return null;
  }
  const price: CatalogPriceRecord = {
    recordKind: "catalog-price",
    recordId: input.catalogItemId,
    catalogItemId: input.catalogItemId,
    regular: input.regular,
    ...(input.sale === null ? {} : { sale: input.sale }),
  };
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
    throw new CatalogError(
      "SALE_NOT_LOWER_THAN_REGULAR",
      "Sale must be strictly lower than Regular in the same currency",
    );
  }
  if (existing !== null && moneyEquals(existing.regular, input.amount)) {
    return { changed: false, price: existing };
  }
  const price: CatalogPriceRecord = {
    recordKind: "catalog-price",
    recordId: input.catalogItemId,
    catalogItemId: input.catalogItemId,
    regular: input.amount,
    ...(existing?.sale === undefined ? {} : { sale: existing.sale }),
  };
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
    throw new CatalogError(
      "SALE_REQUIRES_REGULAR",
      "Sale cannot be set until Regular exists",
    );
  }
  if (!saleIsStrictlyLower(input.amount, existing.regular)) {
    throw new CatalogError(
      "SALE_NOT_LOWER_THAN_REGULAR",
      "Sale must be strictly lower than Regular in the same currency",
    );
  }
  if (existing.sale !== undefined && moneyEquals(existing.sale, input.amount)) {
    return { changed: false, price: existing };
  }
  const price: CatalogPriceRecord = {
    recordKind: "catalog-price",
    recordId: input.catalogItemId,
    catalogItemId: input.catalogItemId,
    regular: existing.regular,
    sale: input.amount,
  };
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
  const price: CatalogPriceRecord = {
    recordKind: "catalog-price",
    recordId: input.catalogItemId,
    catalogItemId: input.catalogItemId,
    regular: existing.regular,
  };
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
    throw new CatalogError(
      "REGULAR_HAS_SALE",
      "Regular cannot be cleared while Sale exists",
    );
  }
  await deletePrice(storage.prices, input.catalogItemId);
  return { changed: true, price: null };
}
