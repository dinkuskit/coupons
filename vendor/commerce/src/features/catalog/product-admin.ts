import { isRecord } from "../../shared/record.js";
import {
  normalizeStoredStockManagement,
  setManageStock,
} from "../inventory-provider/kernel/index.js";
import { CatalogError, catalogFail, catalogStorage } from "./errors.js";
import {
  CLERK_DOLLAR_MESSAGE,
  CLERK_END_SALE_MESSAGE,
  CLERK_SALE_LOWER_MESSAGE,
  CLERK_SALE_NEEDS_REGULAR_MESSAGE,
  formatClerkDollar,
  parseClerkDollar,
  type ParsedClerkDollar,
} from "./clerk-price.js";
import {
  CLERK_STOCK_STATUSES,
  CLERK_STOCK_STATUS_MESSAGE,
  MANAGED_STOCK_STATUS_MESSAGE,
  MANAGE_STOCK_SETUP_PENDING_MESSAGE,
  type ClerkStockStatus,
} from "./clerk-stock.js";
import {
  loadCatalogItemManualAvailability,
  setCatalogItemManualAvailability,
} from "./manual-availability.js";
import { moneyEquals, saleIsStrictlyLower } from "./money.js";
import { catalogPriceRecord, commitCatalogItemPrice, resolveCatalogItemPrice } from "./price.js";
import type {
  CatalogItemRecord,
  CatalogManualAvailabilityStatus,
  CatalogManualAvailabilityStorage,
  CatalogPriceRecord,
  CatalogPriceStorage,
  CatalogStorageRecord,
  CatalogVariantProduct,
  Money,
} from "./types.js";
import { resolveCatalogVariantMember, variantSelections } from "./variants.js";

export { CLERK_STOCK_STATUSES, type ClerkStockStatus } from "./clerk-stock.js";

const LIST_PAGE_LIMIT = 100;
const LIST_PAGE_CAP = 100;

interface PageResult<T> {
  items: Array<{ id: string; data: T }>;
  cursor?: string;
  hasMore: boolean;
}

export interface CatalogProductListStorage {
  catalog: {
    get(id: string): Promise<CatalogStorageRecord | null>;
    query(options?: {
      limit?: number;
      cursor?: string;
    }): Promise<PageResult<CatalogStorageRecord>>;
  };
  prices: CatalogPriceStorage;
  availability: CatalogManualAvailabilityStorage;
}

export interface CatalogProductListItem {
  catalogItemId: string;
  name: string;
  sku: string;
  regular: string | null;
  sale: string | null;
  manageStock: boolean;
  stockStatus: ClerkStockStatus | null;
  gtin?: string;
  mpn?: string;
  brand?: string;
  variantProduct?: {
    productId: string;
    revision: number;
    options: CatalogVariantProduct["options"];
    members: readonly CatalogProductVariantListItem[];
  };
}

export interface CatalogProductVariantListItem {
  catalogItemId: string;
  selections: ReturnType<typeof variantSelections>;
  regular: string | null;
  sale: string | null;
  manageStock: boolean;
  stockStatus: ClerkStockStatus | null;
  fulfillment: "physical" | "digital";
  priceRevision: string | null;
}

export interface SaveCatalogProductPricesInput {
  catalogItemId: string;
  regular: string;
  sale: string;
  manageStock?: boolean;
  stockStatus?: string;
  expectedRevision?: string | null;
}

export interface CatalogProductPriceForm {
  saved: boolean;
  regular: string;
  sale: string;
  manageStock: boolean;
  stockStatus: ClerkStockStatus | null;
  message: string | null;
}

interface CatalogProductSaveCatalogStorage {
  get(id: string): Promise<CatalogStorageRecord | null>;
  getVersioned(
    id: string,
  ): Promise<{ value: CatalogStorageRecord; revision: string } | null>;
  compareAndSet(
    id: string,
    expectedRevision: string | null,
    record: CatalogStorageRecord,
  ): Promise<{ applied: boolean }>;
}

interface SaveStorage {
  catalog: CatalogProductSaveCatalogStorage;
  prices: CatalogPriceStorage;
  availability: CatalogManualAvailabilityStorage;
  /**
   * Native Manage Stock off releases registration claims. Sandbox omits this;
   * v1 admission refuses Manage Stock mutations there.
   */
  releaseRegistrationClaims?: (catalogItemId: string) => Promise<void>;
}

function isClerkStockStatus(value: string): value is ClerkStockStatus {
  return (CLERK_STOCK_STATUSES as readonly string[]).includes(value);
}

function toClerkStockStatus(
  status: CatalogManualAvailabilityStatus,
): ClerkStockStatus {
  return status === "available-on-backorder" ? "on-backorder" : status;
}

function toStoredStockStatus(
  status: ClerkStockStatus,
): CatalogManualAvailabilityStatus {
  return status === "on-backorder" ? "available-on-backorder" : status;
}

async function readPages<T>(
  query: (options?: { limit?: number; cursor?: string }) => Promise<PageResult<T>>,
  failure: string,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    let result: PageResult<T>;
    try {
      result = await query({ limit: LIST_PAGE_LIMIT, cursor });
    } catch (error) {
      catalogFail("STORAGE_UNAVAILABLE", failure, { cause: error });
    }
    for (const item of result.items) rows.push(item.data);
    if (!result.hasMore) return rows;
    if (result.cursor === undefined || result.cursor === cursor) {
      catalogFail("STORAGE_UNAVAILABLE", failure);
    }
    cursor = result.cursor;
  }
  catalogFail("STORAGE_UNAVAILABLE", failure);
}

export async function listCatalogProducts(
  storage: CatalogProductListStorage,
): Promise<{ products: CatalogProductListItem[] }> {
  const records = await readPages(
    (options) => storage.catalog.query(options),
    "catalog product list failed",
  );
  const products: CatalogProductListItem[] = [];
  for (const record of records) {
    if (record.recordKind !== "catalog-item") continue;
    if (record.variantProductId) continue;
    const price = await resolveCatalogItemPrice(storage.prices, record.itemId);
    const managed =
      normalizeStoredStockManagement(record.stockManagement).mode === "managed";
    const availability = managed
      ? null
      : await loadCatalogItemManualAvailability(storage.availability, record.itemId);
    const product: CatalogProductListItem = {
      catalogItemId: record.itemId,
      name: record.name,
      sku: record.sku,
      regular:
        price.listable && price.regular !== undefined
          ? formatClerkDollar(price.regular)
          : null,
      sale: price.sale === undefined ? null : formatClerkDollar(price.sale),
      manageStock: managed,
      stockStatus:
        availability === null ? null : toClerkStockStatus(availability.status),
      ...(record.gtin ? { gtin: record.gtin } : {}),
      ...(record.mpn ? { mpn: record.mpn } : {}),
      ...(record.brand ? { brand: record.brand } : {}),
    };
    if (record.variantProduct) {
      const members: CatalogProductVariantListItem[] = [];
      for (const member of record.variantProduct.members) {
        const resolved = await resolveCatalogVariantMember(storage.catalog, member.catalogItemId);
        if (!resolved?.member || !resolved.product) continue;
        const priceState = await storage.prices.getVersioned(member.catalogItemId);
        const memberPrice = await resolveCatalogItemPrice({ ...storage.prices, get: async () => priceState?.value ?? null }, member.catalogItemId);
        const memberManaged =
          resolved.item.stockManagement && normalizeStoredStockManagement(resolved.item.stockManagement).mode === "managed";
        const memberAvailability = memberManaged
          ? null
          : await loadCatalogItemManualAvailability(storage.availability, member.catalogItemId);
        members.push({
          catalogItemId: member.catalogItemId,
          selections: variantSelections(resolved.product, resolved.member),
          regular: memberPrice.regular ? formatClerkDollar(memberPrice.regular) : null,
          sale: memberPrice.sale ? formatClerkDollar(memberPrice.sale) : null,
          manageStock: memberManaged,
          stockStatus: memberAvailability ? toClerkStockStatus(memberAvailability.status) : null,
          fulfillment: member.fulfillment,
          priceRevision: priceState?.revision ?? null,
        });
      }
      product.variantProduct = {
        productId: record.variantProduct.productId,
        revision: record.variantProduct.revision,
        options: record.variantProduct.options,
        members,
      };
    }
    products.push(product);
  }
  products.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    return byName === 0 ? left.sku.localeCompare(right.sku) : byName;
  });
  return { products };
}

function invalidMessage(regular: ParsedClerkDollar, sale: ParsedClerkDollar): string | null {
  const parts: string[] = [];
  if (regular.status === "invalid") parts.push(`Regular: ${CLERK_DOLLAR_MESSAGE}`);
  if (sale.status === "invalid") parts.push(`Sale: ${CLERK_DOLLAR_MESSAGE}`);
  return parts.length === 0 ? null : parts.join(" ");
}

function refused(
  input: SaveCatalogProductPricesInput,
  message: string,
  manageStock: boolean,
  stockStatus: ClerkStockStatus | null,
): CatalogProductPriceForm {
  return {
    saved: false,
    regular: input.regular,
    sale: input.sale,
    manageStock,
    stockStatus,
    message,
  };
}

function displayForm(
  regular: Money | null,
  sale: Money | null,
  manageStock: boolean,
  stockStatus: ClerkStockStatus | null,
): CatalogProductPriceForm {
  return {
    saved: true,
    regular: regular === null ? "" : formatClerkDollar(regular),
    sale: sale === null ? "" : formatClerkDollar(sale),
    manageStock,
    stockStatus,
    message: null,
  };
}

function normalizeSaveInput(value: unknown): SaveCatalogProductPricesInput {
  if (!isRecord(value)) {
    catalogFail("INVALID_INPUT", "price save input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.catalogItemId !== "string" || input.catalogItemId.trim().length === 0) {
    catalogFail("INVALID_INPUT", "catalogItemId must be a non-empty string");
  }
  if (typeof input.regular !== "string" || typeof input.sale !== "string") {
    catalogFail("INVALID_INPUT", "price fields must be strings");
  }
  if (input.stockStatus !== undefined && typeof input.stockStatus !== "string") {
    catalogFail("INVALID_INPUT", "stock status must be a string");
  }
  if (input.manageStock !== undefined && typeof input.manageStock !== "boolean") {
    catalogFail("INVALID_INPUT", "manageStock must be a boolean");
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== null && typeof input.expectedRevision !== "string") {
    catalogFail("INVALID_INPUT", "invalid price revision");
  }
  return {
    catalogItemId: input.catalogItemId,
    regular: input.regular,
    sale: input.sale,
    manageStock: input.manageStock,
    stockStatus: input.stockStatus,
    expectedRevision: input.expectedRevision as string | null | undefined,
  };
}

export async function saveCatalogProductPrices(
  storage: SaveStorage,
  rawInput: unknown,
): Promise<CatalogProductPriceForm> {
  const input = normalizeSaveInput(rawInput);
  const catalogItemId = input.catalogItemId.trim();
  const item = await storage.catalog.get(catalogItemId);
  if (item === null || item.recordKind !== "catalog-item" || item.itemId !== catalogItemId) {
    catalogFail("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }

  const currentStockManagement = normalizeStoredStockManagement(item.stockManagement);
  const managed = currentStockManagement.mode === "managed";
  const nextManaged = input.manageStock ?? managed;
  const dormantAvailability = await loadCatalogItemManualAvailability(
    storage.availability,
    catalogItemId,
  );
  const dormantStockStatus = toClerkStockStatus(dormantAvailability.status);
  const currentStockStatus = managed ? null : dormantStockStatus;

  let nextStockStatus = nextManaged ? null : dormantStockStatus;
  if (
    !nextManaged &&
    currentStockManagement.mode === "managed" &&
    currentStockManagement.status === "setup-pending"
  ) {
    return refused(input, MANAGE_STOCK_SETUP_PENDING_MESSAGE, true, null);
  }
  if (nextManaged && managed && input.stockStatus !== undefined) {
    return refused(input, MANAGED_STOCK_STATUS_MESSAGE, true, null);
  }
  if (!nextManaged && input.stockStatus !== undefined) {
    if (!isClerkStockStatus(input.stockStatus)) {
      return refused(
        input,
        CLERK_STOCK_STATUS_MESSAGE,
        nextManaged,
        currentStockStatus,
      );
    }
    nextStockStatus = input.stockStatus;
  }

  const regular = parseClerkDollar(input.regular);
  const sale = parseClerkDollar(input.sale);
  const invalid = invalidMessage(regular, sale);
  if (invalid !== null) {
    return refused(input, invalid, nextManaged, currentStockStatus);
  }

  const targetRegular = regular.status === "amount" ? regular.amount : null;
  const targetSale = sale.status === "amount" ? sale.amount : null;
  const versioned = input.expectedRevision === undefined ? undefined : await storage.prices.getVersioned(catalogItemId);
  const current = await resolveCatalogItemPrice(versioned === undefined ? storage.prices : { ...storage.prices, get: async () => versioned?.value ?? null }, catalogItemId);
  if (versioned !== undefined && (versioned?.revision ?? null) !== input.expectedRevision) {
    catalogFail("COMMAND_CONFLICT", "Price changed; reload before saving");
  }
  const currentRegular = current.regular ?? null;
  const currentSale = current.sale ?? null;

  if (targetSale !== null && targetRegular === null) {
    return refused(
      input,
      currentSale !== null || currentRegular !== null
        ? CLERK_END_SALE_MESSAGE
        : CLERK_SALE_NEEDS_REGULAR_MESSAGE,
      nextManaged,
      currentStockStatus,
    );
  }
  if (
    targetSale !== null &&
    targetRegular !== null &&
    !saleIsStrictlyLower(targetSale, targetRegular)
  ) {
    return refused(input, CLERK_SALE_LOWER_MESSAGE, nextManaged, currentStockStatus);
  }
  const priceUnchanged =
    moneySame(currentRegular, targetRegular) && moneySame(currentSale, targetSale);
  const manageUnchanged = nextManaged === managed;
  const stockUnchanged = nextStockStatus === currentStockStatus;
  if (priceUnchanged && stockUnchanged && manageUnchanged && nextManaged) {
    return displayForm(targetRegular, targetSale, nextManaged, nextStockStatus);
  }

  let priceCommitted = false;
  let committedRevision: string | undefined;
  try {
    if (!priceUnchanged) {
      if (versioned !== undefined) {
        const record = catalogPriceRecord(catalogItemId, targetRegular!, targetSale);
        const applied = targetRegular === null
          ? await storage.prices.compareAndDelete(catalogItemId, versioned!.revision)
          : await storage.prices.compareAndSet(catalogItemId, versioned?.revision ?? null, record);
        if (!applied.applied) catalogFail("COMMAND_CONFLICT", "Price changed; reload before saving");
        if ("revision" in applied && typeof applied.revision === "string") committedRevision = applied.revision;
      } else await commitCatalogItemPrice(storage, {
        catalogItemId,
        regular: targetRegular,
        sale: targetSale,
      });
      priceCommitted = true;
    }
    if (!manageUnchanged) {
      await persistManageStock(storage, item, nextManaged);
    }
    if (!nextManaged && storage.releaseRegistrationClaims) {
      await catalogStorage(() => storage.releaseRegistrationClaims!(catalogItemId), "managed SKU registration claim release failed");
    }
    if (!nextManaged && nextStockStatus !== null && !stockUnchanged) {
      await setCatalogItemManualAvailability(
        { catalog: storage.catalog, availability: storage.availability },
        {
          catalogItemId,
          status: toStoredStockStatus(nextStockStatus),
        },
      );
    }
  } catch (error) {
    if (priceCommitted) {
      try {
        await restoreCommittedPrice(
          storage,
          catalogItemId,
          targetRegular,
          targetSale,
          currentRegular,
          currentSale,
          committedRevision,
        );
      } catch {
        // Keep the original stock-write error.
      }
    }
    throw error;
  }
  return displayForm(targetRegular, targetSale, nextManaged, nextStockStatus);
}

export interface BulkCatalogProductPriceInput {
  catalogItemId: string;
  regular: string;
  sale: string;
  expectedRevision: string | null;
}

export interface BulkCatalogProductPriceOutcome {
  catalogItemId: string;
  applied: boolean;
  code?: "INVALID_INPUT" | "CATALOG_ITEM_NOT_FOUND" | "CONFLICT" | "STORAGE_UNAVAILABLE";
  message?: string;
}

export async function bulkSaveCatalogProductPrices(
  storage: SaveStorage,
  inputs: readonly BulkCatalogProductPriceInput[],
): Promise<{ outcomes: BulkCatalogProductPriceOutcome[] }> {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) {
    catalogFail("INVALID_INPUT", "bulk price input needs 1-100 rows");
  }
  const outcomes: BulkCatalogProductPriceOutcome[] = [];
  for (const input of inputs) {
    try {
      if (!input || typeof input !== "object" || !Object.hasOwn(input, "expectedRevision")) {
        catalogFail("INVALID_INPUT", "each bulk row needs its loaded price revision");
      }
      if (!(await resolveCatalogVariantMember(storage.catalog, input.catalogItemId))?.member) {
        catalogFail("CATALOG_ITEM_NOT_FOUND", "catalog member is unavailable");
      }
      if (Object.keys(input).some(key => !["catalogItemId", "regular", "sale", "expectedRevision"].includes(key))) {
        catalogFail("INVALID_INPUT", "bulk edits accept price fields only");
      }
      const saved = await saveCatalogProductPrices(storage, input);
      if (!saved.saved) catalogFail("INVALID_INPUT", saved.message ?? "invalid price");
      outcomes.push({ catalogItemId: input.catalogItemId, applied: true });
    } catch (error) {
      const code = error instanceof CatalogError && ["INVALID_INPUT", "CATALOG_ITEM_NOT_FOUND"].includes(error.code)
        ? error.code as BulkCatalogProductPriceOutcome["code"]
        : error instanceof CatalogError && error.code === "COMMAND_CONFLICT"
          ? "CONFLICT"
          : "STORAGE_UNAVAILABLE";
      outcomes.push({ catalogItemId: input?.catalogItemId ?? "", applied: false, code, message: error instanceof Error ? error.message : "bulk price update failed" });
    }
  }
  return { outcomes };
}

async function persistManageStock(
  storage: SaveStorage,
  item: CatalogItemRecord,
  manageStock: boolean,
): Promise<void> {
  const current = normalizeStoredStockManagement(item.stockManagement);
  const nextStockManagement = setManageStock(current, manageStock);
  if (JSON.stringify(current) === JSON.stringify(nextStockManagement)) return;
  const latest = await catalogStorage(() => storage.catalog.getVersioned(item.itemId), "Manage Stock update failed");
  if (latest === null || latest.value.recordKind !== "catalog-item") {
    catalogFail("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  const latestState = normalizeStoredStockManagement(latest.value.stockManagement);
  if (
    !manageStock &&
    latestState.mode === "managed" &&
    latestState.status === "setup-pending"
  ) {
    catalogFail("MANAGE_STOCK_SETUP_PENDING", MANAGE_STOCK_SETUP_PENDING_MESSAGE,);
  }
  if (manageStock && latestState.mode === "managed") return;
  const nextItem: CatalogItemRecord = {
    ...latest.value,
    stockManagement: nextStockManagement,
  };
  const applied = await catalogStorage(() => storage.catalog.compareAndSet(
      item.itemId,
      latest.revision,
      nextItem,
    ), "Manage Stock update failed");
  if (!applied.applied) {
    catalogFail("STORAGE_UNAVAILABLE", "Manage Stock lost to concurrent write",);
  }
}

function moneySame(left: Money | null, right: Money | null): boolean {
  if (left === null || right === null) return left === right;
  return moneyEquals(left, right);
}

async function restoreCommittedPrice(
  storage: SaveStorage,
  catalogItemId: string,
  committedRegular: Money | null,
  committedSale: Money | null,
  previousRegular: Money | null,
  previousSale: Money | null,
  committedRevision?: string,
): Promise<void> {
  const latest = await storage.prices.getVersioned(catalogItemId);
  if (latest === null || (committedRevision !== undefined && latest.revision !== committedRevision)) return;
  if (
    !moneySame(latest.value.regular, committedRegular) ||
    !moneySame(latest.value.sale ?? null, committedSale)
  ) {
    return;
  }
  if (previousRegular === null) {
    await storage.prices.compareAndDelete(catalogItemId, latest.revision);
    return;
  }
  await storage.prices.compareAndSet(catalogItemId, latest.revision, catalogPriceRecord(catalogItemId, previousRegular, previousSale));
}
