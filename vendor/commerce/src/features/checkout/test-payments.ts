import { CHECKOUT_PRICING_SCHEMA } from "./types.js";
import { isCurrentPaymentRequest } from "./payment-window.js";
import { normalizeMoney } from "../catalog/kernel/index.js";
import { normalizeCouponCode } from "../coupons/index.js";
import type {
  CheckoutPaymentPort,
  CurrentPaymentRequest,
  GuestCheckoutHostOptions,
  LegacyExact1800PaymentRequest,
  PaymentOutcome,
  PaymentRequest,
} from "./types.js";
import { canonicalizeHttpOrigin } from "./site-scope.js";

export type ScopedPaymentFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface TrustedTestPaymentsConfig {
  paymentsOrigin: string;
  siteId: string;
  commerceOrigin: string;
  bindingRef: string;
  providerId: "stripe";
  stripeAccountId: string;
  credentialResolver: () => Promise<string>;
  fetch: ScopedPaymentFetch;
  pricingSchema?: typeof CHECKOUT_PRICING_SCHEMA;
  /**
   * Coupon quote validation for entries that bind coupon support. Without
   * it, a request carrying a coupon is malformed.
   */
  validateCouponQuoteSnapshot?: (value: unknown, name: string) => void;
}

interface PaymentBinding {
  bindingRef: string;
  providerId: string;
  stripeAccountId: string;
  mode: string;
  ready?: boolean;
}

function invalid(message: string): never {
  throw new Error(`Invalid trusted TEST Payments configuration: ${message}`);
}

function origin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.pathname !== "/" && parsed.pathname !== "" ||
      parsed.search || parsed.hash || !parsed.hostname) {
    return invalid(`${name} must be a bare HTTPS origin`);
  }
  return parsed.origin;
}

function commerceOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("commerceOrigin must be an absolute HTTP(S) origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" ||
      parsed.username || parsed.password || parsed.pathname !== "/" && parsed.pathname !== "" ||
      parsed.search || parsed.hash || !parsed.hostname) {
    return invalid("commerceOrigin must be a bare HTTP(S) origin");
  }
  const normalized = canonicalizeHttpOrigin(value);
  if (!normalized) return invalid("commerceOrigin must be a bare HTTP(S) origin");
  return normalized;
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${name} is required`);
  return value.trim();
}

function assertTestBinding(value: unknown, expected: TrustedTestPaymentsConfig): PaymentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payments binding unavailable");
  }
  const binding = value as Partial<PaymentBinding>;
  if (binding.bindingRef !== expected.bindingRef ||
      binding.providerId !== "stripe" ||
      expected.providerId !== "stripe" ||
      binding.stripeAccountId !== expected.stripeAccountId ||
      binding.mode !== "test") {
    throw new Error("Payments binding mismatch");
  }
  return binding as PaymentBinding;
}

function outcome(value: unknown): PaymentOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Payments outcome");
  }
  const result = value as PaymentOutcome;
  if (result.outcome === "unknown" || result.outcome === "not-created") return result;
  if (result.outcome !== "open" && result.outcome !== "paid" && result.outcome !== "expired-unpaid") {
    throw new Error("Malformed Payments outcome");
  }
  return result;
}

function assertPricing(
  request: PaymentRequest,
  validateCouponQuoteSnapshot: TrustedTestPaymentsConfig["validateCouponQuoteSnapshot"],
): void {
  const pricing = request.pricing;
  if (!pricing) return;
  const minor = (value: unknown) => BigInt(normalizeMoney(value).minor);
  const check = (valid: boolean) => { if (!valid) throw new Error("Malformed payment pricing"); };
  try {
    const subtotal = minor(pricing.merchandiseSubtotal);
    const discount = minor(pricing.couponDiscount);
    const net = minor(pricing.netMerchandise);
    const shipping = minor(pricing.shipping.charge);
    const final = minor(pricing.finalTotal);
    check(subtotal - discount === net && net + shipping === final && final > 0n && minor(request.total) === final);
    check(typeof pricing.shipping.configurationId === "string" && !!pricing.shipping.configurationId.trim() &&
      Number.isSafeInteger(pricing.shipping.revision) && pricing.shipping.revision >= 1 &&
      (pricing.shipping.mode === "flat" || pricing.shipping.mode === "free" && shipping === 0n));
    check(Array.isArray(pricing.lines) && pricing.lines.length === request.lines.length && pricing.lines.length > 0);
    let sumSubtotal = 0n, sumDiscount = 0n, sumNet = 0n;
    for (const [index, line] of pricing.lines.entries()) {
      const original = request.lines[index];
      check(typeof original.catalogItemId === "string" && !!original.catalogItemId.trim() &&
        Number.isSafeInteger(original.quantity) && original.quantity > 0 &&
        line.catalogItemId === original.catalogItemId && line.quantity === original.quantity &&
        minor(line.unitPrice) === minor(original.unitPrice));
      const lineSubtotal = minor(line.lineSubtotal), lineDiscount = minor(line.discount), lineNet = minor(line.netAmount);
      check(lineSubtotal === minor(original.unitPrice) * BigInt(original.quantity) &&
        lineSubtotal - lineDiscount === lineNet);
      sumSubtotal += lineSubtotal; sumDiscount += lineDiscount; sumNet += lineNet;
    }
    check(sumSubtotal === subtotal && sumDiscount === discount && sumNet === net);
    if (pricing.coupon) {
      if (!validateCouponQuoteSnapshot) throw new Error("Coupon validation unavailable");
      check(normalizeCouponCode(pricing.coupon.code) === pricing.coupon.code);
      const quote = pricing.coupon.quote;
      validateCouponQuoteSnapshot(quote, "payment pricing coupon");
      check(minor(quote.merchandiseTotal) === subtotal && minor(quote.discount) === discount &&
        minor(quote.payableMerchandiseTotal) === net && minor(quote.overallPayableTotal) === final &&
        quote.lines.length === pricing.lines.length);
      for (const [index, line] of quote.lines.entries()) {
        const priced = pricing.lines[index];
        check(line.productId === priced.catalogItemId && line.quantity === priced.quantity &&
          minor(line.unitPrice) === minor(priced.unitPrice) && minor(line.lineSubtotal) === minor(priced.lineSubtotal) &&
          minor(line.discount) === minor(priced.discount));
      }
    } else check(discount === 0n);
  } catch {
    throw new Error("Malformed payment pricing");
  }
}

function exactRequest(
  request: PaymentRequest,
  bindingRef: string,
  validateCouponQuoteSnapshot?: TrustedTestPaymentsConfig["validateCouponQuoteSnapshot"],
): PaymentRequest {
  const copy = structuredClone(request);
  if (copy.bindingRef !== request.bindingRef ||
      copy.bindingRef !== bindingRef ||
      !Array.isArray(copy.lines) ||
      copy.paymentMethods.length !== 1 ||
      copy.paymentMethods[0] !== "card") {
    throw new Error("Malformed payment request");
  }
  if (copy.pricing && (copy.pricing.schema !== CHECKOUT_PRICING_SCHEMA || !isCurrentPaymentRequest(copy))) {
    throw new Error("Unsupported payment pricing request");
  }
  assertPricing(copy, validateCouponQuoteSnapshot);
  return copy;
}

function normalizedConfig(
  input: TrustedTestPaymentsConfig,
): Readonly<TrustedTestPaymentsConfig> {
  if (input.providerId !== "stripe") invalid("providerId must be stripe");
  if (input.pricingSchema !== undefined && input.pricingSchema !== CHECKOUT_PRICING_SCHEMA) invalid("unsupported pricing schema");
  return Object.freeze({
    paymentsOrigin: origin(input.paymentsOrigin, "paymentsOrigin"),
    commerceOrigin: commerceOrigin(input.commerceOrigin),
    siteId: nonEmpty(input.siteId, "siteId"),
    bindingRef: nonEmpty(input.bindingRef, "bindingRef"),
    providerId: "stripe",
    stripeAccountId: nonEmpty(input.stripeAccountId, "stripeAccountId"),
    credentialResolver: input.credentialResolver,
    fetch: input.fetch,
    pricingSchema: input.pricingSchema,
    validateCouponQuoteSnapshot: input.validateCouponQuoteSnapshot,
  });
}

const MAX_PAYMENT_RESPONSE_BYTES = 131072;
function malformedResponse(): never { throw new Error("Malformed Payments response"); }

/** Shared finite-body reader for authenticated Payments responses. */
export async function readBoundedPaymentsJson(response: Response): Promise<unknown> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    malformedResponse();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        try { await reader.cancel(); } catch { /* fail closed */ }
        malformedResponse();
      }
      byteLength += result.value.byteLength;
      if (byteLength > MAX_PAYMENT_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* fail closed */ }
        malformedResponse();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    malformedResponse();
  }
}

function createPaymentPort(
  config: Readonly<TrustedTestPaymentsConfig>,
): CheckoutPaymentPort {
  if (typeof config.credentialResolver !== "function" || typeof config.fetch !== "function") {
    invalid("credentialResolver and fetch are required");
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    body?: PaymentRequest,
  ): Promise<unknown> {
    const credential = await config.credentialResolver();
    if (typeof credential !== "string" || !credential.trim()) {
      throw new Error("Payments credential unavailable");
    }
    const response = await config.fetch(`${config.paymentsOrigin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "x-dinkus-site": config.siteId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Payments transport unavailable");
    try {
      return await readBoundedPaymentsJson(response);
    } catch {
      malformedResponse();
    }
  }

  async function binding(path: "/v1/checkout-binding" | "/v1/existing-binding"): Promise<PaymentBinding> {
    return assertTestBinding(
      await call("GET", `${path}?bindingRef=${encodeURIComponent(config.bindingRef)}`),
      config,
    );
  }

  async function requestOutcome(request: PaymentRequest, create: boolean): Promise<PaymentOutcome> {
    const exact = exactRequest(request, config.bindingRef, config.validateCouponQuoteSnapshot);
    if (exact.pricing && config.pricingSchema !== CHECKOUT_PRICING_SCHEMA) {
      throw new Error("Payments pricing schema unsupported");
    }
    const ready = await binding(create ? "/v1/checkout-binding" : "/v1/existing-binding");
    if (create && ready.ready === false) throw new Error("Payments binding unavailable");
    return outcome(await call("POST", create ? "/v1/checkout/session" : "/v1/checkout/lookup", exact));
  }
  const ensureSession = (request: PaymentRequest) => requestOutcome(request, true);
  const lookup = (request: PaymentRequest) => requestOutcome(request, false);

  return Object.freeze({ ensureSession, lookup, ...(config.pricingSchema ? { pricingSchema: config.pricingSchema } : {}) });
}

export function createTrustedTestPaymentPort(
  input: TrustedTestPaymentsConfig,
): CheckoutPaymentPort {
  return createPaymentPort(normalizedConfig(input));
}

export interface TrustedTestPaymentsCheckoutHost extends GuestCheckoutHostOptions {
  siteUrl: string;
  paymentBindingRef: string;
  resolvePayments: NonNullable<GuestCheckoutHostOptions["resolvePayments"]>;
}

/** Native host assembly. Descriptor JSON cannot carry these functions. */
export function createTrustedTestPaymentsCheckoutHost(
  input: TrustedTestPaymentsConfig,
): TrustedTestPaymentsCheckoutHost {
  const config = normalizedConfig(input);
  const port = createPaymentPort(config);
  return Object.freeze({
    siteUrl: config.commerceOrigin,
    paymentBindingRef: config.bindingRef,
    resolvePayments: async (bindingRef: string) =>
      bindingRef === config.bindingRef ? port : null,
  });
}

export type TrustedPaymentRequest =
  | CurrentPaymentRequest
  | LegacyExact1800PaymentRequest;
