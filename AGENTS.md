# Agent Contract

This public repository owns the advanced Dinkus Coupons extension for
DinkusKit Commerce on EmDash. Keep it generic: site copy, customer data, Smoky branding,
credentials, and production configuration do not belong here.

## Boundary

- DinkusKit Commerce is the sole owner of basic coupon codes in v1, the basic
  promotion evaluation engine, admin admission, and canonical pricing, cart,
  checkout, order, and money contracts.
- Basic coupon codes are REQUIRED for DinkusKit Commerce v1: one code per order,
  percentage or fixed amount, expiration, usage limits, and discount preserved
  through checkout.
- This repository owns the advanced Dinkus Coupons extension only. Advanced
  stacking, BOGO, reward products, condition groups, schedules, customer
  targeting, simulation, reporting, and Woo migration are deferred to post-v1.
- Coupons is an advanced extension only, never a parallel money writer. It never
  prices a cart in parallel with DinkusKit Commerce or trusts browser-supplied
  prices/totals.
- Every future plugin must be a Registry-enabled sandbox; no native escape.
- Tax, refund, and store-credit semantics are excluded from this coupon boundary.
  Store credit, gift cards, cashback, loyalty, and referrals are separate domains
  not owned here.

## Bootstrap State

This is a design stub. The referenced DinkusKit Commerce source snapshot
(`8a04c0b16b381b89531c88d1a655aad6c0c461c3`) serves as a read-only preparation
reference, not a package dependency, integration binding, or pinned package identity.
Upstream source defines no SDK package or dependency range, and no published SDK
range has been verified.

Add implementation only through an isolated branch and worktree with tests,
proof, and gate on the actual supported Commerce public contract and published
release range when available, not an assumed SDK package. Keep the package
private at `0.0.0` until its dogfood and release gates pass.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
