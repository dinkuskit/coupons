import type { StorageCollection } from "emdash";

import type {
  CatalogManualAvailabilityStorage,
  CatalogBackorderPolicyStorage,
  CatalogPriceStorage,
  CatalogStorageRecord,
} from "../catalog/kernel/index.js";
import type {
  StoreInventoryConfigurationRecord,
  StoreInventoryConfigurationStorage,
} from "../inventory-setup/kernel/index.js";

export const STOREFRONT_AVAILABILITY_FEATURE_ID =
  "dinkus.storefront-availability";
export const STOREFRONT_AVAILABILITY_RESULT_SCHEMA =
  "dinkuskit.commerce.storefront-availability-result/v1" as const;
export const INVENTORY_SKU_STOCK_READ_RESULT_SCHEMA =
  "dinkuskit.inventory.sku-stock-read-result/v1" as const;
export const STOREFRONT_AVAILABILITY_SETTINGS_COLLECTION =
  "storefrontAvailabilitySettings";
export const STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID = "active";
export const STOREFRONT_OUT_OF_STOCK_LISTING_COLLECTION =
  "storefrontOutOfStockListing";
export const STOREFRONT_OUT_OF_STOCK_LISTING_RECORD_ID = "active";
export const DEFAULT_HIDE_OUT_OF_STOCK = false;

export type StorefrontAvailabilityDisplayPolicy =
  | { mode: "status" }
  | { mode: "exact" }
  | { mode: "threshold"; threshold: number };

export interface StorefrontAvailabilitySettingsRecord {
  recordKind: "storefront-availability-settings";
  recordId: typeof STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID;
  policy: StorefrontAvailabilityDisplayPolicy;
  updatedAt: string;
}

export type StorefrontAvailabilitySettingsStorage = Pick<
  StorageCollection<StorefrontAvailabilitySettingsRecord>,
  "get" | "put"
>;

export interface SetStorefrontAvailabilityPolicyOptions {
  now?: () => Date;
}

export interface SetStorefrontAvailabilityPolicyResult {
  changed: boolean;
  settings: StorefrontAvailabilitySettingsRecord;
}

export interface StorefrontOutOfStockListingRecord {
  recordKind: "storefront-out-of-stock-listing";
  recordId: typeof STOREFRONT_OUT_OF_STOCK_LISTING_RECORD_ID;
  hideOutOfStock: boolean;
  updatedAt: string;
}

export type StorefrontOutOfStockListingStorage = Pick<
  StorageCollection<StorefrontOutOfStockListingRecord>,
  "get" | "put"
>;

export interface SetOutOfStockListingOptions {
  now?: () => Date;
}

export interface SetOutOfStockListingResult {
  changed: boolean;
  listing: StorefrontOutOfStockListingRecord;
}

export interface ExactQuantity {
  value: string;
  unit: string;
}

export interface InventorySkuStockReadInput {
  poolId: string;
  skuId: string;
  scope: {
    kind: "location";
    locationId: string;
  };
}

export interface InventoryStockQuantities {
  onHand: ExactQuantity;
  reserved: ExactQuantity;
  outgoingTransferCommitted: ExactQuantity;
  available: ExactQuantity;
  expected: ExactQuantity;
  inTransit: ExactQuantity;
}

export interface InventorySkuStockLocation {
  locationId: string;
  name: string;
  stock: InventoryStockQuantities;
}

export type InventorySkuStockReadResult =
  | {
      schema: typeof INVENTORY_SKU_STOCK_READ_RESULT_SCHEMA;
      outcome: "found";
      poolId: string;
      skuId: string;
      scope: InventorySkuStockReadInput["scope"];
      stock: InventoryStockQuantities;
      locations: readonly InventorySkuStockLocation[];
    }
  | {
      schema: typeof INVENTORY_SKU_STOCK_READ_RESULT_SCHEMA;
      outcome: "not_found";
      poolId: string;
      skuId: string;
      scope: InventorySkuStockReadInput["scope"];
    };

export interface InventoryAvailabilityProviderPort {
  readSkuStock(
    input: InventorySkuStockReadInput,
  ): Promise<InventorySkuStockReadResult>;
}

export interface StorefrontAvailabilityStorage {
  backorderPolicies: CatalogBackorderPolicyStorage;
  catalog: Pick<StorageCollection<CatalogStorageRecord>, "get">;
  configurations: StoreInventoryConfigurationStorage;
  listing?: StorefrontOutOfStockListingStorage;
  prices: CatalogPriceStorage;
  settings: StorefrontAvailabilitySettingsStorage;
}

export interface StorefrontAvailabilityResolverStorage
  extends StorefrontAvailabilityStorage {
  manualAvailability: CatalogManualAvailabilityStorage;
}

export interface ResolveManagedStorefrontAvailabilityInput {
  catalogItemId: string;
}

export interface ResolveManagedStorefrontAvailabilityExecution {
  resolveProvider: (
    configuration: StoreInventoryConfigurationRecord,
  ) => Promise<InventoryAvailabilityProviderPort | null | undefined>;
}

export interface ResolveStorefrontAvailabilityExecution {
  resolveProvider?: ResolveManagedStorefrontAvailabilityExecution["resolveProvider"];
}

export type StorefrontAvailabilityStatus =
  | "in-stock"
  | "low-stock"
  | "out-of-stock"
  | "available-on-backorder"
  | "availability-unavailable";

export type StorefrontAvailabilityResult = {
  schema: typeof STOREFRONT_AVAILABILITY_RESULT_SCHEMA;
  catalogItemId: string;
  status: StorefrontAvailabilityStatus;
  sellable: boolean;
  listable: boolean;
  displayQuantity?: ExactQuantity;
};
