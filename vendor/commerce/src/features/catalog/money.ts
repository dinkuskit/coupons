import { CatalogError } from "./errors.js";
import { COMMERCE_CURRENCY_USD, type Money } from "./types.js";

const MINOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMinorUnits(minor: string): bigint {
  if (!MINOR_PATTERN.test(minor)) {
    throw new CatalogError(
      "INVALID_INPUT",
      "money.minor must be a non-negative integer string",
    );
  }
  const value = BigInt(minor);
  if (value > MAX_SAFE_MINOR) {
    throw new CatalogError("INVALID_INPUT", "money.minor must be a safe integer");
  }
  return value;
}

export function normalizeMoney(value: unknown, label = "money"): Money {
  if (!isPlainObject(value)) {
    throw new CatalogError("INVALID_INPUT", `${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("currency") ||
    !keys.includes("minor") ||
    value.currency !== COMMERCE_CURRENCY_USD ||
    typeof value.minor !== "string"
  ) {
    throw new CatalogError(
      "INVALID_INPUT",
      `${label} must be { currency: "USD", minor } with a string integer minor`,
    );
  }
  parseMinorUnits(value.minor);
  return {
    currency: COMMERCE_CURRENCY_USD,
    minor: value.minor,
  };
}

export function moneyEquals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}

export function saleIsStrictlyLower(sale: Money, regular: Money): boolean {
  return (
    sale.currency === regular.currency &&
    parseMinorUnits(sale.minor) < parseMinorUnits(regular.minor)
  );
}
