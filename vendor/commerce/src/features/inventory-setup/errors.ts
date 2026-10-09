export type InventorySetupErrorCode =
  | "CATALOG_ITEM_NOT_FOUND"
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "MANAGE_STOCK_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "STORAGE_CONSTRAINTS_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

const STATUS_BY_CODE: Record<InventorySetupErrorCode, number> = {
  CATALOG_ITEM_NOT_FOUND: 404,
  INVALID_CONFIGURATION: 400,
  INVALID_INPUT: 400,
  MANAGE_STOCK_REQUIRED: 409,
  PROVIDER_UNAVAILABLE: 503,
  STORAGE_CONSTRAINTS_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 503,
};

export class InventorySetupError extends Error {
  readonly code: InventorySetupErrorCode;
  readonly status: number;

  constructor(
    code: InventorySetupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventorySetupError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
