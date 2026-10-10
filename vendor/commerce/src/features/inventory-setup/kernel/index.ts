/** Sandbox-safe inventory-setup surface (read path only; no configure/claims). */
export { InventorySetupError } from "../errors.js";
export type { InventorySetupErrorCode } from "../errors.js";

export { loadStoreInventoryConfiguration } from "../store-configuration-read.js";
export {
  INVENTORY_SETUP_FEATURE_ID,
  STORE_INVENTORY_CONFIGURATIONS_COLLECTION,
  STORE_INVENTORY_CONFIGURATION_UNIQUE_INDEXES,
} from "../types.js";
export type {
  CreateStoreInventoryConfigurationOptions,
  CreateStoreInventoryConfigurationResult,
  InventorySetupStorage,
  StoreInventoryConfigurationProbeRecord,
  StoreInventoryConfigurationRecord,
  StoreInventoryConfigurationStorage,
  StoreInventoryConfigurationStorageRecord,
} from "../types.js";
