import { recordObject as object } from "./record-object.js";
import { normalizeMoney } from "../catalog/kernel/index.js";
import type { CouponAttempt, CouponRecord, CouponRule, CouponQuoteSnapshot } from "./types.js";

export class CouponRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouponRecordValidationError";
  }
}

function fail(message: string): never {
  throw new CouponRecordValidationError(message);
}

const states = new Set(["pending", "consumed", "released"]);
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be non-empty`);
  }
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${name} must be a safe integer >= ${minimum}`);
  }
}

function money(value: unknown, name: string): void {
  try {
    normalizeMoney(value, name);
  } catch (error) {
    fail(error instanceof Error ? error.message : `${name} is invalid`);
  }
}

function fields(candidate: Record<string, unknown>, names: string[], prefix: string, validate: (value: unknown, name: string) => void): void {
  for (const field of names) validate(candidate[field], prefix + "." + field);
}

function date(value: unknown, name: string): void {
  text(value, name);
  if (!instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${name} must be a canonical UTC instant`);
  }
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) {
    fail(`${name} must be a canonical UTC instant representing a real calendar date`);
  }
}

function rule(value: unknown): asserts value is CouponRule {
  if (!object(value)) {
    fail("rule must be an object");
  }
  const candidate = value as Record<string, unknown>;
  text(candidate.ruleId, "rule.ruleId");
  integer(candidate.version, "rule.version", 1);
  if (!object(candidate.discount)) {
    fail("rule.discount is invalid");
  }
  const discount = candidate.discount as Record<string, unknown>;
  if (discount.kind === "fixed") {
    money(discount.amount, "rule.discount.amount");
  } else if (discount.kind === "percentage") {
    integer(discount.basisPoints, "rule.discount.basisPoints");
    if (discount.basisPoints > 10000) fail("rule percentage exceeds 100%");
    if (discount.maximum !== undefined) money(discount.maximum, "rule.discount.maximum");
  } else {
    fail("rule.discount.kind is invalid");
  }
  if (candidate.appliesTo !== "all-merchandise" && candidate.appliesTo !== "selected-products") {
    fail("rule.appliesTo is invalid");
  }
  if (!Array.isArray(candidate.selectedProductIds) || candidate.selectedProductIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    fail("rule.selectedProductIds is invalid");
  }
  if (candidate.appliesTo === "selected-products" && candidate.selectedProductIds.length === 0) {
    fail("selected-products requires product IDs");
  }
  if (typeof candidate.includeSaleItems !== "boolean") fail("rule.includeSaleItems is invalid");
  money(candidate.minimumEligibleMerchandise, "rule.minimumEligibleMerchandise");
  date(candidate.startsAt, "rule.startsAt");
  date(candidate.endsAt, "rule.endsAt");
  if ((candidate.startsAt as string) >= (candidate.endsAt as string)) {
    fail("rule startsAt must be before endsAt");
  }
  text(candidate.timeZone, "rule.timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate.timeZone as string }).format();
  } catch {
    fail("rule.timeZone must be a valid IANA zone");
  }
}

export function validateCouponQuoteSnapshot(value: unknown, name: string): asserts value is CouponQuoteSnapshot {
  if (!object(value)) fail(`${name} is invalid`);
  const candidate = value as Record<string, unknown>;
  fields(candidate, ["quoteId", "couponId", "ruleId"], name, text);
  integer(candidate.ruleVersion, `${name}.ruleVersion`, 1);
  fields(candidate, ["eligibleSubtotal", "discount", "payableMerchandiseTotal", "merchandiseTotal", "overallPayableTotal"], name, money);

  const overall = candidate.overallPayableTotal as { currency: string; minor: string };
  const merchandise = candidate.merchandiseTotal as { currency: string; minor: string };
  const payableMerchandise = candidate.payableMerchandiseTotal as { currency: string; minor: string };
  const eligibleSubtotal = candidate.eligibleSubtotal as { currency: string; minor: string };
  const discount = candidate.discount as { currency: string; minor: string };

  if (!Array.isArray(candidate.lines)) fail(`${name}.lines is invalid`);

  let sumSubtotal = 0n;
  let sumEligible = 0n;
  let sumLineDiscount = 0n;

  for (const [index, line] of candidate.lines.entries()) {
    if (!object(line)) fail(`${name}.lines[${index}] is invalid`);
    const item = line as Record<string, unknown>;
    const lineName = `${name}.lines[${index}]`;
    text(item.productId, `${lineName}.productId`);
    integer(item.quantity, `${lineName}.quantity`, 1);
    if (typeof item.eligible !== "boolean") fail(`${lineName}.eligible is invalid`);
    fields(item, ["unitPrice", "lineSubtotal", "discount"], lineName, money);

    const u = item.unitPrice as { currency: string; minor: string };
    const ls = item.lineSubtotal as { currency: string; minor: string };
    const ld = item.discount as { currency: string; minor: string };

    if (u.currency !== "USD" || ls.currency !== "USD" || ld.currency !== "USD") {
      fail(`${lineName} currency must be USD`);
    }

    const uMinor = BigInt(u.minor);
    const qty = BigInt(item.quantity as number);
    const lsMinor = BigInt(ls.minor);
    const ldMinor = BigInt(ld.minor);

    if (uMinor * qty !== lsMinor) {
      fail(`${lineName}.lineSubtotal must equal unitPrice * quantity`);
    }
    if (ldMinor < 0n || ldMinor > lsMinor) {
      fail(`${lineName}.discount must be between 0 and lineSubtotal`);
    }
    if (!item.eligible && ldMinor !== 0n) {
      fail(`${lineName}.discount must be 0 for ineligible line`);
    }

    sumSubtotal += lsMinor;
    if (item.eligible) sumEligible += lsMinor;
    sumLineDiscount += ldMinor;
  }

  if (sumSubtotal !== BigInt(merchandise.minor)) {
    fail(`${name}.merchandiseTotal must equal sum of lineSubtotals`);
  }
  if (sumEligible !== BigInt(eligibleSubtotal.minor)) {
    fail(`${name}.eligibleSubtotal must equal sum of eligible lineSubtotals`);
  }
  if (sumLineDiscount !== BigInt(discount.minor)) {
    fail(`${name}.discount must equal sum of line discounts`);
  }
  if (BigInt(merchandise.minor) - BigInt(discount.minor) !== BigInt(payableMerchandise.minor)) {
    fail(`${name}.payableMerchandiseTotal must equal merchandiseTotal - discount`);
  }
  if (BigInt(overall.minor) < BigInt(payableMerchandise.minor)) {
    fail(`${name}.overallPayableTotal is below merchandise payable total`);
  }
  if (BigInt(overall.minor) === 0n && BigInt(payableMerchandise.minor) !== 0n) {
    fail(`${name}.overallPayableTotal cannot be zero for a payable merchandise total`);
  }
}

function attempt(value: unknown, couponId: string): asserts value is CouponAttempt {
  if (!object(value)) fail("attempt is invalid");
  const item = value as Record<string, unknown>;
  fields(item, ["attemptId", "couponId", "ruleId", "quoteId"], "attempt", text);
  if (item.couponId !== couponId) fail("attempt couponId mismatch");
  integer(item.ruleVersion, "attempt.ruleVersion", 1);
  if (typeof item.state !== "string" || !states.has(item.state)) fail("attempt.state is invalid");
  validateCouponQuoteSnapshot(item.quote, "attempt.quote");
  const quoteSnapshot = item.quote as CouponQuoteSnapshot;
  if (quoteSnapshot.couponId !== couponId || quoteSnapshot.ruleId !== item.ruleId || quoteSnapshot.ruleVersion !== item.ruleVersion || quoteSnapshot.quoteId !== item.quoteId) {
    fail("attempt quote identity mismatch");
  }
  if (item.providerSessionId !== undefined) text(item.providerSessionId, "attempt.providerSessionId");
  if (item.freeOrder !== undefined) {
    if (!object(item.freeOrder)) fail("attempt.freeOrder is invalid");
    text((item.freeOrder as Record<string, unknown>).orderId, "attempt.freeOrder.orderId");
    text((item.freeOrder as Record<string, unknown>).receiptId, "attempt.freeOrder.receiptId");
  }

  // Attempt completion: free and provider cannot both be present
  if (item.providerSessionId !== undefined && item.freeOrder !== undefined) {
    fail("attempt cannot have both providerSessionId and freeOrder");
  }

  // Free order only when state is consumed and overall is 0
  if (item.freeOrder !== undefined) {
    if (item.state !== "consumed" || quoteSnapshot.overallPayableTotal.minor !== "0") {
      fail("freeOrder requires consumed state and zero overall total");
    }
  }

  // Zero overall attempt cannot be mapped to provider
  if (quoteSnapshot.overallPayableTotal.minor === "0" && item.providerSessionId !== undefined) {
    fail("zero overall attempt cannot have providerSessionId");
  }

  if (item.state === "consumed") {
    const payable = quoteSnapshot.overallPayableTotal.minor !== "0";
    if (payable && (typeof item.providerSessionId !== "string" || item.freeOrder !== undefined)) {
      fail("consumed payable attempt requires providerSessionId and no freeOrder");
    }
    if (!payable && (item.freeOrder === undefined || item.providerSessionId !== undefined)) {
      fail("consumed free attempt requires freeOrder and no providerSessionId");
    }
  }
}

export function validateCouponRecord(value: unknown, expectedCouponId?: string): CouponRecord {
  if (!object(value)) fail("stored coupon must be an object");
  const record = value as Record<string, unknown>;
  if (record.recordKind !== "coupon") fail("stored coupon recordKind is invalid");
  text(record.couponId, "coupon.couponId");
  if (expectedCouponId !== undefined && record.couponId !== expectedCouponId) fail("stored coupon identity mismatch");
  text(record.code, "coupon.code");
  text(record.normalizedCode, "coupon.normalizedCode");
  integer(record.revision, "coupon.revision", 1);
  integer(record.globalCap, "coupon.globalCap");
  if (typeof record.disabled !== "boolean") fail("coupon.disabled is invalid");
  rule(record.rule);
  date(record.createdAt, "coupon.createdAt");
  date(record.updatedAt, "coupon.updatedAt");
  if (!Array.isArray(record.attempts)) fail("coupon.attempts must be an array");
  const seen = new Set<string>();
  for (const item of record.attempts) {
    attempt(item, record.couponId);
    if (seen.has(item.attemptId)) fail("duplicate attemptId");
    seen.add(item.attemptId);
  }
  return record as unknown as CouponRecord;
}
