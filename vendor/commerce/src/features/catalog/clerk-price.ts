import { parseMinorUnits } from "./money.js";
import { COMMERCE_CURRENCY_USD, type Money } from "./types.js";

const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export const CLERK_DOLLAR_MESSAGE = "Enter a dollar amount like 12 or 12.50.";
export const CLERK_SALE_LOWER_MESSAGE = "Sale must be lower than Regular.";
export const CLERK_END_SALE_MESSAGE = "End the sale before clearing Regular.";
export const CLERK_SALE_NEEDS_REGULAR_MESSAGE = "Set Regular before Sale.";

export type ParsedClerkDollar =
  | { status: "blank" }
  | { status: "amount"; amount: Money }
  | { status: "invalid" };

export function parseClerkDollar(value: string): ParsedClerkDollar {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { status: "blank" };
  const unsigned = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
  const match = AMOUNT_PATTERN.exec(unsigned);
  if (match === null) return { status: "invalid" };
  const centsText = match[2] ?? "";
  const minor =
    BigInt(match[1] ?? "0") * 100n + BigInt(centsText.padEnd(2, "0") || "0");
  if (minor > MAX_SAFE_MINOR) return { status: "invalid" };
  const amount = { currency: COMMERCE_CURRENCY_USD, minor: minor.toString() };
  parseMinorUnits(amount.minor);
  return { status: "amount", amount };
}

export function formatClerkDollar(amount: Money): string {
  const minor = parseMinorUnits(amount.minor);
  const cents = (minor % 100n).toString().padStart(2, "0");
  return `${(minor / 100n).toString()}.${cents}`;
}
