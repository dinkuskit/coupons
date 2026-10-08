import type { ExactQuantity } from "./types.js";

const EXACT_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function normalizeExactQuantity(value: unknown): ExactQuantity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const quantity = value as Record<string, unknown>;
  if (
    typeof quantity.value !== "string" ||
    !EXACT_DECIMAL_PATTERN.test(quantity.value) ||
    typeof quantity.unit !== "string" ||
    quantity.unit.trim().length === 0
  ) {
    return null;
  }
  return { value: quantity.value, unit: quantity.unit.trim() };
}

export function exactQuantitySign(value: string): -1 | 0 | 1 {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const nonZero = unsigned.replace(".", "").split("").some((digit) => digit !== "0");
  if (!nonZero) return 0;
  return negative ? -1 : 1;
}

export function positiveQuantityAtOrBelowInteger(
  value: string,
  threshold: number,
): boolean {
  if (exactQuantitySign(value) !== 1) return false;
  const [whole, fraction = ""] = value.split(".");
  const wholeValue = BigInt(whole);
  const thresholdValue = BigInt(threshold);
  if (wholeValue < thresholdValue) return true;
  if (wholeValue > thresholdValue) return false;
  return fraction.length === 0 || [...fraction].every((digit) => digit === "0");
}
