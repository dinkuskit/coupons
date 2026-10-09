export const CLERK_STOCK_STATUSES = [
  "in-stock",
  "out-of-stock",
  "on-backorder",
] as const;

export type ClerkStockStatus = (typeof CLERK_STOCK_STATUSES)[number];

export const CLERK_STOCK_STATUS_MESSAGE =
  "Choose In stock, Out of stock, or On backorder.";
export const MANAGED_STOCK_STATUS_MESSAGE =
  "Stock status is hidden while Manage Stock is on.";
export const MANAGE_STOCK_SETUP_PENDING_MESSAGE =
  "Inventory setup is still running. Try Save again in a moment.";
export {
  MANAGE_STOCK_LOCKED_MESSAGE,
  MANAGE_STOCK_UNAVAILABLE_MESSAGE,
} from "./v1-stock-admission.js";
