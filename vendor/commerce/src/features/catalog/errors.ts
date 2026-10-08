export type CatalogErrorCode =
  | "CATALOG_ITEM_NOT_FOUND"
  | "COMMAND_CONFLICT"
  | "INVALID_INPUT"
  | "MANAGE_STOCK_ENABLED"
  | "MANAGE_STOCK_SETUP_PENDING"
  | "MANAGE_STOCK_UNAVAILABLE"
  | "REGULAR_HAS_SALE"
  | "SALE_NOT_LOWER_THAN_REGULAR"
  | "SALE_REQUIRES_REGULAR"
  | "SKU_CONFLICT"
  | "STORAGE_CONSTRAINTS_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

const STATUS_BY_CODE: Record<CatalogErrorCode, number> = {
  CATALOG_ITEM_NOT_FOUND: 404,
  COMMAND_CONFLICT: 409,
  INVALID_INPUT: 400,
  MANAGE_STOCK_ENABLED: 409,
  MANAGE_STOCK_SETUP_PENDING: 409,
  MANAGE_STOCK_UNAVAILABLE: 409,
  REGULAR_HAS_SALE: 409,
  SALE_NOT_LOWER_THAN_REGULAR: 409,
  SALE_REQUIRES_REGULAR: 409,
  SKU_CONFLICT: 409,
  STORAGE_CONSTRAINTS_UNAVAILABLE: 503,
  STORAGE_UNAVAILABLE: 503,
};

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly status: number;

  constructor(code: CatalogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
