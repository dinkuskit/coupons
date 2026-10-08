import { GuestCheckoutError, guestCheckoutErrorMessage } from "./errors.js";
import { startCheckout, reconcileCheckout } from "./orchestrate.js";
import { authorizeGuestCapability, mintGuestCapability, readGuestCapabilityHeader } from "./capability.js";
import { projectGuestCheckout, projectPreparedGuestCheckout } from "./project.js";
import { createCheckoutStore } from "./storage.js";
import { reconcilePaymentWakes } from "./wake.js";
import { resolveTrustedSiteOrigin } from "./site-scope.js";
import type {
  CartLine,
  CheckoutAttempt,
  GuestCheckoutHostOptions,
  GuestCheckoutResult,
  GuestCheckoutRuntime,
} from "./types.js";
import type { CommercePaymentWakePort } from "./wake.js";

function fail(code: GuestCheckoutError["code"]): never {
  throw new GuestCheckoutError(code);
}

const MAX_GUEST_CART_LINES = 100;
const MAX_GUEST_CART_ITEM_ID_LENGTH = 256;
const MAX_GUEST_QUANTITY = 1_000_000;
const MAX_GUEST_COUPON_LENGTH = 128;
const MAX_GUEST_ATTEMPT_ID_LENGTH = 256;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CART");
  return value as Record<string, unknown>;
}

export function admitGuestCheckoutPrepareInput(raw: unknown): void {
  const input = raw === undefined ? {} : asObject(raw);
  if (Object.keys(input).length !== 0) fail("INVALID_CART");
}

export function admitGuestCheckoutStartInput(raw: unknown): CartLine[] {
  const input = asObject(raw);
  if (Object.keys(input).join() !== "lines") fail("INVALID_CART");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_GUEST_CART_LINES) {
    fail("INVALID_CART");
  }
  return input.lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) fail("INVALID_CART");
    const keys = Object.keys(line).sort().join();
    if (keys !== "catalogItemId,quantity") fail("INVALID_CART");
    const catalogItemId = (line as { catalogItemId: unknown }).catalogItemId;
    const quantity = (line as { quantity: unknown }).quantity;
    if (typeof catalogItemId !== "string" || !catalogItemId.trim() ||
        catalogItemId.length > MAX_GUEST_CART_ITEM_ID_LENGTH) fail("INVALID_CART");
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0 ||
        (quantity as number) > MAX_GUEST_QUANTITY) fail("INVALID_CART");
    return { catalogItemId: catalogItemId.trim(), quantity: quantity as number };
  });
}

export function admitGuestCheckoutPricingStartInput(raw: unknown): CartLine[] | { lines: CartLine[]; couponCode?: string } {
  const input = asObject(raw);
  const keys = Object.keys(input).sort();
  if (keys.join() !== "lines" && keys.join() !== "couponCode,lines") fail("INVALID_CART");
  const lines = admitGuestCheckoutStartInput({ lines: input.lines });
  if (keys.join() === "lines") return lines;
  if (typeof input.couponCode !== "string" || !input.couponCode.trim() ||
      input.couponCode.length > MAX_GUEST_COUPON_LENGTH) fail("INVALID_CART");
  return { lines, couponCode: input.couponCode.trim() };
}

export function admitGuestCheckoutStatusInput(raw: unknown): { attemptId?: string } {
  const input = raw === undefined ? {} : asObject(raw);
  const inputKeys = Object.keys(input).sort().join();
  if (inputKeys === "") return {};
  const wakeOnly = inputKeys === "wake";
  const attemptOnly = inputKeys === "attemptId";
  const documentedHint = inputKeys === "attemptId,wake";
  if (!wakeOnly && !attemptOnly && !documentedHint) fail("INVALID_CART");
  if ((wakeOnly || documentedHint) && input.wake !== true) fail("INVALID_CART");
  if (attemptOnly || documentedHint) {
    if (typeof input.attemptId !== "string" || !input.attemptId.trim() ||
        input.attemptId.length > MAX_GUEST_ATTEMPT_ID_LENGTH) fail("INVALID_CART");
    return { attemptId: input.attemptId.trim() };
  }
  return {};
}

function mapCheckoutError(error: unknown): never {
  if (error instanceof GuestCheckoutError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/Invalid cart|Invalid quantity|Zero-total/i.test(message)) fail("INVALID_CART");
  if (/frozen/i.test(message)) fail("CHECKOUT_FROZEN");
  if (/Retry requires/i.test(message)) fail("RETRY_REQUIRED");
  if (/Retry checkout not found|Checkout not found/i.test(message)) fail("CHECKOUT_NOT_FOUND");
  if (/Product unavailable|Product unpriced/i.test(message)) fail("PRODUCT_UNAVAILABLE");
  if (/Inventory/i.test(message)) fail("INVENTORY_UNAVAILABLE");
  if (/Payment binding/i.test(message)) fail("PAYMENTS_UNAVAILABLE");
  if (/contention/i.test(message)) fail("CONTENTION");
  fail("UNAVAILABLE");
}

function paymentsReady(host: GuestCheckoutHostOptions): boolean {
  return Boolean(host.paymentBindingRef?.trim() && host.resolvePayments);
}

export function executionOf(runtime: GuestCheckoutRuntime) {
  if (!paymentsReady(runtime.host)) fail("PAYMENTS_UNAVAILABLE");
  return {
    store: createCheckoutStore(runtime.carts),
    catalog: runtime.catalog,
    availability: { resolveProvider: runtime.host.resolveAvailabilityProvider },
    resolveInventory: runtime.host.resolveInventory ?? (async () => null),
    paymentAssociations: runtime.paymentAssociations,
    paymentBindingRef: runtime.host.paymentBindingRef!.trim(),
    resolvePayments: runtime.host.resolvePayments!,
    createAttemptId: runtime.host.createAttemptId,
    now: runtime.host.now,
    pricing: runtime.pricing,
  };
}

/**
 * Trusted host-only wake seam. The caller supplies a Payments-owned list/ack
 * port; Commerce supplies its bound storage and canonical order writer.
 */
export async function reconcileGuestPaymentWakes(
  runtime: GuestCheckoutRuntime,
  wakes: CommercePaymentWakePort,
) {
  const resolved = resolveTrustedSiteOrigin({
    constructorSiteUrl: runtime.constructorSiteUrl ?? runtime.host.siteUrl,
    runtimeSiteUrl: runtime.runtimeSiteUrl ?? runtime.siteUrl,
    topLevelSiteUrl: runtime.topLevelSiteUrl ?? runtime.host.topLevelSiteUrl,
    checkoutSiteUrl: runtime.checkoutSiteUrl ?? runtime.host.checkoutSiteUrl,
  });
  if (!resolved.ok || runtime.siteUrl !== resolved.origin ||
      !runtime.paymentAssociations || !paymentsReady(runtime.host)) {
    fail("UNAVAILABLE");
  }
  return reconcilePaymentWakes(executionOf(runtime), runtime.paymentAssociations, wakes);
}

function currentAttempt(attempts: CheckoutAttempt[]): CheckoutAttempt | undefined {
  return attempts[attempts.length - 1];
}

function guestSafeResult(error: unknown): GuestCheckoutResult {
  if (error instanceof GuestCheckoutError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  try {
    mapCheckoutError(error);
  } catch (mapped) {
    if (mapped instanceof GuestCheckoutError) {
      return { ok: false, error: { code: mapped.code, message: mapped.message } };
    }
  }
  return { ok: false, error: { code: "UNAVAILABLE", message: guestCheckoutErrorMessage("UNAVAILABLE") } };
}

export async function prepareGuestCheckout(
  runtime: GuestCheckoutRuntime,
  input?: unknown,
): Promise<GuestCheckoutResult> {
  try {
    admitGuestCheckoutPrepareInput(input);
    const minted = await mintGuestCapability(runtime);
    return {
      ok: true,
      capabilityId: minted.record.capabilityId,
      capability: minted.presentation,
      checkout: projectPreparedGuestCheckout(),
    };
  } catch (error) {
    return guestSafeResult(error);
  }
}

function projected(capabilityId: string, attempt: CheckoutAttempt | undefined, now: number): GuestCheckoutResult {
  return { ok: true, capabilityId, checkout: projectGuestCheckout(attempt, now) };
}

export async function startGuestCheckout(
  runtime: GuestCheckoutRuntime,
  input: unknown,
  headers?: Headers | Record<string, string>,
): Promise<GuestCheckoutResult> {
  try {
    const admitted = runtime.host.pricing
      ? admitGuestCheckoutPricingStartInput(input)
      : admitGuestCheckoutStartInput(input);
    const authorized = await authorizeGuestCapability(
      runtime,
      readGuestCapabilityHeader(headers),
    );
    if (!paymentsReady(runtime.host)) fail("PAYMENTS_UNAVAILABLE");
    const store = createCheckoutStore(runtime.carts);
    const existing = await store.read(authorized.cartId);
    const previous = existing ? currentAttempt(existing.record.attempts) : undefined;
    const retryAfter =
      previous?.phase === "released" ? previous.attemptId : undefined;
    const attempt = await startCheckout(executionOf(runtime), authorized.cartId, admitted, retryAfter);
    const currentNow = runtime.host.now?.() ?? Math.floor(Date.now() / 1000);
    return projected(authorized.capabilityId, attempt, currentNow);
  } catch (error) {
    return guestSafeResult(error);
  }
}

export async function statusGuestCheckout(
  runtime: GuestCheckoutRuntime,
  input: unknown,
  headers?: Headers | Record<string, string>,
): Promise<GuestCheckoutResult> {
  try {
    const admitted = admitGuestCheckoutStatusInput(input);
    const authorized = await authorizeGuestCapability(
      runtime,
      readGuestCapabilityHeader(headers),
    );
    const currentNow = runtime.host.now?.() ?? Math.floor(Date.now() / 1000);
    if (!paymentsReady(runtime.host)) {
      const stored = await createCheckoutStore(runtime.carts).read(authorized.cartId);
      return projected(authorized.capabilityId, currentAttempt(stored?.record.attempts ?? []), currentNow);
    }
    const stored = await createCheckoutStore(runtime.carts).read(authorized.cartId);
    const current = currentAttempt(stored?.record.attempts ?? []);
    if (!current) fail("CHECKOUT_NOT_FOUND");
    const hinted = admitted.attemptId ?? "";
    if (hinted && !stored?.record.attempts.some((attempt) => attempt.attemptId === hinted)) {
      fail("CHECKOUT_NOT_FOUND");
    }
    const attempt = await reconcileCheckout(
      executionOf(runtime),
      authorized.cartId,
      hinted || current.attemptId,
    );
    return projected(authorized.capabilityId, attempt, currentNow);
  } catch (error) {
    return guestSafeResult(error);
  }
}

export function guestCheckoutFailure(
  code: GuestCheckoutError["code"],
): GuestCheckoutResult {
  return { ok: false, error: { code, message: guestCheckoutErrorMessage(code) } };
}
