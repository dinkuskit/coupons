import { isRecord, sortedKeys } from "../../shared/record.js";
import { normalizeMoney, parseMinorUnits } from "../catalog/kernel/index.js";
import { quoteCatalogBasket } from "../storefront-availability/kernel/index.js";
import { createCurrentPaymentRequest, providerSessionWindowIsValid } from "./payment-window.js";
import { composeCheckoutPricing } from "./pricing.js";
import { handOffPaidOrder } from "./paid-orders.js";
import { CouponRedemptionError, normalizeCouponCode, type CouponQuote } from "../coupons/index.js";
import { CHECKOUT_PRICING_SCHEMA, CHECKOUT_VARIANT_SELECTION_SCHEMA } from "./types.js";
import type { CartLine, CheckoutAttempt, CheckoutExecution, CheckoutLine, CheckoutVariantSelectionSnapshot, PaymentOutcome, PaymentSession, StockRequest } from "./types.js";
import {
  captureCheckoutContact,
  CheckoutContactError,
  type CheckoutContactSnapshot,
} from "../checkout-contact/index.js";

export class CheckoutError extends Error {}
function fail(message: string): never { throw new CheckoutError(message); }
const QUOTE_FAILURES = {
  unavailable: "Product unavailable",
  unpriced: "Product unpriced",
  "inventory-setup": "Inventory setup required",
  "inventory-unavailable": "Inventory unavailable",
};
function cartInput(raw: unknown): CartLine[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) fail("Invalid cart");
  const quantities = new Map<string, number>();
  for (const line of raw) {
    if (!line || typeof line !== "object" || sortedKeys(line) !== "catalogItemId,quantity" ||
      typeof line.catalogItemId !== "string" || !line.catalogItemId.trim() ||
      !Number.isSafeInteger(line.quantity) || line.quantity <= 0) fail("Invalid cart line");
    const id = line.catalogItemId.trim();
    const quantity = (quantities.get(id) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) fail("Invalid quantity");
    quantities.set(id, quantity);
  }
  return [...quantities].sort(([a], [b]) => a.localeCompare(b)).map(([catalogItemId, quantity]) => ({ catalogItemId, quantity }));
}
function current(attempts: CheckoutAttempt[]): CheckoutAttempt {
  return attempts[attempts.length - 1] ?? fail("Checkout not found");
}
async function freeze(
  cart: CartLine[],
  e: CheckoutExecution,
  couponCode?: string,
  rawContact?: unknown,
): Promise<CheckoutAttempt> {
  if (!e.loadCheckoutContactRequirements) throw new CheckoutContactError("REQUIREMENTS_UNAVAILABLE");
  const lines: CheckoutLine[] = [];
  const selections: CheckoutVariantSelectionSnapshot[] = [];
  let stock: StockRequest | undefined;
  const attemptId = (e.createAttemptId ?? (() => globalThis.crypto.randomUUID()))();
  if (!attemptId) fail("Invalid attempt identity");
  if (!e.paymentBindingRef.trim()) fail("Payment binding required");
  if (e.pricing && e.pricing.paymentPricingSchema !== CHECKOUT_PRICING_SCHEMA) {
    fail("Payments pricing schema unsupported");
  }
  const quote = await quoteCatalogBasket(e.catalog, cart.map(line => line.catalogItemId), e.availability);
  if (!quote.ok) fail(QUOTE_FAILURES[quote.reason]);
  const contactSnapshot = await captureCheckoutContact(rawContact, e.loadCheckoutContactRequirements,
    quote.lines.some(line => line.fulfillment === "physical"));
  for (const [index, quoted] of quote.lines.entries()) {
    const line = cart[index];
    const { variant } = quoted;
    if (variant) selections.push({ schema: CHECKOUT_VARIANT_SELECTION_SCHEMA, productId: variant.productId,
      catalogItemId: line.catalogItemId, selections: variant.selections, fulfillment: variant.fulfillment });
    lines.push({ ...line, name: quoted.name, unitPrice: quoted.unitPrice });
    if (quoted.stock) {
      stock ??= { operationId: attemptId, binding: quote.inventory!, requirements: [] };
      const existing = stock.requirements.find(r => r.skuId === quoted.stock!.skuId);
      if (existing) {
        existing.quantity += line.quantity;
        existing.allowBackorders &&= quoted.stock.allowBackorders;
        if (!Number.isSafeInteger(existing.quantity)) fail("Invalid quantity");
      } else stock.requirements.push({ skuId: quoted.stock.skuId, quantity: line.quantity, allowBackorders: quoted.stock.allowBackorders });
    }
  }
  let pricing;
  if (e.pricing) pricing = await composeCheckoutPricing(lines, cart, attemptId, couponCode, e);
  else if (couponCode !== undefined) fail("Pricing composition is unavailable");
  const minor = lines.reduce((sum, line) => sum + parseMinorUnits(line.unitPrice.minor) * BigInt(line.quantity), 0n).toString();
  const total = pricing?.snapshot.finalTotal ?? normalizeMoney({ currency: "USD", minor });
  return {
    attemptId,
    cart,
    contactSnapshot,
    ...(selections.length ? { variantSelections: selections } : {}),
    payment: createCurrentPaymentRequest({
    attemptId, bindingRef: e.paymentBindingRef, lines, total,
    ...(pricing ? { pricing: pricing.snapshot } : {}),
    }),
    ...(stock ? { stock } : {}),
    ...(pricing?.couponId ? { coupon: { couponId: pricing.couponId, code: pricing.couponCode!, status: "unreserved" as const } } : {}),
    phase: "reserving",
  };
}



/** cartId is a server-owned, tenant-scoped guest capability; never accept arbitrary browser IDs. */
export async function startCheckout(e: CheckoutExecution, cartId: string, rawCart: unknown, retryAfter?: string): Promise<CheckoutAttempt> {
  if (!cartId.trim()) fail("Invalid cart identity");
  if (!Array.isArray(rawCart) && (!rawCart || typeof rawCart !== "object")) fail("Invalid cart");
  const requestedCouponCode = rawCart && typeof rawCart === "object" && !Array.isArray(rawCart)
    ? (["contact,couponCode,lines", "contact,lines", "couponCode,lines", "lines"].includes(sortedKeys(rawCart)))
      ? (Object.prototype.hasOwnProperty.call(rawCart, "couponCode")
        ? typeof (rawCart as { couponCode?: unknown }).couponCode === "string"
          ? normalizeCouponCode((rawCart as { couponCode: string }).couponCode) : fail("Invalid cart coupon")
        : undefined)
      : fail("Invalid cart")
    : undefined;
  const cart = cartInput(Array.isArray(rawCart) ? rawCart : (rawCart as { lines: unknown }).lines);
  for (let tries = 0; tries < 20; tries++) {
    const stored = await e.store.read(cartId);
    const previous = stored ? current(stored.record.attempts) : undefined;
    if (previous && previous.phase !== "released") {
      if (JSON.stringify(previous.cart) !== JSON.stringify(cart)) fail("Active checkout cart is frozen");
      const requested = requestedCouponCode === undefined ? undefined : normalizeCouponCode(requestedCouponCode);
      if ((previous.coupon?.code ?? undefined) !== requested) fail("Active checkout coupon selection is frozen");
      return drive(e, cartId, previous.attemptId, true);
    }
    if (previous && retryAfter !== previous.attemptId) fail("Retry requires the released attempt identity");
    if (!previous && retryAfter !== undefined) fail("Retry checkout not found");
    const attempt = await freeze(
      cart,
      e,
      requestedCouponCode,
      rawCart && typeof rawCart === "object" && !Array.isArray(rawCart)
        ? (rawCart as { contact?: unknown }).contact
        : undefined,
    );
    if (e.paymentAssociations && !await e.paymentAssociations.claim({
      recordKind: "checkout-payment-association",
      attemptId: attempt.attemptId,
      cartId,
      bindingRef: attempt.payment.bindingRef,
    })) {
      continue;
    }
    if (stored?.record.attempts.some(a => a.attemptId === attempt.attemptId)) fail("Attempt identity reused");
    if (await e.store.compareAndSet(cartId, stored?.version ?? null, { attempts: [...(stored?.record.attempts ?? []), attempt] })) {
      return drive(e, cartId, attempt.attemptId, true);
    }
  }
  return fail("Checkout contention; retry");
}

/** An authenticated webhook consumer passes only identity; payloads/success pages are never authority. */
export async function reconcileCheckout(e: CheckoutExecution, cartId: string, attemptId: string): Promise<CheckoutAttempt> {
  return drive(e, cartId, attemptId, false);
}

function samePaymentSession(left: PaymentSession, right: PaymentSession): boolean {
  return left.sessionId === right.sessionId && left.redirectUrl === right.redirectUrl &&
    left.createdAt === right.createdAt && left.expiresAt === right.expiresAt;
}

function freezeContactSnapshot(
  snapshot: CheckoutContactSnapshot | undefined,
): CheckoutContactSnapshot | undefined {
  if (!snapshot) return undefined;
  return Object.freeze({
    schema: snapshot.schema,
    contact: Object.freeze({
      email: `${snapshot.contact.email}`,
      ...(snapshot.contact.phone === undefined ? {} : { phone: `${snapshot.contact.phone}` }),
      ...(snapshot.contact.delivery ? { delivery: Object.freeze({ ...snapshot.contact.delivery }) } : {}),
    }),
    requirePhoneNumber: snapshot.requirePhoneNumber,
    revision: snapshot.revision === null ? null : `${snapshot.revision}`,
  });
}
function validateOutcome(value: PaymentOutcome, attempt: CheckoutAttempt): void {
  if (value.outcome === "unknown") return;
  if (value.attemptId !== attempt.attemptId) fail("Payment identity mismatch");
  if (value.outcome === "not-created") {
    if (attempt.session) fail("Known payment session cannot be not-created");
    return;
  }
  const total = normalizeMoney(value.total);
  if (total.currency !== attempt.payment.total.currency || total.minor !== attempt.payment.total.minor) fail("Payment total mismatch");
  const s = value.session;
  if (!providerSessionWindowIsValid(s, attempt.payment)) fail("Invalid payment window");
  let url: URL;
  try { url = new URL(s.redirectUrl); } catch { return fail("Invalid payment redirect"); }
  if (url.protocol !== "https:" || url.username || url.password) fail("Invalid payment redirect");
  if (attempt.session && !samePaymentSession(attempt.session, s)) fail("Payment session changed");
  if (value.outcome === "paid" && !value.paymentId) fail("Missing payment identity");
}

function couponOwner(e: CheckoutExecution) {
  if (!e.pricing?.coupons) throw new Error("Coupon owner unavailable");
  return e.pricing.coupons.owner();
}

async function reconcileCoupon(
  e: CheckoutExecution,
  attempt: CheckoutAttempt,
  result: "paid" | "released",
): Promise<void> {
  if (!attempt.coupon) return;
  const owner = couponOwner(e);
  if (result === "paid") {
    if (attempt.payment.total.currency === "USD" && attempt.payment.total.minor === "0") {
      const quote = attempt.payment.pricing?.coupon?.quote;
      if (!quote || !attempt.order || attempt.order.paymentId !== undefined) {
        throw new Error("Free checkout lacks canonical coupon proof");
      }
      await owner.reconcileFreeOrder({
        couponId: attempt.coupon.couponId,
        attemptId: attempt.attemptId,
        proof: {
          kind: "verified-free-order",
          attemptId: attempt.attemptId,
          couponId: attempt.coupon.couponId,
          ruleId: quote.ruleId,
          ruleVersion: quote.ruleVersion,
          quoteId: quote.quoteId,
          orderId: attempt.order.orderId,
          receiptId: attempt.order.receiptId,
          overallPayableTotal: { currency: "USD", minor: "0" },
        },
      });
      return;
    }
    if (!attempt.session) throw new Error("Paid checkout has no payment session");
    await owner.reconcile(attempt.coupon.couponId, attempt.attemptId, {
      kind: "verified-success",
      providerSessionId: attempt.session.sessionId,
    });
    return;
  }
  if (attempt.paymentReleaseReason === "never-started") {
    await owner.releaseUnstarted({ couponId: attempt.coupon.couponId, attemptId: attempt.attemptId,
      quote: attempt.payment.pricing!.coupon!.quote, overallPayableTotal: attempt.payment.total });
    return;
  }
  await owner.reconcile(attempt.coupon.couponId, attempt.attemptId,
    attempt.session
      ? { kind: "confirmed-cancel", providerSessionId: attempt.session.sessionId }
      : { kind: "verified-not-created" });
}

async function persistCouponStatus(
  e: CheckoutExecution,
  cartId: string,
  attemptId: string,
  status: "released" | "consumed",
): Promise<CheckoutAttempt | null> {
  for (let retry = 0; retry < 20; retry += 1) {
    const stored = await e.store.read(cartId);
    if (!stored) return null;
    const index = stored.record.attempts.findIndex((candidate) => candidate.attemptId === attemptId);
    if (index < 0) return null;
    const current = stored.record.attempts[index];
    if (!current.coupon || current.coupon.status !== "pending") return current;
    const next = structuredClone(current);
    next.coupon!.status = status;
    const attempts = [...stored.record.attempts];
    attempts[index] = next;
    if (await e.store.compareAndSet(cartId, stored.version, { attempts })) return next;
  }
  return null;
}

async function finishPaid(e: CheckoutExecution, cartId: string, attempt: CheckoutAttempt): Promise<CheckoutAttempt> {
  await handOffPaidOrder(e, attempt);
  if (attempt.coupon?.status === "pending") {
    try {
      await reconcileCoupon(e, attempt, "paid");
      return await persistCouponStatus(e, cartId, attempt.attemptId, "consumed") ?? attempt;
    } catch { return attempt; }
  }
  return attempt;
}

function reserveTicketIds(result: unknown, lines: number): readonly string[] | null | "rejected" | "unknown" {
  if (result === "unknown") return "unknown";
  if (result === "rejected") return "rejected";
  if (result === "reserved") return null;
  if (!isRecord(result)) fail("Invalid reservation outcome");
  const value = result as { outcome?: unknown; ticketIds?: unknown };
  if (value.outcome !== "reserved" || !Array.isArray(value.ticketIds)) fail("Invalid reservation outcome");
  const ids = value.ticketIds;
  if (ids.length !== lines || new Set(ids).size !== ids.length) fail("Invalid reservation outcome");
  for (const id of ids) if (typeof id !== "string" || !id.trim() || id !== id.trim()) fail("Invalid reservation outcome");
  return ids;
}
function release(next: CheckoutAttempt, reason: NonNullable<CheckoutAttempt["paymentReleaseReason"]>): void {
  next.phase = "releasing";
  next.paymentReleaseReason = reason;
}
function completeOrder(e: CheckoutExecution, next: CheckoutAttempt, attempt: CheckoutAttempt, attemptId: string, paymentId?: string): void {
  next.phase = "paid";
  next.order = {
    orderId: "order:" + attemptId, receiptId: "receipt:" + attemptId, attemptId,
    ...(paymentId === undefined ? {} : { paymentId }),
    paidAt: new Date((e.now?.() ?? Date.now() / 1000) * 1000).toISOString(),
    lines: attempt.payment.lines, total: attempt.payment.total,
    ...(attempt.payment.pricing ? { pricing: structuredClone(attempt.payment.pricing) } : {}),
    ...(attempt.variantSelections ? { variantSelections: structuredClone(attempt.variantSelections) } : {}),
    ...(attempt.ticketIds ? { ticketIds: [...attempt.ticketIds] } : {}),
    ...(next.contactSnapshot ? { contactSnapshot: next.contactSnapshot } : {}),
  };
}

async function drive(e: CheckoutExecution, cartId: string, attemptId: string, create: boolean): Promise<CheckoutAttempt> {
  for (let tries = 0; tries < 20; tries++) {
    const stored = await e.store.read(cartId);
    if (!stored) fail("Checkout not found");
    const index = stored.record.attempts.findIndex(a => a.attemptId === attemptId);
    const attempt = stored.record.attempts[index];
    if (!attempt) fail("Checkout not found");
    if (attempt.phase === "paid") return finishPaid(e, cartId, attempt);
    if (attempt.phase === "released") return attempt;
    const next = structuredClone(attempt);
    if (attempt.contactSnapshot) {
      next.contactSnapshot = freezeContactSnapshot(attempt.contactSnapshot);
    }
    if (attempt.phase === "reserving") {
      if (attempt.stock) {
        const provider = await e.resolveInventory(attempt.stock.binding);
        if (!provider) return attempt;
        let result;
        try { result = await provider.reserve(structuredClone(attempt.stock)); } catch { return attempt; }
        const ticketIds = reserveTicketIds(result, attempt.stock.requirements.length);
        if (ticketIds === "unknown") return attempt;
        if (ticketIds === "rejected") {
          next.phase = next.coupon ? "releasing" : "released";
          next.paymentReleaseReason = "never-started";
        } else {
          if (ticketIds) next.ticketIds = ticketIds;
          next.phase = "paying";
        }
      } else next.phase = "paying";
      if (next.phase === "paying" && next.coupon?.status === "unreserved") {
        try {
          const owner = couponOwner(e);
          const reservation = await owner.reserve({
            couponId: next.coupon.couponId,
            attemptId: next.attemptId,
            quote: next.payment.pricing!.coupon!.quote as CouponQuote,
            overallPayableTotal: next.payment.total as { currency: "USD"; minor: string },
            now: new Date((e.now?.() ?? Date.now() / 1000) * 1000).toISOString(),
          });
          if (reservation.state !== "pending") {
            release(next, "never-started");
            next.coupon.refused = "not-applicable";
          } else next.coupon.status = "pending";
        } catch (error) {
          if (error instanceof CouponRedemptionError &&
              ["CAPACITY_EXHAUSTED", "INVALID_INPUT", "CONFLICTING_ATTEMPT", "TERMINAL_CONFLICT"].includes(error.code)) {
            release(next, "never-started");
            next.coupon.refused = error.code === "CAPACITY_EXHAUSTED" ? "used-up"
              : error.code === "INVALID_INPUT" ? "not-applicable" : "try-later";
          } else {
            return attempt;
          }
        }
      }
    } else if (attempt.phase === "releasing") {
      if (next.coupon && next.coupon.status !== "released") {
        try {
          await reconcileCoupon(e, next, "released");
          next.coupon.status = "released";
        } catch {
          return attempt;
        }
      }
      if (attempt.stock) {
        const provider = await e.resolveInventory(attempt.stock.binding);
        if (!provider) return attempt;
        let result;
        try { result = await provider.release(structuredClone(attempt.stock)); } catch { return attempt; }
        if (result !== "released") return attempt;
      }
      next.phase = "released";
    } else {
      if (attempt.payment.total.currency === "USD" && attempt.payment.total.minor === "0") {
        completeOrder(e, next, attempt, attemptId);
      } else {
        // Current host support is not an authoritative provider creation fence.
        if (attempt.payment.pricing && e.pricing?.paymentPricingSchema !== CHECKOUT_PRICING_SCHEMA) return attempt;
        let outcome: PaymentOutcome;
        try {
          const payments = await e.resolvePayments(attempt.payment.bindingRef);
          if (!payments || attempt.payment.pricing && payments.pricingSchema !== CHECKOUT_PRICING_SCHEMA) return attempt;
          outcome = await (create ? payments.ensureSession(structuredClone(attempt.payment)) : payments.lookup(structuredClone(attempt.payment)));
        } catch { return attempt; }
        validateOutcome(outcome, attempt);
        if (outcome.outcome === "unknown") return attempt;
        if (outcome.outcome === "not-created") {
          release(next, "not-created");
        }
        else {
          if (attempt.coupon) {
            try {
              const owner = couponOwner(e);
              await owner.attachProviderSession(attempt.coupon.couponId, attempt.attemptId, outcome.session.sessionId);
            } catch {
              return attempt;
            }
          }
          next.session = outcome.session;
          if (outcome.outcome === "paid") {
            completeOrder(e, next, attempt, attemptId, outcome.paymentId);
          } else if (outcome.outcome === "expired-unpaid") {
            release(next, "expired-unpaid");
          }
        }
      }
    }
    const attempts = [...stored.record.attempts];
    attempts[index] = next;
    if (await e.store.compareAndSet(cartId, stored.version, { attempts })) {
      if (next.phase === "paying" && next.session) {
        // A local clock can suppress an old redirect but never authorize release.
        if ((e.now ?? (() => Date.now() / 1000))() >= next.session.expiresAt) return { ...next, session: undefined };
        return next;
      }
      if (next.phase === "paid") return finishPaid(e, cartId, next);
      if (next.phase === "released") return next;
    }
  }
  return fail("Checkout contention; retry");
}
