import { normalizeCouponCode, validateCouponQuoteSnapshot } from "../coupons/index.js";
import type { CouponQuote, CouponQuoteSnapshot } from "../coupons/index.js";
import { normalizeMoney, parseMinorUnits, type Money } from "../catalog/kernel/index.js";
import type {
  CartLine,
  CheckoutLine,
  CheckoutPricingLine,
  CheckoutPricingSnapshot,
  CheckoutExecution,
  CouponUnavailable,
  TrustedShippingConfiguration,
} from "./types.js";
import { CHECKOUT_PRICING_SCHEMA } from "./types.js";

function fail(message: string): never {
  throw new Error(message);
}

const REASONS: readonly string[] = ["not-found", "not-started", "expired", "minimum-not-met", "no-qualifying-items"];

/** Thrown before anything is frozen; the guest error map reads `coupon`. */
export class CouponUnavailableError extends Error {
  constructor(readonly coupon: CouponUnavailable) {
    super(`Coupon unavailable: ${coupon.reason}`);
  }
}

function couponUnavailable(reason: CouponUnavailable["reason"], minimum?: Money): never {
  let shown: Money | undefined;
  try { shown = minimum && normalizeMoney(minimum); } catch { /* a malformed minimum is left out */ }
  throw new CouponUnavailableError({ reason, ...(shown?.currency === "USD" ? { minimum: shown } : {}) });
}

function usd(minor: bigint): Money {
  return normalizeMoney({ currency: "USD", minor: minor.toString() });
}

function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

function shippingCharge(config: TrustedShippingConfiguration): Money {
  if (typeof config.configurationId !== "string" || !config.configurationId.trim() ||
      !Number.isSafeInteger(config.revision) || config.revision < 1) {
    fail("Invalid shipping configuration");
  }
  if (config.mode === "free") {
    if (config.amount !== undefined && parseMinorUnits(normalizeMoney(config.amount).minor) !== 0n) {
      fail("Free shipping configuration must be zero");
    }
    return { currency: "USD", minor: "0" };
  }
  if (config.mode !== "flat" || !config.amount) fail("Invalid shipping configuration");
  const amount = normalizeMoney(config.amount);
  if (amount.currency !== "USD" || parseMinorUnits(amount.minor) < 0n) {
    fail("Flat shipping must be non-negative USD");
  }
  return amount;
}

function quoteSnapshot(quote: CouponQuote, total: Money): CouponQuoteSnapshot {
  return Object.freeze({
    ...structuredClone(quote),
    merchandiseTotal: normalizeMoney({
      currency: "USD",
      minor: quote.lines.reduce((sum, line) => sum + BigInt(line.lineSubtotal.minor), 0n).toString(),
    }),
    overallPayableTotal: total,
  });
}

function couponLine(quote: CouponQuote | undefined, line: CheckoutLine, index: number): CheckoutPricingLine {
  const found = quote?.lines[index];
  const subtotal = normalizeMoney(found?.lineSubtotal ?? {
    currency: "USD",
    minor: (parseMinorUnits(line.unitPrice.minor) * BigInt(line.quantity)).toString(),
  });
  const discount = normalizeMoney(found?.discount ?? { currency: "USD", minor: "0" });
  return {
    catalogItemId: line.catalogItemId,
    quantity: line.quantity,
    unitPrice: normalizeMoney(line.unitPrice),
    lineSubtotal: subtotal,
    discount,
    netAmount: usd(BigInt(subtotal.minor) - BigInt(discount.minor)),
  };
}

export interface ComposedPricing {
  snapshot: CheckoutPricingSnapshot;
  couponId?: string;
  couponCode?: string;
}

export async function composeCheckoutPricing(
  lines: readonly CheckoutLine[],
  cart: readonly CartLine[],
  attemptId: string,
  couponCode: string | undefined,
  execution: CheckoutExecution,
): Promise<ComposedPricing> {
  const pricing = execution.pricing;
  if (!pricing) fail("Pricing composition is unavailable");
  const config = await pricing.resolveShippingConfiguration();
  if (!config) fail(couponCode ? "Shipping configuration unavailable" : "Pricing configuration unavailable");
  const charge = shippingCharge(config);
  let quote: CouponQuote | undefined;
  let couponId: string | undefined;
  let normalizedCode: string | undefined;
  if (couponCode !== undefined) {
    normalizedCode = normalizeCouponCode(couponCode);
    let quoted;
    try {
      quoted = await pricing.coupons?.quote(normalizedCode, {
        catalog: execution.catalog.catalog,
        prices: execution.catalog.prices,
      }, {
        quoteId: `${attemptId}:coupon`,
        lines: cart.map((line) => ({ productId: line.catalogItemId, quantity: line.quantity })),
        now: new Date((execution.now?.() ?? Date.now() / 1000) * 1000).toISOString(),
      });
    } catch (error) {
      // An unknown, expired or unreachable coupon never prices the cart; the
      // shopper removes it to accept the full price (issue 34).
      if (error instanceof Error && /Product un/.test(error.message)) throw error;
      // The coupon owner answers INVALID_INPUT in process and NOT_APPLICABLE
      // over HTTP when a coupon does not apply, with a reason when it has one.
      const { code, notApplicable } = (error ?? {}) as {
        code?: unknown; notApplicable?: { reason?: unknown; minimum?: Money };
      };
      if (code !== "INVALID_INPUT" && code !== "NOT_APPLICABLE") couponUnavailable("try-later");
      const reason = notApplicable?.reason;
      if (typeof reason !== "string" || !REASONS.includes(reason)) couponUnavailable("not-applicable");
      couponUnavailable(reason as CouponUnavailable["reason"],
        reason === "minimum-not-met" ? notApplicable!.minimum : undefined);
    }
    if (pricing.coupons && !quoted) couponUnavailable("not-found");
    if (!quoted) couponUnavailable("try-later");
    couponId = quoted.couponId;
    quote = quoted.quote;
    if (quote.lines.length !== lines.length || quote.lines.some((line, index) =>
      line.productId !== lines[index].catalogItemId ||
      line.quantity !== lines[index].quantity ||
      !sameMoney(line.unitPrice, lines[index].unitPrice))) {
      fail("Catalog changed during pricing");
    }
    // A quote whose arithmetic disagrees with Commerce's own prices never
    // freezes, wherever it was evaluated.
    try {
      validateCouponQuoteSnapshot(quoteSnapshot(quote, quote.payableMerchandiseTotal), "coupon quote");
    } catch { couponUnavailable("try-later"); }
  }
  const pricingLines = lines.map((line, index) => couponLine(quote, line, index));
  const merchandiseSubtotal = usd(pricingLines.reduce((sum, line) => sum + BigInt(line.lineSubtotal.minor), 0n));
  const couponDiscount = usd(pricingLines.reduce((sum, line) => sum + BigInt(line.discount.minor), 0n));
  const netMerchandise = usd(BigInt(merchandiseSubtotal.minor) - BigInt(couponDiscount.minor));
  const finalTotal = usd(BigInt(netMerchandise.minor) + BigInt(charge.minor));
  const snapshot: CheckoutPricingSnapshot = Object.freeze({
    schema: CHECKOUT_PRICING_SCHEMA,
    merchandiseSubtotal,
    couponDiscount,
    netMerchandise,
    shipping: {
      configurationId: config.configurationId.trim(),
      revision: config.revision,
      mode: config.mode,
      charge,
    },
    finalTotal,
    lines: Object.freeze(pricingLines),
    ...(quote && normalizedCode ? { coupon: { code: normalizedCode, quote: quoteSnapshot(quote, finalTotal) } } : {}),
  });
  if (quote && BigInt(snapshot.couponDiscount.minor) !== BigInt(quote.discount.minor)) {
    fail("Coupon allocation is not conserved");
  }
  return { snapshot, ...(couponId ? { couponId } : {}), ...(normalizedCode ? { couponCode: normalizedCode } : {}) };
}
