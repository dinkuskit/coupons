import type { GuestCheckoutErrorCode } from "./types.js";

const STATUS_BY_CODE: Record<GuestCheckoutErrorCode, number> = {
  CAPABILITY_DENIED: 403,
  CHECKOUT_FROZEN: 409,
  CHECKOUT_NOT_FOUND: 404,
  CONTENTION: 409,
  INVALID_CART: 400,
  INVENTORY_UNAVAILABLE: 409,
  ORIGIN_DENIED: 403,
  PAYMENTS_UNAVAILABLE: 503,
  PRODUCT_UNAVAILABLE: 409,
  RETRY_REQUIRED: 409,
  UNAVAILABLE: 503,
};

const MESSAGE_BY_CODE: Record<GuestCheckoutErrorCode, string> = {
  CAPABILITY_DENIED: "Guest checkout capability is missing or invalid",
  CHECKOUT_FROZEN: "Active checkout cart is frozen",
  CHECKOUT_NOT_FOUND: "Checkout not found",
  CONTENTION: "Checkout contention; retry",
  INVALID_CART: "Invalid cart",
  INVENTORY_UNAVAILABLE: "Inventory unavailable",
  ORIGIN_DENIED: "Guest checkout origin is missing or invalid",
  PAYMENTS_UNAVAILABLE: "Payments are unavailable",
  PRODUCT_UNAVAILABLE: "Product unavailable",
  RETRY_REQUIRED: "Retry requires the released attempt identity",
  UNAVAILABLE: "Checkout is unavailable",
};

export class GuestCheckoutError extends Error {
  readonly code: GuestCheckoutErrorCode;
  readonly status: number;

  constructor(code: GuestCheckoutErrorCode, message = MESSAGE_BY_CODE[code], options?: ErrorOptions) {
    super(message, options);
    this.name = "GuestCheckoutError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function guestCheckoutErrorMessage(code: GuestCheckoutErrorCode): string {
  return MESSAGE_BY_CODE[code];
}
