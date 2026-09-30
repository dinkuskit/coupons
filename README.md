# coupons

`* * *`

Advanced promotions for DinkusKit Commerce on EmDash: typed conditions and effects,
BOGO and rewards, schedules, limits, simulation, reporting, and Woo migration.
Planned package: `@dinkuskit/coupons`.

DinkusKit Commerce owns basic coupon codes for Commerce v1 (one code per order,
percentage or fixed amount, expiration, usage limits, discount preserved through checkout).
DinkusKit Commerce is the sole owner of the basic engine, admin admission, and
canonical pricing/evaluation/cart/checkout/order money.

Planned advanced capabilities described below are deferred post-v1 extensions,
not a currently registered or available promotion pipeline in Commerce. The extension
will build upon the same deterministic promotion pipeline and canonical promotion
records without running a second cart-pricing engine or parallel money writer.

For the basic coupon handoff contract and requirements preparation, see:
- [Commerce v1 Basic Coupon Boundary & Handoff](docs/basic-v1-handoff.md)

## Architecture and Sandbox Contract

- Every future plugin must be an EmDash Registry-enabled sandbox; no native escape.
- The extension will register advanced condition and effect descriptors with Commerce.
- Promotion evaluation and final checkout totals remain strictly server-side and
  Commerce-owned; browser-submitted discount totals are never trusted.

## Planned advanced boundary

- condition groups with explicit AND/OR semantics;
- BOGO, reward products, schedules, stacking, and advanced usage limits;
- deterministic line, shipping, tax, and refund allocations;
- provisional redemption claims with commit, release, and reversal receipts;
- simulation traces, reporting, and Advanced Coupons migration;
- the same audited application services behind EmDash admin, REST, and MCP.

Tax, refund, and store-credit semantics are excluded from this basic coupon boundary.
Store credit, gift cards, cashback, loyalty, and referrals are separate
money/marketing domains rather than coupon effects.

## Status

Public design stub. There is no installable plugin or published npm package yet.
The package manifest is private at `0.0.0` to prevent accidental publication.
The upstream DinkusKit Commerce source snapshot (`8a04c0b16b381b89531c88d1a655aad6c0c461c3`)
is referenced solely as a read-only preparation reference; upstream defines no SDK
package or dependency range, and no published SDK range has been verified. No unreleased
SDK dependency range is invented before Commerce publishes.

Part of [Dinkus](https://github.com/dinkuskit): blocks, Commerce, commerce
extensions, and templates for [EmDash](https://github.com/emdash-cms/emdash)
sites. Commerce extensions depend on DinkusKit Commerce; blocks and templates remain
independently usable.

Under construction, dogfooding in the open. MIT.
