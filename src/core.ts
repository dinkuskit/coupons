// The one coupon evaluator: Commerce's own coupon core, pinned by the
// vendor/commerce submodule (see package.json "dinkuskit.commercePin").
// Import it only through this file so a pin bump has one place to review.
export {
  CouponAdminError,
  CouponRedemptionError,
  createCheckoutCouponPort,
  createCouponAdmin,
  createCouponAttemptOwner,
  normalizeCouponCode,
  type CouponAttempt,
  type CouponAttemptPort,
  type CouponCatalogStorage,
  type CouponCollection,
  type CouponFreeOrderProof,
  type CouponProviderReconciliation,
  type CouponQuote,
  type CouponRecord,
} from "../vendor/commerce/src/features/coupons/index.js";
export { CatalogError, normalizeMoney, parseMinorUnits } from "../vendor/commerce/src/features/catalog/kernel/index.js";
export type { Money } from "../vendor/commerce/src/features/catalog/kernel/index.js";
