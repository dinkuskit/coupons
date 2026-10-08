import { resolveCatalogItemPrice, parseMinorUnits, type Money } from "../catalog/kernel/index.js";
import { CouponAdminError, deepFreeze, normalizeCouponInstant } from "./admin.js";
import { CouponRecordValidationError, validateCouponRecord } from "./validation.js";
import type {
  CouponCatalogStorage,
  CouponCartLine,
  CouponQuote,
  CouponQuoteLine,
  CouponRecord,
} from "./types.js";

const USD = "USD" as const;

function error(message: string): never {
  throw new CouponAdminError("INVALID_INPUT", message);
}

function money(minor: bigint): Money {
  if (minor < 0n) error("money cannot be negative");
  return { currency: USD, minor: minor.toString() };
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function validateQuantity(value: unknown, index: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    error(`lines[${index}].quantity must be a positive safe integer`);
  }
  return value;
}

function isActive(coupon: CouponRecord, now: string): void {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) error("now must be an ISO instant");
  if (coupon.disabled) error("coupon is disabled");
  const nowMs = instant.getTime();
  if (nowMs < Date.parse(coupon.rule.startsAt) || nowMs >= Date.parse(coupon.rule.endsAt)) {
    error("coupon is not active at this instant");
  }
}

function allocateProportionally(
  totalDiscount: bigint,
  lines: readonly { index: number; subtotal: bigint }[],
): Map<number, bigint> {
  const result = new Map<number, bigint>();
  if (totalDiscount === 0n || lines.length === 0) return result;
  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0n);
  const exact = lines.map((line) => {
    const numerator = totalDiscount * line.subtotal;
    const base = numerator / subtotal;
    return { ...line, base, remainder: numerator % subtotal };
  });
  let remaining = totalDiscount - exact.reduce((sum, line) => sum + line.base, 0n);
  exact.sort((left, right) =>
    right.remainder === left.remainder
      ? left.index - right.index
      : right.remainder > left.remainder ? 1 : -1,
  );
  for (const line of exact) {
    const extra = remaining > 0n ? 1n : 0n;
    result.set(line.index, line.base + extra);
    remaining -= extra;
  }
  return result;
}

export async function evaluateCoupon(
  coupon: CouponRecord,
  storage: CouponCatalogStorage,
  input: {
    readonly quoteId: string;
    readonly lines: readonly CouponCartLine[];
    readonly now: string;
  },
): Promise<CouponQuote> {
  try { validateCouponRecord(coupon, coupon.couponId); }
  catch (err) {
    throw new CouponAdminError("STORAGE_UNAVAILABLE", err instanceof CouponRecordValidationError ? err.message : "coupon record is invalid");
  }
  const inputKeys = Object.keys(input as object);
  if (inputKeys.some((key) => !["quoteId", "lines", "now"].includes(key))) {
    error("evaluator accepts only quoteId, lines, and now; browser totals are not authority");
  }
  if (typeof input.quoteId !== "string" || input.quoteId.trim() === "") error("quoteId must be non-empty");
  if (!Array.isArray(input.lines)) error("lines must be an array");
  const now = normalizeCouponInstant(input.now, "now");
  isActive(coupon, now);

  const rawLines: Array<{
    productId: string;
    quantity: number;
    unitPrice: Money;
    subtotal: bigint;
    eligible: boolean;
  }> = [];
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index];
    if (line && typeof line === "object" && Object.keys(line as object).some((key) => !["productId", "quantity"].includes(key))) {
      error(`lines[${index}] accepts only productId and quantity`);
    }
    if (!line || typeof line.productId !== "string" || line.productId.trim() === "") {
      error(`lines[${index}].productId must be non-empty`);
    }
    const productId = line.productId.trim();
    const quantity = validateQuantity(line.quantity, index);
    const item = await storage.catalog.get(productId);
    if (!item || item.recordKind !== "catalog-item" || item.itemId !== productId) {
      error(`catalog product was not found: ${productId}`);
    }
    const price = await resolveCatalogItemPrice(storage.prices, productId);
    if (!price.listable || !price.customerPays) error(`catalog product has no price: ${productId}`);
    const unitPrice = price.customerPays;
    const subtotal = parseMinorUnits(unitPrice.minor) * BigInt(quantity);
    const selected =
      coupon.rule.appliesTo === "all-merchandise" ||
      coupon.rule.selectedProductIds.includes(productId);
    const eligible = selected && (coupon.rule.includeSaleItems || price.sale === undefined);
    rawLines.push({ productId, quantity, unitPrice, subtotal, eligible });
  }

  const eligibleLines = rawLines
    .map((line, index) => ({ index, subtotal: line.subtotal }))
    .filter((line, index) => rawLines[index].eligible);
  const eligibleSubtotal = eligibleLines.reduce((sum, line) => sum + line.subtotal, 0n);
  const minimum = parseMinorUnits(coupon.rule.minimumEligibleMerchandise.minor);
  if (eligibleSubtotal < minimum) {
    error("minimum eligible merchandise spend not met");
  }
  let discount = 0n;
  if (eligibleSubtotal > 0n) {
    const configured = coupon.rule.discount.kind === "fixed"
      ? parseMinorUnits(coupon.rule.discount.amount.minor)
      : roundHalfUp(
        eligibleSubtotal * BigInt(coupon.rule.discount.basisPoints),
        10000n,
      );
    const maximum = coupon.rule.discount.kind === "percentage" && coupon.rule.discount.maximum
      ? parseMinorUnits(coupon.rule.discount.maximum.minor)
      : configured;
    discount = configured < maximum ? configured : maximum;
    if (discount > eligibleSubtotal) discount = eligibleSubtotal;
  }
  const allocations = allocateProportionally(discount, eligibleLines);
  const lines: CouponQuoteLine[] = rawLines.map((line, index) => {
    const lineDiscount = allocations.get(index) ?? 0n;
    return deepFreeze({
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: { ...line.unitPrice },
      lineSubtotal: money(line.subtotal),
      eligible: line.eligible,
      discount: money(lineDiscount),
    });
  });
  return deepFreeze({
    quoteId: input.quoteId.trim(),
    couponId: coupon.couponId,
    ruleId: coupon.rule.ruleId,
    ruleVersion: coupon.rule.version,
    eligibleSubtotal: money(eligibleSubtotal),
    discount: money(discount),
    payableMerchandiseTotal: money(rawLines.reduce((sum, line) => sum + line.subtotal, 0n) - discount),
    merchandiseTotal: money(rawLines.reduce((sum, line) => sum + line.subtotal, 0n)),
    lines: Object.freeze(lines),
  });
}
