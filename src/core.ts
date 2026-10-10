// The one coupon evaluator: Commerce's own coupon core, copied unchanged into
// vendor/commerce from the commit in package.json "dinkuskit.commercePin"
// (`npm run check:pin` verifies the copy). Import it only through this file so
// a pin bump has one place to review.
export {
  CouponAdminError,
  CouponRedemptionError,
  createCheckoutCouponPort,
  createCouponAdmin,
  createCouponAttemptOwner,
  normalizeCouponCode,
  normalizeCouponRule,
  type CouponAttempt,
  type CouponAttemptPort,
  type CouponCatalogStorage,
  type CouponCollection,
  type CouponFreeOrderProof,
  type CouponProviderReconciliation,
  type CouponQuote,
  type CouponRecord,
  type CouponRule,
} from "../vendor/commerce/src/features/coupons/index.js";
export { CatalogError, normalizeMoney, parseMinorUnits } from "../vendor/commerce/src/features/catalog/kernel/index.js";
export type { Money } from "../vendor/commerce/src/features/catalog/kernel/index.js";
