import { ManagedSkuRegistrationError } from "./errors.js";
import type {
  ConcurrentManagedSkuRegistrationFeedback,
  ManagedSkuRegistrationClaimRecord,
  ManagedSkuRegistrationRequest,
  ManagedSkuRegistrationUnavailableFeedback,
} from "./types.js";

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedSkuRegistrationError(
      "REGISTRATION_CLAIM_UNAVAILABLE",
      `${field} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(
  value: unknown,
  field: string,
  code: "INVALID_REGISTRATION" | "REGISTRATION_CLAIM_UNAVAILABLE" =
    "REGISTRATION_CLAIM_UNAVAILABLE",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManagedSkuRegistrationError(code, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeClaimRequest(value: unknown): ManagedSkuRegistrationRequest {
  const request = asRecord(value, "claim request");
  return {
    poolId: asNonEmptyString(request.poolId, "claim request.poolId"),
    sku: asNonEmptyString(request.sku, "claim request.sku"),
    displayNameIfNew: asNonEmptyString(
      request.displayNameIfNew,
      "claim request.displayNameIfNew",
    ),
  };
}

export function normalizeManagedSkuRegistrationClaimRecord(
  value: unknown,
): ManagedSkuRegistrationClaimRecord {
  const claim = asRecord(value, "managed SKU registration claim");
  if (claim.recordKind !== "managed-sku-registration-claim") {
    throw new ManagedSkuRegistrationError(
      "REGISTRATION_CLAIM_UNAVAILABLE",
      "registration claim has an invalid record kind",
    );
  }

  const operationId = asNonEmptyString(claim.operationId, "claim.operationId");
  return {
    recordKind: "managed-sku-registration-claim",
    recordId: asNonEmptyString(claim.recordId, "claim.recordId"),
    claimKey: asNonEmptyString(claim.claimKey, "claim.claimKey"),
    catalogItemId: asNonEmptyString(claim.catalogItemId, "claim.catalogItemId"),
    operationId,
    request: normalizeClaimRequest(claim.request),
    createdAt: asNonEmptyString(claim.createdAt, "claim.createdAt"),
  };
}

export function createManagedSkuRegistrationClaimKey(input: {
  catalogItemId: string;
  rejectedOperationId?: string;
}): string {
  const candidate = asRecord(input, "registration claim key input");
  const catalogItemId = asNonEmptyString(
    candidate.catalogItemId,
    "catalogItemId",
    "INVALID_REGISTRATION",
  );
  if (candidate.rejectedOperationId === undefined) {
    return JSON.stringify(["managed-sku-registration", catalogItemId, "initial"]);
  }

  const rejectedOperationId = asNonEmptyString(
    candidate.rejectedOperationId,
    "rejectedOperationId",
    "INVALID_REGISTRATION",
  );
  return JSON.stringify([
    "managed-sku-registration",
    catalogItemId,
    "after-rejection",
    rejectedOperationId,
  ]);
}

export function sameManagedSkuRegistrationRequest(
  left: ManagedSkuRegistrationRequest,
  right: ManagedSkuRegistrationRequest,
): boolean {
  return (
    left.poolId === right.poolId &&
    left.sku === right.sku &&
    left.displayNameIfNew === right.displayNameIfNew
  );
}

export function createConcurrentManagedSkuRegistrationFeedback(
  status: "pending" | "complete",
  poolName: string,
): ConcurrentManagedSkuRegistrationFeedback {
  const normalizedPoolName = asNonEmptyString(
    poolName,
    "poolName",
    "INVALID_REGISTRATION",
  );
  if (status === "pending") {
    return {
      message: `This product is already being connected to ${normalizedPoolName} in another session. Refresh to check its status.`,
      actionLabel: "Refresh status",
    };
  }
  if (status === "complete") {
    return {
      message: `This product was connected to ${normalizedPoolName} in another session. Refresh to review its inventory settings.`,
      actionLabel: "Refresh status",
    };
  }
  throw new ManagedSkuRegistrationError(
    "INVALID_REGISTRATION",
    "concurrent registration status must be pending or complete",
  );
}

export function createManagedSkuRegistrationUnavailableFeedback(): ManagedSkuRegistrationUnavailableFeedback {
  return {
    message: "Inventory setup is temporarily unavailable. Please try again.",
  };
}
