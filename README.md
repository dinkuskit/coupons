# coupons

`* * *`

Advanced promotions for AICommerce on EmDash: typed conditions and effects,
BOGO and rewards, schedules, limits, simulation, reporting, and Woo migration.
Planned package: `@dinkuskit/coupons`.

AICommerce will ship useful basic coupons for new stores. This extension adds
advanced capabilities to the same deterministic promotion pipeline and
canonical promotion records. It never starts a second cart-pricing engine.

## Planned boundary

- condition groups with explicit AND/OR semantics;
- BOGO, reward products, schedules, stacking, and advanced usage limits;
- deterministic line, shipping, tax, and refund allocations;
- provisional redemption claims with commit, release, and reversal receipts;
- simulation traces, reporting, and Advanced Coupons migration;
- the same audited application services behind EmDash admin, REST, and MCP.

Store credit, gift cards, cashback, loyalty, and referrals are separate
money/marketing domains rather than coupon effects.

## Status

Public design stub. There is no installable plugin or published npm package yet.
The package manifest is private at `0.0.0` to prevent accidental publication.

Part of [Dinkus](https://github.com/dinkuskit): blocks, AICommerce, commerce
extensions, and templates for [EmDash](https://github.com/emdash-cms/emdash)
sites. Commerce extensions depend on AICommerce; blocks and templates remain
independently usable.

Under construction, dogfooding in the open. MIT.
