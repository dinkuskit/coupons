import {
  loadCatalogItemManualAvailability,
  loadCatalogItemBackorderPolicy,
  resolveCatalogItemPrice,
  type CatalogItemRecord,
  type CatalogStorageRecord,
} from "../catalog/kernel/index.js";
import { normalizeStoredStockManagement } from "../inventory-provider/index.js";
import { loadStoreInventoryConfiguration } from "../inventory-setup/kernel/index.js";
import { StorefrontAvailabilityError } from "./errors.js";
import {
  exactQuantitySign,
  normalizeExactQuantity,
  positiveQuantityAtOrBelowInteger,
} from "./quantity.js";
import { loadOutOfStockListing } from "./listing.js";
import { loadStorefrontAvailabilityPolicy } from "./settings.js";
import {
  INVENTORY_SKU_STOCK_READ_RESULT_SCHEMA,
  STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
  type ExactQuantity,
  type InventorySkuStockReadInput,
  type InventoryStockQuantities,
  type ResolveManagedStorefrontAvailabilityExecution,
  type ResolveManagedStorefrontAvailabilityInput,
  type ResolveStorefrontAvailabilityExecution,
  type StorefrontAvailabilityResult,
  type StorefrontAvailabilityDisplayPolicy,
  type StorefrontAvailabilityStorage,
  type StorefrontAvailabilityResolverStorage,
} from "./types.js";

type ManagedCatalogItemRecord = Omit<CatalogItemRecord, "stockManagement"> & {
  stockManagement: Extract<
    CatalogItemRecord["stockManagement"],
    { mode: "managed" }
  >;
};

function normalizeInput(value: unknown): ResolveManagedStorefrontAvailabilityInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorefrontAvailabilityError(
      "INVALID_INPUT",
      "storefront availability input must be an object",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    typeof input.catalogItemId !== "string" ||
    input.catalogItemId.trim().length === 0
  ) {
    throw new StorefrontAvailabilityError(
      "INVALID_INPUT",
      "storefront availability accepts only catalogItemId",
    );
  }
  return { catalogItemId: input.catalogItemId.trim() };
}

function unavailable(
  catalogItemId: string,
  listable = true,
): StorefrontAvailabilityResult {
  return {
    schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
    catalogItemId,
    status: "availability-unavailable",
    sellable: false,
    listable,
  };
}

function withListable(
  result: Omit<StorefrontAvailabilityResult, "listable">,
): StorefrontAvailabilityResult {
  return { ...result, listable: true };
}

async function hideOutOfStockEnabled(
  storage: StorefrontAvailabilityStorage,
): Promise<boolean> {
  if (!storage.listing) return false;
  return (await loadOutOfStockListing(storage.listing)).hideOutOfStock;
}

async function applyOutOfStockListing(
  storage: StorefrontAvailabilityStorage,
  result: StorefrontAvailabilityResult,
): Promise<StorefrontAvailabilityResult> {
  if (result.status !== "out-of-stock" || !result.listable) return result;
  let hide: boolean;
  try {
    hide = await hideOutOfStockEnabled(storage);
  } catch {
    return { ...result, listable: false };
  }
  if (!hide) return result;
  return { ...result, listable: false };
}

function normalizeCatalogItem(
  stored: CatalogStorageRecord | null,
  catalogItemId: string,
): CatalogItemRecord | null {
  if (stored === null || stored.recordKind !== "catalog-item") return null;
  if (stored.itemId !== catalogItemId) return null;
  return {
    ...stored,
    creationIntent: stored.creationIntent ?? { manageStock: false },
    stockManagement: normalizeStoredStockManagement(stored.stockManagement),
  };
}

function isManagedCatalogItem(
  item: CatalogItemRecord,
): item is ManagedCatalogItemRecord {
  return item.stockManagement.mode === "managed";
}

async function loadCatalogItemForAvailability(
  storage: StorefrontAvailabilityStorage["catalog"],
  catalogItemId: string,
): Promise<CatalogItemRecord | null> {
  let stored: CatalogStorageRecord | null;
  try {
    stored = await storage.get(catalogItemId);
  } catch {
    return null;
  }
  if (stored === null || stored.recordKind !== "catalog-item") {
    throw new StorefrontAvailabilityError(
      "CATALOG_ITEM_NOT_FOUND",
      "catalog item was not found",
    );
  }
  return normalizeCatalogItem(stored, catalogItemId);
}

function sameScope(
  value: unknown,
  expected: InventorySkuStockReadInput["scope"],
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    scope.kind === "location" &&
    scope.locationId === expected.locationId &&
    Object.keys(scope).length === 2
  );
}

function foundAvailableQuantity(
  value: unknown,
  expected: InventorySkuStockReadInput,
): ExactQuantity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    result.schema !== INVENTORY_SKU_STOCK_READ_RESULT_SCHEMA ||
    result.outcome !== "found" ||
    result.poolId !== expected.poolId ||
    result.skuId !== expected.skuId ||
    !sameScope(result.scope, expected.scope)
  ) {
    return null;
  }
  const stock = normalizeStockQuantities(result.stock);
  if (!stock || !Array.isArray(result.locations) || result.locations.length !== 1) {
    return null;
  }
  const [location] = result.locations;
  if (typeof location !== "object" || location === null || Array.isArray(location)) {
    return null;
  }
  const locationRecord = location as Record<string, unknown>;
  const locationStock = normalizeStockQuantities(locationRecord.stock);
  if (
    locationRecord.locationId !== expected.scope.locationId ||
    typeof locationRecord.name !== "string" ||
    locationRecord.name.trim().length === 0 ||
    !locationStock ||
    !sameStock(stock, locationStock)
  ) {
    return null;
  }
  return stock.available;
}

const STOCK_QUANTITY_FIELDS = [
  "onHand",
  "reserved",
  "outgoingTransferCommitted",
  "available",
  "expected",
  "inTransit",
] as const satisfies readonly (keyof InventoryStockQuantities)[];

function normalizeStockQuantities(value: unknown): InventoryStockQuantities | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const quantities = Object.fromEntries(
    STOCK_QUANTITY_FIELDS.map((field) => [field, normalizeExactQuantity(source[field])]),
  ) as Record<(typeof STOCK_QUANTITY_FIELDS)[number], ExactQuantity | null>;
  if (STOCK_QUANTITY_FIELDS.some((field) => quantities[field] === null)) return null;
  const normalized = quantities as InventoryStockQuantities;
  if (STOCK_QUANTITY_FIELDS.some((field) => normalized[field].unit !== normalized.onHand.unit)) {
    return null;
  }
  return normalized;
}

function sameStock(
  left: InventoryStockQuantities,
  right: InventoryStockQuantities,
): boolean {
  return STOCK_QUANTITY_FIELDS.every(
    (field) =>
      left[field].value === right[field].value &&
      left[field].unit === right[field].unit,
  );
}

function availableResult(
  item: CatalogItemRecord,
  allowBackorders: boolean,
  quantity: ExactQuantity,
  policy: StorefrontAvailabilityDisplayPolicy,
): StorefrontAvailabilityResult {
  if (exactQuantitySign(quantity.value) !== 1) {
    return withListable({
      schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
      catalogItemId: item.itemId,
      status: allowBackorders ? "available-on-backorder" : "out-of-stock",
      sellable: allowBackorders,
    });
  }
  if (policy.mode === "exact") {
    return withListable({
      schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
      catalogItemId: item.itemId,
      status: "in-stock",
      sellable: true,
      displayQuantity: quantity,
    });
  }
  if (
    policy.mode === "threshold" &&
    positiveQuantityAtOrBelowInteger(quantity.value, policy.threshold)
  ) {
    return withListable({
      schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
      catalogItemId: item.itemId,
      status: "low-stock",
      sellable: true,
      displayQuantity: quantity,
    });
  }
  return withListable({
    schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
    catalogItemId: item.itemId,
    status: "in-stock",
    sellable: true,
  });
}

function manualResult(
  catalogItemId: string,
  status: "in-stock" | "out-of-stock" | "available-on-backorder",
): StorefrontAvailabilityResult {
  return withListable({
    schema: STOREFRONT_AVAILABILITY_RESULT_SCHEMA,
    catalogItemId,
    status,
    sellable: status !== "out-of-stock",
  });
}

async function resolveManagedItem(
  storage: StorefrontAvailabilityStorage,
  item: ManagedCatalogItemRecord,
  execution: ResolveStorefrontAvailabilityExecution,
): Promise<StorefrontAvailabilityResult> {
  if (item.stockManagement.status !== "active") return unavailable(item.itemId);

  let configuration;
  let displayPolicy;
  let backorderPolicy;
  try {
    [configuration, displayPolicy, backorderPolicy] = await Promise.all([
      loadStoreInventoryConfiguration(storage.configurations),
      loadStorefrontAvailabilityPolicy(storage.settings),
      loadCatalogItemBackorderPolicy(storage.backorderPolicies, item.itemId),
    ]);
  } catch {
    return unavailable(item.itemId);
  }
  if (!configuration || typeof execution.resolveProvider !== "function") {
    return unavailable(item.itemId);
  }

  const readInput: InventorySkuStockReadInput = {
    poolId: configuration.binding.poolId,
    skuId: item.stockManagement.inventorySkuId,
    scope: {
      kind: "location",
      locationId: configuration.binding.defaultFulfillmentLocationId,
    },
  };
  try {
    const provider = await execution.resolveProvider(configuration);
    if (!provider || typeof provider.readSkuStock !== "function") {
      return unavailable(item.itemId);
    }
    const result = await provider.readSkuStock(readInput);
    const quantity = foundAvailableQuantity(result, readInput);
    if (!quantity) return unavailable(item.itemId);
    return availableResult(
      item,
      backorderPolicy.allowBackorders,
      quantity,
      displayPolicy,
    );
  } catch {
    return unavailable(item.itemId);
  }
}

async function unlistIfUnpriced(
  storage: StorefrontAvailabilityStorage,
  catalogItemId: string,
): Promise<StorefrontAvailabilityResult | null> {
  try {
    const price = await resolveCatalogItemPrice(storage.prices, catalogItemId);
    if (!price.listable) return unavailable(catalogItemId, false);
    return null;
  } catch {
    return unavailable(catalogItemId, false);
  }
}

export async function resolveManagedStorefrontAvailability(
  storage: StorefrontAvailabilityStorage,
  rawInput: unknown,
  execution: ResolveManagedStorefrontAvailabilityExecution,
): Promise<StorefrontAvailabilityResult> {
  const input = normalizeInput(rawInput);
  const item = await loadCatalogItemForAvailability(
    storage.catalog,
    input.catalogItemId,
  );
  if (!item) return unavailable(input.catalogItemId);
  if (!isManagedCatalogItem(item)) {
    throw new StorefrontAvailabilityError(
      "MANAGE_STOCK_REQUIRED",
      "catalog item does not use managed stock",
    );
  }
  const unlisted = await unlistIfUnpriced(storage, item.itemId);
  if (unlisted) return unlisted;
  return applyOutOfStockListing(
    storage,
    await resolveManagedItem(storage, item, execution),
  );
}

export async function resolveStorefrontAvailability(
  storage: StorefrontAvailabilityResolverStorage,
  rawInput: unknown,
  execution: ResolveStorefrontAvailabilityExecution = {},
): Promise<StorefrontAvailabilityResult> {
  const input = normalizeInput(rawInput);
  const item = await loadCatalogItemForAvailability(
    storage.catalog,
    input.catalogItemId,
  );
  if (!item) return unavailable(input.catalogItemId);
  const unlisted = await unlistIfUnpriced(storage, item.itemId);
  if (unlisted) return unlisted;
  if (isManagedCatalogItem(item)) {
    return applyOutOfStockListing(
      storage,
      await resolveManagedItem(storage, item, execution),
    );
  }

  try {
    const availability = await loadCatalogItemManualAvailability(
      storage.manualAvailability,
      item.itemId,
    );
    return applyOutOfStockListing(
      storage,
      manualResult(item.itemId, availability.status),
    );
  } catch {
    return unavailable(item.itemId);
  }
}
