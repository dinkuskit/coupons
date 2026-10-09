import type { StorageCollection } from "emdash";

import type { StockManagement } from "../inventory-provider/index.js";

export const CATALOG_FEATURE_ID = "dinkus.catalog";
export const CATALOG_COLLECTION = "catalogItems";
export const CATALOG_BACKORDER_POLICIES_COLLECTION = "catalogBackorderPolicies";
export const CATALOG_MANUAL_AVAILABILITY_COLLECTION =
  "catalogManualAvailability";
export const CATALOG_PRICES_COLLECTION = "catalogPrices";
export const COMMERCE_CURRENCY_USD = "USD" as const;
export const DEFAULT_CATALOG_MANUAL_AVAILABILITY = "in-stock" as const;
export const CATALOG_VARIANT_SCHEMA =
  "dinkuskit.commerce.product-variants/v1" as const;
// EmDash mounts plugin IDs as one URL segment and uses them in storage-index
// provisioning. Keep the scoped npm package identity separate from this
// runtime slug so both the HTTP route and declared unique indexes materialize.
export const COMMERCE_PLUGIN_ID = "dinkus-commerce";

export const CATALOG_UNIQUE_INDEXES = ["commandId", "skuKey"] as const;

export interface CreateCatalogItemInput {
  commandId: string;
  manageStock?: boolean;
  fulfillment?: CatalogFulfillment;
  name: string;
  sku: string;
}

export interface NormalizedCreateCatalogItemInput {
  commandId: string;
  creationIntent: {
    manageStock: boolean;
  };
  kind: "simple-product";
  name: string;
  sku: string;
  skuKey: string;
  stockManagement: StockManagement;
  fulfillment?: CatalogFulfillment;
}

export interface CatalogCreationPayload {
  kind: "simple-product";
  name: string;
  sku: string;
  skuKey: string;
  manageStock: boolean;
  fulfillment?: CatalogFulfillment;
}

export interface CatalogItemRecord extends NormalizedCreateCatalogItemInput {
  recordKind: "catalog-item";
  itemId: string;
  state: "draft";
  createdAt: string;
  creationPayload?: CatalogCreationPayload;
  variantProduct?: CatalogVariantProduct;
  variantProductId?: string;
  variantSelections?: readonly CatalogVariantSelection[];
  variantFulfillment?: CatalogFulfillment;
}

export type CatalogFulfillment = "physical" | "digital";

export interface CatalogVariantSelection {
  optionId: string;
  valueId: string;
}

export interface CatalogVariantOptionValue {
  valueId: string;
  label: string;
}

export interface CatalogVariantOption {
  optionId: string;
  label: string;
  values: readonly CatalogVariantOptionValue[];
}

export interface CatalogVariantMember {
  catalogItemId: string;
  selections: readonly CatalogVariantSelection[];
  fulfillment: CatalogFulfillment;
}

export interface CatalogVariantProduct {
  /** Immutable first membership intent, distinct from later labels. */
  creationPayload?: string;
  schema: typeof CATALOG_VARIANT_SCHEMA;
  productId: string;
  revision: number;
  defaultMemberId: string;
  options: readonly CatalogVariantOption[];
  members: readonly CatalogVariantMember[];
}

export interface CatalogIntegrityProbeRecord {
  recordKind: "integrity-probe";
  itemId: string;
  commandId: string;
  kind: "integrity-probe";
  name: string;
  sku: string;
  skuKey: string;
  state: "internal";
  createdAt: string;
}

export type CatalogStorageRecord = CatalogItemRecord | CatalogIntegrityProbeRecord;

export type CatalogStorage = Pick<
  StorageCollection<CatalogStorageRecord>,
  "delete" | "put" | "query"
>;

export type CatalogItemReadStorage = Pick<
  StorageCollection<CatalogStorageRecord>,
  "get"
>;

export interface CatalogBackorderPolicyRecord {
  recordKind: "catalog-backorder-policy";
  recordId: string;
  catalogItemId: string;
  allowBackorders: boolean;
}

export type CatalogBackorderPolicyStorage = Pick<
  StorageCollection<CatalogBackorderPolicyRecord>,
  "get" | "put"
>;

export interface SetCatalogItemBackordersStorage {
  catalog: CatalogItemReadStorage;
  policies: CatalogBackorderPolicyStorage;
}

export interface SetCatalogItemBackordersInput {
  catalogItemId: string;
  allowBackorders: boolean;
}

export interface SetCatalogItemBackordersResult {
  changed: boolean;
  policy: CatalogBackorderPolicyRecord;
}

export type CatalogManualAvailabilityStatus =
  | "in-stock"
  | "out-of-stock"
  | "available-on-backorder";

export interface CatalogManualAvailabilityRecord {
  recordKind: "catalog-manual-availability";
  recordId: string;
  catalogItemId: string;
  status: CatalogManualAvailabilityStatus;
}

export type CatalogManualAvailabilityStorage = Pick<
  StorageCollection<CatalogManualAvailabilityRecord>,
  "get" | "put"
>;

export interface SetCatalogItemManualAvailabilityStorage {
  catalog: CatalogItemReadStorage;
  availability: CatalogManualAvailabilityStorage;
}

export interface SetCatalogItemManualAvailabilityInput {
  catalogItemId: string;
  status: CatalogManualAvailabilityStatus;
}

export interface SetCatalogItemManualAvailabilityResult {
  changed: boolean;
  availability: CatalogManualAvailabilityRecord;
}

export interface Money {
  currency: typeof COMMERCE_CURRENCY_USD;
  minor: string;
}

export interface CatalogPriceRecord {
  recordKind: "catalog-price";
  recordId: string;
  catalogItemId: string;
  regular: Money;
  sale?: Money;
}

export type CatalogPriceStorage = Pick<
  StorageCollection<CatalogPriceRecord>,
  "compareAndDelete" | "compareAndSet" | "delete" | "get" | "getVersioned" | "put"
>;

export interface SetCatalogItemPriceStorage {
  catalog: CatalogItemReadStorage;
  prices: CatalogPriceStorage;
}

export interface SetCatalogItemPriceInput {
  catalogItemId: string;
  amount: Money;
}

export interface ClearCatalogItemPriceInput {
  catalogItemId: string;
}

export interface SetCatalogItemPriceResult {
  changed: boolean;
  price: CatalogPriceRecord | null;
}

export interface CatalogItemPriceResolution {
  catalogItemId: string;
  listable: boolean;
  regular?: Money;
  sale?: Money;
  customerPays?: Money;
}

export interface CreateCatalogItemResult {
  created: boolean;
  item: CatalogItemRecord;
}
