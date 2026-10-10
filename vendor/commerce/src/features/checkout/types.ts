import type { StorageCollection } from "emdash";
import type { PaidOrderReceiver } from "../../handoffs/paid-order.js";
import type { CatalogFulfillment, Money } from "../catalog/kernel/index.js";
import type { InventoryProviderBinding } from "../inventory-provider/kernel/index.js";
import type { StorefrontAvailabilityResolverStorage, ResolveStorefrontAvailabilityExecution } from "../storefront-availability/kernel/index.js";
import type { CheckoutCouponPort, CouponNotApplicableReason, CouponQuoteSnapshot } from "../coupons/index.js";
import type {
  CheckoutContactRequirementsLoader,
  CheckoutContactSnapshot,
} from "../checkout-contact/index.js";

export const CHECKOUT_FEATURE_ID = "dinkus.checkout";
export interface CartLine { catalogItemId: string; quantity: number }
export interface CheckoutLine extends CartLine { name: string; unitPrice: Money }
export const CHECKOUT_VARIANT_SELECTION_SCHEMA =
  "dinkuskit.commerce.checkout-variant-selection/v1" as const;
export interface CheckoutVariantSelectionSnapshot {
  schema: typeof CHECKOUT_VARIANT_SELECTION_SCHEMA;
  productId: string;
  catalogItemId: string;
  selections: readonly {
    optionId: string;
    optionLabel: string;
    valueId: string;
    valueLabel: string;
  }[];
  fulfillment: CatalogFulfillment;
}
export const CHECKOUT_PRICING_SCHEMA = "dinkuskit.commerce.checkout-pricing/v1" as const;
export interface CheckoutPricingLine {
  catalogItemId: string;
  quantity: number;
  unitPrice: Money;
  lineSubtotal: Money;
  discount: Money;
  netAmount: Money;
}
export interface CheckoutPricingSnapshot {
  schema: typeof CHECKOUT_PRICING_SCHEMA;
  merchandiseSubtotal: Money;
  couponDiscount: Money;
  netMerchandise: Money;
  shipping: {
    configurationId: string;
    revision: number;
    mode: "free" | "flat";
    charge: Money;
  };
  finalTotal: Money;
  lines: readonly CheckoutPricingLine[];
  coupon?: { code: string; quote: CouponQuoteSnapshot };
}
export interface StockRequirement { skuId: string; quantity: number; allowBackorders: boolean }
export interface StockRequest {
  operationId: string;
  binding: InventoryProviderBinding;
  requirements: StockRequirement[];
}
/**
 * Success may name the tickets this reserve already minted, one per stock line.
 * A string "reserved" is the previous adapter and carries no ids.
 * Rejection and an unknown outcome stay strings.
 */
export type CheckoutReserveResult =
  | "reserved"
  | "rejected"
  | "unknown"
  | { readonly outcome: "reserved"; readonly ticketIds: readonly string[] };
/** Durable whole-basket operation. Never substitute a local stock ledger. */
export interface CheckoutInventoryPort {
  /** Same operation/request forever; terminal rejection has no holds and cannot later succeed. */
  reserve(request: StockRequest): Promise<CheckoutReserveResult>;
  /** Idempotent terminal fence, including an in-flight reserve. No subsequent reacquisition. */
  release(request: StockRequest): Promise<"released" | "unknown">;
}
export const CURRENT_PAYMENT_WINDOW_MIN_SECONDS = 1800;
export const CURRENT_PAYMENT_WINDOW_MAX_SECONDS = 1860;
export const LEGACY_EXACT_PAYMENT_WINDOW_SECONDS = 1800;
export const PAYMENTS_CREATE_RETRY_BOUND_HOURS = 23;
export const PAYMENTS_SAFE_PROVIDER_DELAY_SECONDS = 60;

export const CURRENT_PAYMENT_WINDOW = {
  minSeconds: CURRENT_PAYMENT_WINDOW_MIN_SECONDS,
  maxSeconds: CURRENT_PAYMENT_WINDOW_MAX_SECONDS,
} as const;

export type CurrentPaymentWindow = {
  readonly minSeconds: typeof CURRENT_PAYMENT_WINDOW_MIN_SECONDS;
  readonly maxSeconds: typeof CURRENT_PAYMENT_WINDOW_MAX_SECONDS;
};

export type PaymentWindowPolicyKind =
  | "current-bounded-1800-1860"
  | "legacy-exact-1800";

export interface PaymentWindowBounds {
  readonly kind: PaymentWindowPolicyKind;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

interface PaymentRequestBase {
  attemptId: string;
  /** Immutable server-side merchant/provider binding; never resolve to a replacement account. */
  bindingRef: string;
  lines: CheckoutLine[];
  total: Money;
  paymentMethods: readonly ["card"];
  pricing?: CheckoutPricingSnapshot;
}

/** Current Commerce construction. New attempts use only this shape. */
export interface CurrentPaymentRequest extends PaymentRequestBase {
  paymentWindow: CurrentPaymentWindow;
  paymentWindowSeconds?: never;
}

/**
 * Frozen historical originals only. Replay exactly; never rewrite to
 * `paymentWindow` on retry or restart.
 */
export interface LegacyExact1800PaymentRequest extends PaymentRequestBase {
  paymentWindowSeconds: typeof LEGACY_EXACT_PAYMENT_WINDOW_SECONDS;
  paymentWindow?: never;
  pricing?: never;
}

export type PaymentRequest = CurrentPaymentRequest | LegacyExact1800PaymentRequest;

export type PaymentRequestHandoff =
  | { kind: "current-bounded-1800-1860"; request: CurrentPaymentRequest }
  | { kind: "legacy-exact-1800"; request: LegacyExact1800PaymentRequest };
export interface PaymentSession {
  sessionId: string;
  redirectUrl: string;
  createdAt: number;
  expiresAt: number;
}
export type PaymentOutcome =
  | { outcome: "unknown" }
  | { outcome: "open"; attemptId: string; total: Money; session: PaymentSession }
  | { outcome: "paid"; attemptId: string; total: Money; session: PaymentSession; paymentId: string }
  | { outcome: "expired-unpaid"; attemptId: string; total: Money; session: PaymentSession }
  | { outcome: "not-created"; attemptId: string };
/** Payments owns transport/authenticity and durable processor idempotency, not orders. */
export interface CheckoutPaymentPort {
  /** Explicit version support; absent ports accept only frozen merchandise-only requests. */
  readonly pricingSchema?: typeof CHECKOUT_PRICING_SCHEMA;
  /**
   * Persist the original claim/request/deadline/idempotency key before provider
   * contact. Replay that exact tuple; never reset deadline, alter parameters,
   * send a new key, or lookup-create.
   */
  ensureSession(request: PaymentRequest): Promise<PaymentOutcome>;
  /** Authoritative lookup. Events are hints only. not-created is a terminal creation fence. */
  lookup(request: PaymentRequest): Promise<PaymentOutcome>;
}
interface CommerceOrderBase {
  orderId: string;
  receiptId: string;
  attemptId: string;
  lines: CheckoutLine[];
  total: Money;
  pricing?: CheckoutPricingSnapshot;
  variantSelections?: readonly CheckoutVariantSelectionSnapshot[];
  /** Inventory hold ids from reserve. Absent when the adapter returned a string. */
  ticketIds?: readonly string[];
  contactSnapshot?: CheckoutContactSnapshot;
  /** When Checkout recorded the payment. Absent on orders paid before it was recorded. */
  paidAt?: string;
}
export type CommerceOrder =
  | (CommerceOrderBase & { paymentId: string })
  | (CommerceOrderBase & { paymentId?: never });
export interface CheckoutAttempt {
  attemptId: string;
  cart: CartLine[];
  payment: PaymentRequest;
  stock?: StockRequest;
  phase: "reserving" | "paying" | "releasing" | "released" | "paid";
  session?: PaymentSession;
  order?: CommerceOrder;
  /** Copied onto the order when payment completes. Not an order number in Inventory. */
  ticketIds?: readonly string[];
  variantSelections?: readonly CheckoutVariantSelectionSnapshot[];
  contactSnapshot?: CheckoutContactSnapshot;
  /** Durable canonical reason for releasing; host support or elapsed time is never a reason. */
  paymentReleaseReason?: "never-started" | "not-created" | "expired-unpaid";
  coupon?: {
    couponId: string;
    code: string;
    status: "unreserved" | "pending" | "released" | "consumed";
    /** Why the coupon owner refused the hold before payment; the attempt released without a charge. */
    refused?: CouponUnavailableReason;
  };
}
/** One durable aggregate per trusted cart. Preserve past attempts and paid receipts. */
export interface CheckoutRecord { attempts: CheckoutAttempt[] }
export interface CheckoutPaymentAssociation {
  recordKind: "checkout-payment-association";
  attemptId: string;
  cartId: string;
  bindingRef: string;
}
export interface CheckoutPaymentAssociationPort {
  claim(record: CheckoutPaymentAssociation): Promise<boolean>;
  get(attemptId: string): Promise<CheckoutPaymentAssociation | null>;
}
export interface CheckoutStore {
  read(cartId: string): Promise<{ version: string; record: CheckoutRecord } | null>;
  /** Atomic insert (null version) or compare-and-set across processes. */
  compareAndSet(cartId: string, version: string | null, record: CheckoutRecord): Promise<boolean>;
}
export interface CheckoutExecution {
  store: CheckoutStore;
  catalog: StorefrontAvailabilityResolverStorage;
  availability: ResolveStorefrontAvailabilityExecution;
  resolveInventory(binding: InventoryProviderBinding): Promise<CheckoutInventoryPort | null>;
  paymentBindingRef: string;
  resolvePayments(bindingRef: string): Promise<CheckoutPaymentPort | null>;
  /** Optional durable index, claimed before any external payment call. */
  paymentAssociations?: CheckoutPaymentAssociationPort;
  createAttemptId?: () => string;
  now?: () => number;
  loadCheckoutContactRequirements?: CheckoutContactRequirementsLoader;
  pricing?: TrustedCheckoutPricing;
  /** Orders' receiving side of the paid-order handoff, bound by the entry. */
  paidOrders?: PaidOrderReceiver;
}

export interface TrustedShippingConfiguration {
  configurationId: string;
  revision: number;
  mode: "free" | "flat";
  amount?: Money;
}

export interface TrustedCheckoutPricing {
  /** Bound by the entry from its own coupon storage; absent means coupon codes are unavailable. */
  coupons?: CheckoutCouponPort;
  resolveShippingConfiguration: () => Promise<TrustedShippingConfiguration | null>;
  paymentPricingSchema?: typeof CHECKOUT_PRICING_SCHEMA;
}

export const GUEST_CHECKOUT_PROJECTION_SCHEMA =
  "dinkuskit.commerce.guest-checkout-projection/v1" as const;
export const GUEST_CAPABILITY_HEADER = "x-commerce-guest-capability";
export const GUEST_ORIGIN_HEADER = "origin";
export const GUEST_SEC_FETCH_SITE_HEADER = "sec-fetch-site";
export const GUEST_CHECKOUT_DECLARED_HEADERS = [
  GUEST_CAPABILITY_HEADER,
  GUEST_ORIGIN_HEADER,
  GUEST_SEC_FETCH_SITE_HEADER,
] as const;
export const CHECKOUT_GUEST_CAPABILITY_COLLECTION = "checkoutGuestCapabilities";
export const CHECKOUT_GUEST_CAPABILITY_SANDBOX_COLLECTION = "checkout_guest_capabilities";
export const CHECKOUT_SANDBOX_COLLECTION = "checkout_carts";

export type GuestCheckoutState =
  | "pending"
  | "paid"
  | "recoverable-failure"
  | "released-retry";

/**
 * Why a coupon can't be used. The storefront writes the shopper's words.
 * not-applicable is the fallback when the coupon owner gives no finer reason.
 */
export type CouponUnavailableReason = CouponNotApplicableReason | "not-applicable" | "used-up" | "try-later";

/** A coupon that can't be used, as the guest sees it; minimum comes with minimum-not-met. */
export interface CouponUnavailable { reason: CouponUnavailableReason; minimum?: Money }

export type GuestCheckoutErrorCode =
  | "CAPABILITY_DENIED"
  | "CHECKOUT_FROZEN"
  | "CHECKOUT_NOT_FOUND"
  | "CONTENTION"
  | "COUPON_UNAVAILABLE"
  | "INVALID_CART"
  | "INVENTORY_UNAVAILABLE"
  | "ORIGIN_DENIED"
  | "PAYMENTS_UNAVAILABLE"
  | "PRODUCT_UNAVAILABLE"
  | "RETRY_REQUIRED"
  | "UNAVAILABLE";

export interface GuestCheckoutLine {
  catalogItemId: string;
  name: string;
  quantity: number;
  unitPrice: Money;
}

/** Shopper amounts only; owner configuration and redemption identities stay server-side. */
export interface GuestCheckoutPricingSummary {
  merchandiseSubtotal: Money;
  couponDiscount: Money;
  netMerchandise: Money;
  shipping: { mode: "free" | "flat"; charge: Money };
  finalTotal: Money;
}

export interface GuestCheckoutOrderSummary {
  variantSelections?: readonly CheckoutVariantSelectionSnapshot[];
  orderId: string;
  receiptId: string;
  lines: GuestCheckoutLine[];
  total: Money;
  pricing?: GuestCheckoutPricingSummary;
}

export interface GuestCheckoutProjection {
  variantSelections?: readonly CheckoutVariantSelectionSnapshot[];
  schema: typeof GUEST_CHECKOUT_PROJECTION_SCHEMA;
  state: GuestCheckoutState;
  attemptId: string | null;
  lines: GuestCheckoutLine[];
  total: Money | null;
  pricing?: GuestCheckoutPricingSummary;
  redirectUrl: string | null;
  order: GuestCheckoutOrderSummary | null;
  retryAfter: string | null;
  unavailable: ({ code: GuestCheckoutErrorCode; message: string } & Partial<CouponUnavailable>) | null;
}

export interface GuestCapabilityPresentation {
  capabilityId: string;
  capability: string;
  retention: "json-body";
  header: typeof GUEST_CAPABILITY_HEADER;
}

export interface GuestCapabilityRecord {
  recordKind: "guest-checkout-capability";
  capabilityId: string;
  cartId: string;
  verifier: string;
  siteBinding: string;
  createdAt: string;
}

export interface GuestCheckoutHostOptions {
  /**
   * Host-owned trusted public site origin. Used when runtime `ctx.site.url`
   * is empty. A present public, malformed, or conflicting runtime URL cannot
   * be masked. Not read from Host, query, or body.
   */
  siteUrl?: string;
  topLevelSiteUrl?: string;
  checkoutSiteUrl?: string;
  paymentBindingRef?: string;
  resolvePayments?: CheckoutExecution["resolvePayments"];
  paymentAssociations?: CheckoutPaymentAssociationPort;
  resolveInventory?: CheckoutExecution["resolveInventory"];
  resolveAvailabilityProvider?: ResolveStorefrontAvailabilityExecution["resolveProvider"];
  createCapabilitySecret?: () => string;
  createCartId?: () => string;
  createCapabilityId?: () => string;
  createAttemptId?: () => string;
  now?: () => number;
  loadCheckoutContactRequirements?: CheckoutContactRequirementsLoader;
  /** Coupon storage is bound from this installation, never supplied by the host. */
  pricing?: Omit<TrustedCheckoutPricing, "coupons">;
}

export interface GuestCheckoutRuntime {
  carts: Pick<StorageCollection<CheckoutRecord>, "getVersioned" | "compareAndSet">;
  capabilities: Pick<
    StorageCollection<GuestCapabilityRecord>,
    "compareAndSet" | "get" | "getVersioned"
  >;
  catalog: StorefrontAvailabilityResolverStorage;
  /** Canonical trusted site origin after host resolution, when available. */
  siteUrl?: string;
  constructorSiteUrl?: string;
  runtimeSiteUrl?: string;
  topLevelSiteUrl?: string;
  checkoutSiteUrl?: string;
  paymentAssociations?: CheckoutPaymentAssociationPort;
  pricing?: TrustedCheckoutPricing;
  /** Bound by the entry from Orders; the host cannot supply it. */
  paidOrders?: PaidOrderReceiver;
  host: GuestCheckoutHostOptions;
}

export type GuestCheckoutResult =
  | {
      ok: true;
      capabilityId: string;
      capability?: GuestCapabilityPresentation;
      contactRequirements?: { requirePhoneNumber: boolean };
      checkout: GuestCheckoutProjection;
    }
  | {
      ok: false;
      error: { code: GuestCheckoutErrorCode; message: string } & Partial<CouponUnavailable>;
    };
