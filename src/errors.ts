import { CatalogError, CouponAdminError, CouponRedemptionError } from "./core.js";

export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

/** A result that crosses the Durable Object RPC boundary as plain data. */
export type Outcome =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

const REDEMPTION_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_ATTEMPT: 404,
  CAPACITY_EXHAUSTED: 409,
  CONFLICTING_ATTEMPT: 409,
  TERMINAL_CONFLICT: 409,
  CONTENTION: 409,
  CORRUPTED_RECORD: 500,
};

const ADMIN_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  STORAGE_UNAVAILABLE: 500,
};

/** Maps the coupon core's own error types to the HTTP contract's status and code. */
export function toOutcome(error: unknown): Outcome {
  if (error instanceof ServiceError) {
    return { ok: false, status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof CouponRedemptionError) {
    return { ok: false, status: REDEMPTION_STATUS[error.code] ?? 500, code: error.code, message: error.message };
  }
  if (error instanceof CouponAdminError) {
    return { ok: false, status: ADMIN_STATUS[error.code] ?? 500, code: error.code, message: error.message };
  }
  if (error instanceof CatalogError) {
    return { ok: false, status: 400, code: "INVALID_INPUT", message: error.message };
  }
  console.error("coupon service internal error", error);
  return { ok: false, status: 500, code: "INTERNAL", message: "internal error" };
}

export function ok(body: unknown, status = 200): Outcome {
  return { ok: true, status, body };
}
