export type InventoryProviderBindingErrorCode = "INVALID_BINDING";

export class InventoryProviderBindingError extends Error {
  readonly code: InventoryProviderBindingErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "InventoryProviderBindingError";
    this.code = "INVALID_BINDING";
  }
}
