import {
  CURRENT_PAYMENT_WINDOW,
  CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
  CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
  LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
  type CurrentPaymentRequest,
  type LegacyExact1800PaymentRequest,
  type PaymentRequest,
  type PaymentRequestHandoff,
  type PaymentSession,
  type PaymentWindowBounds,
} from "./types.js";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isExactCurrentWindow(value: unknown): value is CurrentPaymentRequest["paymentWindow"] {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value).sort();
  if (keys.join() !== "maxSeconds,minSeconds") return false;
  const window = value as { minSeconds: unknown; maxSeconds: unknown };
  return (
    window.minSeconds === CURRENT_PAYMENT_WINDOW_MIN_SECONDS &&
    window.maxSeconds === CURRENT_PAYMENT_WINDOW_MAX_SECONDS
  );
}

export function isCurrentPaymentRequest(request: PaymentRequest): request is CurrentPaymentRequest {
  return hasOwn(request, "paymentWindow") && !hasOwn(request, "paymentWindowSeconds");
}

export function isLegacyExact1800PaymentRequest(
  request: PaymentRequest,
): request is LegacyExact1800PaymentRequest {
  return hasOwn(request, "paymentWindowSeconds") && !hasOwn(request, "paymentWindow");
}

export function createCurrentPaymentRequest(
  input: Omit<CurrentPaymentRequest, "paymentWindow" | "paymentMethods">,
): CurrentPaymentRequest {
  return {
    ...input,
    paymentWindow: { ...CURRENT_PAYMENT_WINDOW },
    paymentMethods: ["card"],
  };
}

export function paymentRequestHandoff(request: PaymentRequest): PaymentRequestHandoff | null {
  if (isLegacyExact1800PaymentRequest(request)) {
    if (request.paymentWindowSeconds !== LEGACY_EXACT_PAYMENT_WINDOW_SECONDS) return null;
    return { kind: "legacy-exact-1800", request };
  }
  if (isCurrentPaymentRequest(request)) {
    if (!isExactCurrentWindow(request.paymentWindow)) return null;
    return { kind: "current-bounded-1800-1860", request };
  }
  return null;
}

export function readFrozenPaymentWindowBounds(request: PaymentRequest): PaymentWindowBounds | null {
  const handoff = paymentRequestHandoff(request);
  if (!handoff) return null;
  if (handoff.kind === "legacy-exact-1800") {
    return {
      kind: "legacy-exact-1800",
      minSeconds: LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
      maxSeconds: LEGACY_EXACT_PAYMENT_WINDOW_SECONDS,
    };
  }
  return {
    kind: "current-bounded-1800-1860",
    minSeconds: CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
    maxSeconds: CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
  };
}

/** Real provider timestamps only. Never invent createdAt or fill a missing expiry. */
export function providerSessionWindowIsValid(session: PaymentSession, request: PaymentRequest): boolean {
  if (typeof session.sessionId !== "string" || !session.sessionId) return false;
  if (!Number.isSafeInteger(session.createdAt)) return false;
  if (!Number.isSafeInteger(session.expiresAt)) return false;
  const duration = session.expiresAt - session.createdAt;
  if (!Number.isSafeInteger(duration)) return false;
  const bounds = readFrozenPaymentWindowBounds(request);
  if (!bounds) return false;
  return duration >= bounds.minSeconds && duration <= bounds.maxSeconds;
}
