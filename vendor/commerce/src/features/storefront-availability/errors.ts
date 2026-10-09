export type StorefrontAvailabilityErrorCode =
  | "CATALOG_ITEM_NOT_FOUND"
  | "INVALID_INPUT"
  | "MANAGE_STOCK_REQUIRED"
  | "STORAGE_UNAVAILABLE";

export class StorefrontAvailabilityError extends Error {
  readonly code: StorefrontAvailabilityErrorCode;

  constructor(code: StorefrontAvailabilityErrorCode, message: string) {
    super(message);
    this.name = "StorefrontAvailabilityError";
    this.code = code;
  }
}
