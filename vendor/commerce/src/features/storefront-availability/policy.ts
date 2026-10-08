import { StorefrontAvailabilityError } from "./errors.js";
import type { StorefrontAvailabilityDisplayPolicy } from "./types.js";

export const DEFAULT_STOREFRONT_AVAILABILITY_POLICY = {
  mode: "status",
} as const satisfies StorefrontAvailabilityDisplayPolicy;

function invalid(message: string): never {
  throw new StorefrontAvailabilityError("INVALID_INPUT", message);
}

export function normalizeStorefrontAvailabilityPolicy(
  value: unknown,
): StorefrontAvailabilityDisplayPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("storefront availability policy must be an object");
  }
  const policy = value as Record<string, unknown>;
  if (policy.mode === "status" || policy.mode === "exact") {
    if (Object.keys(policy).length !== 1) {
      return invalid(`${policy.mode} availability policy accepts only mode`);
    }
    return { mode: policy.mode };
  }
  if (policy.mode === "threshold") {
    if (
      Object.keys(policy).length !== 2 ||
      !Object.hasOwn(policy, "threshold") ||
      typeof policy.threshold !== "number" ||
      !Number.isSafeInteger(policy.threshold) ||
      policy.threshold < 1
    ) {
      return invalid("threshold availability policy requires a positive integer threshold");
    }
    return { mode: "threshold", threshold: policy.threshold };
  }
  return invalid("availability policy mode must be status, exact, or threshold");
}

export function sameStorefrontAvailabilityPolicy(
  left: StorefrontAvailabilityDisplayPolicy,
  right: StorefrontAvailabilityDisplayPolicy,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode !== "threshold" ||
      (right.mode === "threshold" && left.threshold === right.threshold))
  );
}
