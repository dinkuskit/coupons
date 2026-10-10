/** Sandbox-safe inventory-provider surface (no claim/registration ports). */
export { normalizeInventoryProviderBinding } from "../binding.js";
export { InventoryProviderBindingError } from "../errors.js";
export type { InventoryProviderBindingErrorCode } from "../errors.js";
export {
  createInitialStockManagement,
  normalizeStoredStockManagement,
  setManageStock,
} from "../stock-management.js";
export { INVENTORY_PROVIDER_FEATURE_ID } from "../types.js";
export type {
  ActiveManagedStockManagement,
  InventoryProviderPort,
  InventoryProviderBinding,
  InventoryProviderBindingInput,
  InventorySkuIdentity,
  ManagedStockManagement,
  ManagedStockStatus,
  NeedsReviewManagedStockManagement,
  PersistManagedStockManagement,
  SetupNeedsAttentionManagedStockManagement,
  SetupPendingManagedStockManagement,
  SetupRequiredManagedStockManagement,
  StockManagement,
  UnmanagedStockManagement,
} from "../types.js";
