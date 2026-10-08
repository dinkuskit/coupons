export {
  COUPONS_FEATURE_ID,
  CouponRedemptionError,
  type CouponProviderReconciliation,
  type CouponRedemptionAttempt,
  type CouponRedemptionCounts,
  type CouponRedemptionErrorCode,
  type CouponRedemptionOwnerPort,
  type CouponRedemptionState,
  type ReserveCouponRedemptionInput,
  type CouponFreeOrderProof,
} from "./types.js";
export {
  CouponAdminError,
  createCouponAdmin,
  normalizeCouponCode,
  normalizeCouponRule,
  couponStorageDeclaration,
} from "./admin.js";
export { evaluateCoupon } from "./evaluator.js";
export { createCouponAttemptOwner } from "./composition.js";
export type { CouponAttemptPort } from "./composition.js";
export { createCheckoutCouponPort } from "./checkout.js";
export type { CheckoutCouponPort } from "./checkout.js";
export {
  COUPONS_COLLECTION,
  COUPON_UNIQUE_INDEXES,
  type CouponAdminPort,
  type CouponAttempt,
  type CouponAttemptState,
  type CouponCatalogStorage,
  type CouponCartLine,
  type CouponCollection,
  type CouponDiscount,
  type CouponQuote,
  type CouponQuoteLine,
  type CouponQuoteSnapshot,
  type CouponRecord,
  type CouponRule,
} from "./types.js";
export { validateCouponQuoteSnapshot } from "./validation.js";
