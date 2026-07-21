# Agent Contract

This public repository owns the advanced Dinkus Coupons extension for
AICommerce on EmDash. Keep it generic: site copy, customer data, Smoky branding,
credentials, and production configuration do not belong here.

## Boundary

- AICommerce owns the canonical promotion model, evaluation pipeline, cart,
  checkout, order, money, tax, and refund contracts.
- This extension registers advanced conditions/effects and adds their admin,
  reporting, simulation, and migration surfaces.
- Never price a cart in parallel with AICommerce or trust browser-supplied
  prices/totals.
- Store credit, gift cards, cashback, loyalty, and referrals are not owned here.

## Bootstrap State

This is a design stub. Add implementation only through an isolated branch and
worktree with tests, proof, and a documented `@dinkuskit/commerce-sdk` range.
Keep the package private until its dogfood and release gates pass.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
