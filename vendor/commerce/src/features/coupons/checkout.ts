import { createCouponAdmin } from "./admin.js";
import { createCouponAttemptOwner, type CouponAttemptPort } from "./composition.js";
import { evaluateCoupon } from "./evaluator.js";
import type { CouponCatalogStorage, CouponCartLine, CouponCollection, CouponQuote } from "./types.js";

/** The redemption lifecycle checkout drives for an attempt that carries a coupon. */
export type CheckoutCouponOwner = Pick<
  CouponAttemptPort,
  "reserve" | "releaseUnstarted" | "attachProviderSession" | "reconcile" | "reconcileFreeOrder"
>;

/**
 * The coupon operations checkout composes. The native entry binds one to the
 * installation's own coupon storage; the Registry entry binds one to the
 * hosted coupon service when the owner configures it. An entry that binds
 * neither has no coupon support.
 */
export interface CheckoutCouponPort {
  /** Null when no coupon has this normalized code. */
  quote(
    code: string,
    storage: CouponCatalogStorage,
    input: { readonly quoteId: string; readonly lines: readonly CouponCartLine[]; readonly now: string },
  ): Promise<{ couponId: string; quote: CouponQuote } | null>;
  owner(): CheckoutCouponOwner;
}

export function createCheckoutCouponPort(collection: CouponCollection): CheckoutCouponPort {
  return {
    async quote(code, storage, input) {
      const coupon = await createCouponAdmin(collection).findByCode(code);
      if (!coupon) return null;
      return { couponId: coupon.couponId, quote: await evaluateCoupon(coupon, storage, input) };
    },
    owner: () => createCouponAttemptOwner(collection),
  };
}
