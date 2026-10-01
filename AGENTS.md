# Agent Contract

This public repository owns the advanced DinkusKit Coupons extension for
DinkusKit Commerce on EmDash. Keep it generic: site copy, customer data,
branding, credentials, and production configuration do not belong here.

## Boundary

- DinkusKit Commerce is the sole owner of the basic-coupon evaluator,
  canonical promotion decisions, cart, checkout, order, money, tax, refund,
  and basic-coupon admin contracts.
- This repository is a documentation/design stub for a deferred advanced
  extension. It must not price carts in parallel, trust browser totals, or
  claim an implemented runtime or SDK.
- The agreed v1 handoff covers one code/order, percentage or fixed total
  discounts, eligible merchandise selection, global redemption caps, and the
  payment-session lifecycle documented in `docs/basic-v1-handoff.md`.
- Store credit, gift cards, cashback, loyalty, referrals, stacking, BOGO,
  bulk, marketing, analytics, and Inventory dependencies are not owned here.

## Bootstrap State

This is a design stub. Add implementation only through an isolated branch and
worktree with tests, proof, and a documented supported Commerce contract and
SDK range after Commerce owners accept the proposals. Keep the package private
until its dogfood and release gates pass.

Every future plugin must be Registry-enabled and sandboxed with no native
escape. This lock is unaffected by the documentation-only v1 handoff.

The Commerce source at
`8a04c0b16b381b89531c88d1a655aad6c0c461c3` is a pinned historical reference
only. It does not establish a dependency, current checkout contract, or
published SDK range.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
