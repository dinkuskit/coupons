import { InventoryProviderBindingError } from "./errors.js";
import type {
  InventoryProviderBinding,
  InventoryProviderBindingInput,
} from "./types.js";

function requireOpaqueIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InventoryProviderBindingError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeInventoryProviderBinding(
  input: unknown,
): InventoryProviderBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InventoryProviderBindingError("inventory provider binding must be an object");
  }

  const candidate = input as Partial<InventoryProviderBindingInput>;
  return {
    providerRef: requireOpaqueIdentity(candidate.providerRef, "providerRef"),
    poolId: requireOpaqueIdentity(candidate.poolId, "poolId"),
    defaultFulfillmentLocationId: requireOpaqueIdentity(
      candidate.defaultFulfillmentLocationId,
      "defaultFulfillmentLocationId",
    ),
  };
}
