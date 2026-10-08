import type { StorageCollection } from "emdash";

import type {
  CatalogItemRecord,
  CatalogStorageRecord,
} from "../catalog/kernel/index.js";
import type {
  InventoryProviderBinding,
  InventoryProviderPort,
  ManagedSkuRegistrationClaimRecord,
} from "../inventory-provider/index.js";

export const INVENTORY_SETUP_FEATURE_ID = "dinkus.inventory-setup";
export const STORE_INVENTORY_CONFIGURATIONS_COLLECTION =
  "storeInventoryConfigurations";
export const STORE_INVENTORY_CONFIGURATION_UNIQUE_INDEXES = [
  "configurationKey",
] as const;

export interface StoreInventoryConfigurationRecord {
  recordKind: "store-inventory-configuration";
  recordId: string;
  configurationKey: "active";
  siteId: string;
  binding: InventoryProviderBinding;
  configuredAt: string;
  updatedAt: string;
}

export interface StoreInventoryConfigurationProbeRecord {
  recordKind: "store-inventory-configuration-probe";
  recordId: string;
  configurationKey: string;
  siteId: string;
  binding: InventoryProviderBinding;
  configuredAt: string;
  updatedAt: string;
}

export type StoreInventoryConfigurationStorageRecord =
  | StoreInventoryConfigurationRecord
  | StoreInventoryConfigurationProbeRecord;

export type StoreInventoryConfigurationStorage = Pick<
  StorageCollection<StoreInventoryConfigurationStorageRecord>,
  "delete" | "put" | "query"
>;

export type ConfigureInventoryCatalogStorage = Pick<
  StorageCollection<CatalogStorageRecord>,
  "compareAndSet" | "get" | "getVersioned" | "put"
>;

export type ConfigureInventoryClaimStorage = Pick<
  StorageCollection<ManagedSkuRegistrationClaimRecord>,
  "delete" | "put" | "query"
>;

export interface InventorySetupStorage {
  catalog: ConfigureInventoryCatalogStorage;
  configurations: StoreInventoryConfigurationStorage;
  claims: ConfigureInventoryClaimStorage;
}

export interface CreateStoreInventoryConfigurationOptions {
  createRecordId?: () => string;
  createSiteId?: () => string;
  now?: () => Date;
}

export type CreateStoreInventoryConfigurationResult = {
  configuration: StoreInventoryConfigurationRecord;
  outcome: "created" | "existing" | "location-updated" | "migration-required";
};

export interface ConfigureInventoryExecution {
  createClaimRecordId?: () => string;
  createOperationId?: () => string;
  now?: () => Date;
  resolveProvider?: (
    configuration: StoreInventoryConfigurationRecord,
  ) => Promise<InventoryProviderPort | null | undefined>;
}

export type ConfigureCatalogItemInventoryResult =
  | {
      outcome: "inventory-setup-required";
      catalogItemId: string;
      actionLabel: "Configure Inventory";
    }
  | {
      outcome:
        | "registration-pending"
        | "registration-needs-attention"
        | "existing-sku-review-required"
        | "inventory-active";
      poolId: string;
      item: CatalogItemRecord;
      concurrent?: boolean;
      sameRequest?: boolean;
    };
