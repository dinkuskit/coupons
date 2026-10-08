import { CatalogError } from "./errors.js";
import { normalizeCreateCatalogItemInput } from "./normalize.js";
import {
  assertCatalogStorageConstraints,
  identifyConfirmedUniqueViolation,
} from "./storage-constraints.js";
import type {
  CatalogItemRecord,
  CatalogCreationPayload,
  CatalogStorage,
  CreateCatalogItemResult,
  NormalizedCreateCatalogItemInput,
  CatalogVariantProduct,
} from "./types.js";
import {
  createInitialStockManagement,
  normalizeStoredStockManagement,
} from "../inventory-provider/index.js";

export interface CreateCatalogItemOptions {
  /** Trusted host collection name, never taken from clerk input. */
  collection?: string;
  /** Trusted installed plugin namespace, never taken from clerk input. */
  pluginId?: string;
  createId?: () => string;
  now?: () => Date;
  /** Internal member linkage must be durable before a parent commits membership. */
  variantMember?: {
    productId: string;
    selections: import("./types.js").CatalogVariantSelection[];
    fulfillment: import("./types.js").CatalogFulfillment;
  };
}

function sameCommandPayload(
  item: CatalogItemRecord,
  input: NormalizedCreateCatalogItemInput,
): boolean {
  const original = item.creationPayload ?? {
    kind: item.kind,
    name: item.name,
    sku: item.sku,
    skuKey: item.skuKey,
    manageStock: item.creationIntent?.manageStock ?? false,
  };
  return (
    item.commandId === input.commandId &&
    original.kind === input.kind &&
    original.name === input.name &&
    original.sku === input.sku &&
    original.skuKey === input.skuKey &&
    original.manageStock === input.creationIntent.manageStock &&
    original.fulfillment === input.fulfillment
  );
}

async function findCommand(
  storage: CatalogStorage,
  commandId: string,
): Promise<CatalogItemRecord | null> {
  let result;
  try {
    result = await storage.query({ where: { commandId }, limit: 2 });
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog command lookup failed", {
      cause: error,
    });
  }

  const items = result.items
    .map(({ data }) => data)
    .filter((record): record is CatalogItemRecord => record.recordKind === "catalog-item")
    .map((record) => ({
      ...record,
      creationIntent: record.creationIntent ?? { manageStock: false },
      stockManagement:
        record.stockManagement === undefined
          ? createInitialStockManagement(false)
          : normalizeStoredStockManagement(record.stockManagement),
    }));
  if (items.length > 1) {
    throw new CatalogError(
      "STORAGE_CONSTRAINTS_UNAVAILABLE",
      "catalog command uniqueness is not trustworthy",
    );
  }
  return items[0] ?? null;
}

function resolveExistingCommand(
  existing: CatalogItemRecord,
  input: NormalizedCreateCatalogItemInput,
  options: CreateCatalogItemOptions,
): CreateCatalogItemResult {
  if (JSON.stringify([existing.variantProductId, existing.variantSelections, existing.variantFulfillment]) !==
      JSON.stringify([options.variantMember?.productId, options.variantMember?.selections, options.variantMember?.fulfillment])) {
    throw new CatalogError("COMMAND_CONFLICT", "commandId belongs to another member");
  }
  if (!sameCommandPayload(existing, input)) {
    throw new CatalogError(
      "COMMAND_CONFLICT",
      "commandId was already used with different catalog input",
    );
  }
  return { created: false, item: existing };
}

export async function createCatalogItem(
  storage: CatalogStorage,
  rawInput: unknown,
  options: CreateCatalogItemOptions = {},
): Promise<CreateCatalogItemResult> {
  const input = normalizeCreateCatalogItemInput(rawInput);
  await assertCatalogStorageConstraints(storage, options.collection, options.pluginId);

  const existing = await findCommand(storage, input.commandId);
  if (existing) return resolveExistingCommand(existing, input, options);

  const item: CatalogItemRecord = {
    recordKind: "catalog-item",
    itemId: (options.createId ?? (() => globalThis.crypto.randomUUID()))(),
    ...input,
    state: "draft",
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.variantMember ? {
      variantProductId: options.variantMember.productId,
      variantSelections: options.variantMember.selections,
      variantFulfillment: options.variantMember.fulfillment,
    } : {}),
    creationPayload: {
      kind: input.kind,
      name: input.name,
      sku: input.sku,
      skuKey: input.skuKey,
      manageStock: input.creationIntent.manageStock,
      ...(input.fulfillment === undefined ? {} : { fulfillment: input.fulfillment }),
    } satisfies CatalogCreationPayload,
  };
  if (input.fulfillment !== undefined && !options.variantMember) {
    item.variantProduct = {
      creationPayload: JSON.stringify({
        commandId: input.commandId,
        fulfillment: input.fulfillment,
        kind: input.kind,
        name: input.name,
        sku: input.sku,
        skuKey: input.skuKey,
      }),
      schema: "dinkuskit.commerce.product-variants/v1",
      productId: item.itemId,
      revision: 0,
      defaultMemberId: item.itemId,
      options: [],
      members: [{
        catalogItemId: item.itemId,
        selections: [],
        fulfillment: input.fulfillment,
      }],
    } satisfies CatalogVariantProduct;
  }

  try {
    await storage.put(item.itemId, item);
    return { created: true, item };
  } catch (error) {
    const uniqueField = identifyConfirmedUniqueViolation(error, options.collection, options.pluginId);
    if (!uniqueField) {
      throw new CatalogError("STORAGE_UNAVAILABLE", "catalog item creation failed", {
        cause: error,
      });
    }

    const concurrentCommand = await findCommand(storage, input.commandId);
    if (concurrentCommand) return resolveExistingCommand(concurrentCommand, input, options);
    if (uniqueField === "skuKey") {
      throw new CatalogError("SKU_CONFLICT", "sku is already assigned to another catalog item");
    }
    throw new CatalogError(
      "STORAGE_CONSTRAINTS_UNAVAILABLE",
      "catalog command conflict could not be resolved",
      { cause: error },
    );
  }
}
