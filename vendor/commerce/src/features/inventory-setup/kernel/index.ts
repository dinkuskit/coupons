export { configureCatalogItemInventory } from "../configure-inventory.js";
export { InventorySetupError } from "../errors.js";
export type { InventorySetupErrorCode } from "../errors.js";

export {
  createStoreInventoryConfiguration,
  loadStoreInventoryConfiguration,
  storeInventoryConfigurationUniqueIndexName,
} from "../store-configuration.js";
export type { StoreInventoryConfigurationUniqueField } from "../store-configuration.js";
export {
  INVENTORY_SETUP_FEATURE_ID,
  STORE_INVENTORY_CONFIGURATIONS_COLLECTION,
  STORE_INVENTORY_CONFIGURATION_UNIQUE_INDEXES,
} from "../types.js";
export type {
  ConfigureCatalogItemInventoryResult,
  ConfigureInventoryCatalogStorage,
  ConfigureInventoryClaimStorage,
  ConfigureInventoryExecution,
  CreateStoreInventoryConfigurationOptions,
  CreateStoreInventoryConfigurationResult,
  InventorySetupStorage,
  StoreInventoryConfigurationProbeRecord,
  StoreInventoryConfigurationRecord,
  StoreInventoryConfigurationStorage,
  StoreInventoryConfigurationStorageRecord,
} from "../types.js";
