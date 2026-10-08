import { createCouponAdmin } from "./admin.js";
import { createCouponAttemptOwner, type CouponAttemptPort } from "./composition.js";
import { evaluateCoupon } from "./evaluator.js";
import type { CouponCatalogStorage, CouponCartLine, CouponCollection, CouponQuote } from "./types.js";

/**
 * The coupon operations checkout composes, bound to one installation's own
 * coupon storage. An entry that does not bind one has no coupon support, and
 * none of this module is reachable from it.
 */
export interface CheckoutCouponPort {
  /** Null when no coupon has this normalized code. */
  quote(
    code: string,
    storage: CouponCatalogStorage,
    input: { readonly quoteId: string; readonly lines: readonly CouponCartLine[]; readonly now: string },
  ): Promise<{ couponId: string; quote: CouponQuote } | null>;
  owner(): CouponAttemptPort;
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
