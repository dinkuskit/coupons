import type { StorageCollection } from "emdash";
import type { Money, CatalogItemReadStorage, CatalogPriceStorage } from "../catalog/kernel/index.js";

export const COUPONS_FEATURE_ID = "dinkus.coupons";
export const COUPONS_COLLECTION = "coupons";
export const COUPON_UNIQUE_INDEXES = ["normalizedCode"] as const;

export type CouponRedemptionState = "pending" | "consumed" | "released";

export type CouponDiscount =
  | { readonly kind: "fixed"; readonly amount: Money }
  | { readonly kind: "percentage"; readonly basisPoints: number; readonly maximum?: Money };

export interface CouponRule {
  readonly ruleId: string;
  readonly version: number;
  readonly discount: CouponDiscount;
  readonly appliesTo: "all-merchandise" | "selected-products";
  readonly selectedProductIds: readonly string[];
  readonly includeSaleItems: boolean;
  readonly minimumEligibleMerchandise: Money;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
}

export interface CouponRecord {
  readonly recordKind: "coupon";
  readonly couponId: string;
  readonly code: string;
  readonly normalizedCode: string;
  readonly revision: number;
  readonly disabled: boolean;
  readonly globalCap: number;
  readonly rule: CouponRule;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly CouponAttempt[];
}

export type CouponAttemptState = "pending" | "consumed" | "released";
export interface CouponAttempt {
  readonly attemptId: string;
  readonly couponId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly quoteId: string;
  readonly quote: CouponQuoteSnapshot;
  readonly state: CouponAttemptState;
  readonly providerSessionId?: string;
  readonly freeOrder?: {
    readonly orderId: string;
    readonly receiptId: string;
  };
}

export type CouponCollection = Pick<
  StorageCollection<CouponRecord>,
  "get" | "getVersioned" | "put" | "query" | "compareAndSet"
>;

export interface CouponCatalogStorage {
  readonly catalog: CatalogItemReadStorage;
  readonly prices: CatalogPriceStorage;
}

export interface CouponCartLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface CouponQuoteLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineSubtotal: Money;
  readonly eligible: boolean;
  readonly discount: Money;
}

export interface CouponQuote {
  readonly quoteId: string;
  readonly couponId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly eligibleSubtotal: Money;
  readonly discount: Money;
  readonly payableMerchandiseTotal: Money;
  readonly lines: readonly CouponQuoteLine[];
}

export interface CouponQuoteSnapshot extends CouponQuote {
  readonly merchandiseTotal: Money;
  readonly overallPayableTotal: Money;
}

export interface CouponAdminPort {
  create(input: unknown): Promise<CouponRecord>;
  list(): Promise<readonly CouponRecord[]>;
  get(couponId: string): Promise<CouponRecord | null>;
  edit(couponId: string, expectedRevision: number, input: unknown): Promise<CouponRecord>;
  disable(couponId: string, expectedRevision: number): Promise<CouponRecord>;
  findByCode(code: string): Promise<CouponRecord | null>;
}

export interface CouponRedemptionAttempt {
  readonly attemptId: string;
  readonly couponId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly quoteId: string;
  readonly state: CouponRedemptionState;
  readonly quote: CouponQuoteSnapshot;
  readonly providerSessionId?: string;
  readonly freeOrder?: {
    readonly orderId: string;
    readonly receiptId: string;
  };
}

export interface ReserveCouponRedemptionInput {
  readonly couponId: string;
  /** The original checkout attempt; retries must reuse this exact identity. */
  readonly attemptId: string;
  readonly quote: CouponQuote;
  /** Trusted Commerce-host total; never accepted from a browser. */
  readonly overallPayableTotal: Money;
  readonly now: string;
}

export type CouponProviderReconciliation =
  | {
      readonly kind: "verified-success";
      readonly providerSessionId: string;
    }
  | {
      readonly kind: "confirmed-failure" | "confirmed-cancel";
      readonly providerSessionId?: string;
    }
  | {
      readonly kind: "verified-not-created";
      readonly providerSessionId?: undefined;
    }
  | {
      readonly kind: "unknown";
      readonly providerSessionId?: string;
    };

/** Merchant counts computed directly from the durable coupon record. */
export interface CouponRedemptionCounts {
  readonly couponId: string;
  readonly cap: number;
  readonly capacity: number;
  readonly pending: number;
  readonly consumed: number;
  readonly released: number;
  readonly remaining: number;
}

/** Why a coupon does not apply to a cart, for the storefront to word. */
export type CouponNotApplicableReason = "not-found" | "not-started" | "expired" | "minimum-not-met" | "no-qualifying-items";

export type CouponRedemptionErrorCode =
  | "INVALID_INPUT"
  | "CAPACITY_EXHAUSTED"
  | "CONFLICTING_ATTEMPT"
  | "UNKNOWN_ATTEMPT"
  | "TERMINAL_CONFLICT"
  | "CONTENTION"
  | "CORRUPTED_RECORD";

export class CouponRedemptionError extends Error {
  constructor(
    readonly code: CouponRedemptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CouponRedemptionError";
  }
}

export interface CouponRedemptionOwnerPort {
  reserve(input: ReserveCouponRedemptionInput): Promise<CouponRedemptionAttempt>;
  attachProviderSession(
    couponId: string,
    attemptId: string,
    providerSessionId: string,
  ): Promise<CouponRedemptionAttempt>;
  reconcile(
    couponId: string,
    attemptId: string,
    reconciliation: CouponProviderReconciliation,
  ): Promise<CouponRedemptionAttempt>;
  reconcileFreeOrder(input: {
    couponId: string;
    attemptId: string;
    proof: CouponFreeOrderProof;
  }): Promise<CouponRedemptionAttempt>;
  get(couponId: string, attemptId: string): Promise<CouponRedemptionAttempt | null>;
  getCounts(couponId: string): Promise<CouponRedemptionCounts | null>;
}

export type CouponFreeOrderProof =
  | {
      readonly kind: "verified-free-order";
      readonly attemptId: string;
      readonly couponId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly quoteId: string;
      readonly orderId: string;
      readonly receiptId: string;
      readonly overallPayableTotal: { readonly currency: "USD"; readonly minor: "0" };
    }
  | {
      readonly kind: "unknown";
      readonly attemptId: string;
      readonly couponId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly quoteId: string;
    };
