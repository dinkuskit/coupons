import { guestCheckoutErrorMessage } from "./errors.js";
import {
  GUEST_CHECKOUT_PROJECTION_SCHEMA,
  type CheckoutAttempt,
  type CheckoutPricingSnapshot,
  type CouponUnavailableReason,
  type GuestCheckoutErrorCode,
  type GuestCheckoutLine,
  type GuestCheckoutProjection,
  type GuestCheckoutState,
} from "./types.js";

function publicPricing(pricing: CheckoutPricingSnapshot) {
  return structuredClone({
    merchandiseSubtotal: pricing.merchandiseSubtotal,
    couponDiscount: pricing.couponDiscount,
    netMerchandise: pricing.netMerchandise,
    shipping: { mode: pricing.shipping.mode, charge: pricing.shipping.charge },
    finalTotal: pricing.finalTotal,
  });
}

function linesOf(attempt: CheckoutAttempt | undefined): GuestCheckoutLine[] {
  return (attempt?.payment.lines ?? []).map((line) => ({
    catalogItemId: line.catalogItemId,
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
  }));
}

function stateOf(attempt: CheckoutAttempt): GuestCheckoutState {
  if (attempt.phase === "paid" && attempt.order) return "paid";
  if (attempt.phase === "released") return "released-retry";
  if (attempt.phase === "releasing") return "recoverable-failure";
  if (attempt.phase === "reserving") return "recoverable-failure";
  if (attempt.phase === "paying" && !attempt.session) return "recoverable-failure";
  return "pending";
}

const COUPON_REASONS: readonly string[] = [
  "not-found", "not-started", "expired", "minimum-not-met", "no-qualifying-items", "not-applicable", "used-up", "try-later",
];

function unavailableOf(
  attempt: CheckoutAttempt,
): GuestCheckoutProjection["unavailable"] {
  if (attempt.phase === "paid" && attempt.order) return null;
  if (attempt.phase === "released" && !attempt.coupon?.refused) return null;
  if (attempt.phase === "paying" && attempt.session) return null;
  const refused: unknown = attempt.coupon?.refused;
  if (refused) {
    // Attempts saved before reasons existed hold `refused: true`; they answer the fallback reason.
    const reason = typeof refused === "string" && COUPON_REASONS.includes(refused)
      ? refused as CouponUnavailableReason
      : "not-applicable";
    return { code: "COUPON_UNAVAILABLE", message: guestCheckoutErrorMessage("COUPON_UNAVAILABLE"), reason };
  }
  const code: GuestCheckoutErrorCode = attempt.phase === "reserving" && attempt.stock
    ? "INVENTORY_UNAVAILABLE"
    : attempt.phase === "paying"
      ? "PAYMENTS_UNAVAILABLE"
      : "UNAVAILABLE";
  return { code, message: guestCheckoutErrorMessage(code) };
}

export function projectPreparedGuestCheckout(): GuestCheckoutProjection {
  return {
    schema: GUEST_CHECKOUT_PROJECTION_SCHEMA,
    state: "pending",
    attemptId: null,
    lines: [],
    total: null,
    redirectUrl: null,
    order: null,
    retryAfter: null,
    unavailable: null,
  };
}

export function projectGuestCheckout(
  attempt: CheckoutAttempt | undefined,
  now?: number,
): GuestCheckoutProjection {
  if (!attempt) {
    return {
      ...projectPreparedGuestCheckout(),
      state: "recoverable-failure",
      unavailable: { code: "CHECKOUT_NOT_FOUND", message: "Checkout not found" },
    };
  }
  const lines = linesOf(attempt);
  const paid = attempt.phase === "paid" && attempt.order
    ? {
        ...(attempt.order.variantSelections ? { variantSelections: structuredClone(attempt.order.variantSelections) } : {}),
        orderId: attempt.order.orderId,
        receiptId: attempt.order.receiptId,
        lines,
        total: attempt.order.total,
        ...(attempt.order.pricing ? { pricing: publicPricing(attempt.order.pricing) } : {}),
      }
    : null;
  const isTerminalOrReleased = attempt.phase === "released" || attempt.phase === "releasing";
  const isExpired =
    typeof now === "number" &&
    typeof attempt.session?.expiresAt === "number" &&
    now >= attempt.session.expiresAt;
  const redirectUrl =
    paid !== null || isTerminalOrReleased || isExpired
      ? null
      : attempt.session?.redirectUrl ?? null;
  return {
    schema: GUEST_CHECKOUT_PROJECTION_SCHEMA,
    state: stateOf(attempt),
    attemptId: attempt.attemptId,
    ...(attempt.variantSelections ? { variantSelections: structuredClone(attempt.variantSelections) } : {}),
    lines,
    total: attempt.payment.total,
    ...(attempt.payment.pricing ? { pricing: publicPricing(attempt.payment.pricing) } : {}),
    redirectUrl,
    order: paid,
    retryAfter: attempt.phase === "released" ? attempt.attemptId : null,
    unavailable: unavailableOf(attempt),
  };
}
