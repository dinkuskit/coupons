# coupons

`@dinkuskit/coupons` is a private, public design stub for advanced promotions
on DinkusKit Commerce and EmDash. This slice records an agreed v1
documentation handoff; it does not add a runtime, evaluator, SDK, provider,
secret, or production configuration.

DinkusKit Commerce remains the sole owner of the basic-coupon evaluator,
canonical pricing, cart, checkout, order, money, tax, refund, and basic-coupon
admin contracts. Coupons never prices a cart in parallel or trusts browser
prices/totals.

The confirmed handoff covers one code per order, percentage or fixed total
discounts, all merchandise or selected products, sale-item inclusion defaulting
to exclude, eligible-merchandise minimum spend before the coupon, percentage
maximum discount, global redemption caps, payment reservation/consume/release
and unknown-outcome reconciliation, frozen accepted discounts for existing
payment sessions, and new-session evaluation against current rules.

See:

- [Basic coupon boundary](docs/basic-v1-handoff.md)
- [Integration request and acceptance matrix](docs/v1-integration-request.md)

Advanced stacking, BOGO, bulk, marketing, analytics, Inventory dependencies,
store credit, gift cards, cashback, loyalty, and referrals remain out of scope.
Rounding/allocation, zero-total behavior, and code normalization are questions
for the owning contract; this repository invents no policy.

The package remains private at `0.0.0`. The Commerce commit
`8a04c0b16b381b89531c88d1a655aad6c0c461c3` is a historical read-only
reference, not a dependency or current SDK claim.

## Install type

DinkusKit plugins ship as EmDash Registry plugins: sandboxed and installed
from the plugin Registry, which is how most EmDash sites add plugins. The
Registry build is the supported product, and features are designed, tested and
documented for it first. A native entry (code a site registers in its own
configuration or Astro routes) is a developer and test setup only. It may not
offer features the Registry build lacks, except temporary gaps listed here with
the work that closes them. The project owner set this rule on 2026-10-08.

Any Coupons plugin ships as a Registry plugin, as the Agent Contract already
requires (sandboxed, with no native escape).
