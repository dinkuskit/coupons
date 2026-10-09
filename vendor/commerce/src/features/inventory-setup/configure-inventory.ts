import type {
  CatalogItemRecord,
  CatalogStorageRecord,
} from "../catalog/kernel/index.js";
import {
  createManagedSkuRegistrationClaimKey,
  createManagedSkuRegistrationClaimPort,
  normalizeStoredStockManagement,
  startManagedSkuRegistration,
  type ManagedStockManagement,
} from "../inventory-provider/index.js";
import { InventorySetupError } from "./errors.js";
import { loadStoreInventoryConfiguration } from "./store-configuration.js";
import type {
  ConfigureCatalogItemInventoryResult,
  ConfigureInventoryExecution,
  InventorySetupStorage,
  StoreInventoryConfigurationRecord,
} from "./types.js";

interface ConfigureInventoryInput {
  catalogItemId: string;
}

function normalizeInput(value: unknown): ConfigureInventoryInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InventorySetupError(
      "INVALID_INPUT",
      "Configure Inventory input must be an object",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "catalogItemId") ||
    typeof input.catalogItemId !== "string" ||
    input.catalogItemId.trim().length === 0
  ) {
    throw new InventorySetupError(
      "INVALID_INPUT",
      "Configure Inventory accepts only catalogItemId",
    );
  }
  return { catalogItemId: input.catalogItemId.trim() };
}

async function loadCatalogItem(
  storage: InventorySetupStorage["catalog"],
  catalogItemId: string,
): Promise<CatalogItemRecord> {
  let stored: CatalogStorageRecord | null;
  try {
    stored = await storage.get(catalogItemId);
  } catch (error) {
    throw new InventorySetupError(
      "STORAGE_UNAVAILABLE",
      "catalog item lookup failed",
      { cause: error },
    );
  }
  if (stored === null || stored.recordKind !== "catalog-item") {
    throw new InventorySetupError(
      "CATALOG_ITEM_NOT_FOUND",
      "catalog item was not found",
    );
  }
  if (stored.itemId !== catalogItemId) {
    throw new InventorySetupError(
      "STORAGE_UNAVAILABLE",
      "stored catalog item identity does not match its key",
    );
  }
  return {
    ...stored,
    creationIntent: stored.creationIntent ?? { manageStock: false },
    stockManagement: normalizeStoredStockManagement(stored.stockManagement),
  };
}

function currentResult(
  item: CatalogItemRecord,
  configuration: StoreInventoryConfigurationRecord,
): ConfigureCatalogItemInventoryResult | null {
  const state = item.stockManagement;
  if (state.mode !== "managed") return null;
  if (state.status === "setup-pending") {
    return { outcome: "registration-pending", poolId: configuration.binding.poolId, item };
  }
  if (state.status === "needs-review") {
    return {
      outcome: "existing-sku-review-required",
      poolId: configuration.binding.poolId,
      item,
    };
  }
  if (state.status === "active") {
    return { outcome: "inventory-active", poolId: configuration.binding.poolId, item };
  }
  return null;
}

async function persistManagedCatalogState(
  storage: InventorySetupStorage["catalog"],
  catalogItemId: string,
  stockManagement: ManagedStockManagement,
): Promise<CatalogItemRecord> {
  let latest;
  try {
    latest = await storage.getVersioned(catalogItemId);
  } catch (error) {
    throw new InventorySetupError(
      "STORAGE_UNAVAILABLE",
      "catalog inventory state update failed",
      { cause: error },
    );
  }
  if (latest === null || latest.value.recordKind !== "catalog-item") {
    throw new InventorySetupError(
      "CATALOG_ITEM_NOT_FOUND",
      "catalog item was not found",
    );
  }
  if (normalizeStoredStockManagement(latest.value.stockManagement).mode !== "managed") {
    throw new InventorySetupError(
      "MANAGE_STOCK_REQUIRED",
      "Manage Stock was disabled before Inventory setup finished",
    );
  }
  const next: CatalogItemRecord = {
    ...latest.value,
    stockManagement,
  };
  let applied;
  try {
    applied = await storage.compareAndSet(catalogItemId, latest.revision, next);
  } catch (error) {
    throw new InventorySetupError(
      "STORAGE_UNAVAILABLE",
      "catalog inventory state update failed",
      { cause: error },
    );
  }
  if (!applied.applied) {
    throw new InventorySetupError(
      "STORAGE_UNAVAILABLE",
      "catalog inventory state update lost to a concurrent write",
    );
  }
  return next;
}

function outcomeForState(state: ManagedStockManagement) {
  if (state.status === "active") return "inventory-active" as const;
  if (state.status === "needs-review") return "existing-sku-review-required" as const;
  if (state.status === "setup-needs-attention") {
    return "registration-needs-attention" as const;
  }
  return "registration-pending" as const;
}

async function resolveProvider(
  configuration: StoreInventoryConfigurationRecord,
  execution: ConfigureInventoryExecution,
) {
  if (typeof execution.resolveProvider !== "function") {
    throw new InventorySetupError(
      "PROVIDER_UNAVAILABLE",
      "configured Inventory provider is not installed in this runtime",
    );
  }
  try {
    const provider = await execution.resolveProvider(configuration);
    if (!provider) {
      throw new InventorySetupError(
        "PROVIDER_UNAVAILABLE",
        "configured Inventory provider is not installed in this runtime",
      );
    }
    return provider;
  } catch (error) {
    if (error instanceof InventorySetupError) throw error;
    throw new InventorySetupError(
      "PROVIDER_UNAVAILABLE",
      "configured Inventory provider could not be resolved",
      { cause: error },
    );
  }
}

export async function configureCatalogItemInventory(
  storage: InventorySetupStorage,
  rawInput: unknown,
  execution: ConfigureInventoryExecution = {},
): Promise<ConfigureCatalogItemInventoryResult> {
  const input = normalizeInput(rawInput);
  const item = await loadCatalogItem(storage.catalog, input.catalogItemId);
  if (item.stockManagement.mode !== "managed") {
    throw new InventorySetupError(
      "MANAGE_STOCK_REQUIRED",
      "Manage Stock must be enabled before configuring Inventory",
    );
  }

  const configuration = await loadStoreInventoryConfiguration(storage.configurations);
  if (!configuration) {
    return {
      outcome: "inventory-setup-required",
      catalogItemId: input.catalogItemId,
      actionLabel: "Configure Inventory",
    };
  }

  const existing = currentResult(item, configuration);
  if (existing) return existing;

  const provider = await resolveProvider(configuration, execution);
  const claimPort = createManagedSkuRegistrationClaimPort(storage.claims, {
    createRecordId: execution.createClaimRecordId,
    now: execution.now,
  });
  let persistedItem = item;
  const rejectedOperationId =
    item.stockManagement.status === "setup-needs-attention"
      ? item.stockManagement.registration.operationId
      : undefined;
  const started = await startManagedSkuRegistration(
    item.stockManagement,
    configuration.binding,
    { sku: item.sku, productTitle: item.name },
    {
      provider,
      catalogItemId: item.itemId,
      claimKey: createManagedSkuRegistrationClaimKey({
        catalogItemId: item.itemId,
        rejectedOperationId,
      }),
      claim: claimPort.claim,
      createOperationId: execution.createOperationId,
      persist: async (stockManagement) => {
        persistedItem = await persistManagedCatalogState(
          storage.catalog,
          item.itemId,
          stockManagement,
        );
      },
    },
  );

  if (started.outcome === "already-claimed") {
    return {
      outcome: "registration-pending",
      poolId: configuration.binding.poolId,
      item: { ...item, stockManagement: started.state },
      concurrent: true,
      sameRequest: started.sameRequest,
    };
  }

  return {
    outcome: outcomeForState(started.state),
    poolId: configuration.binding.poolId,
    item: persistedItem,
  };
}
