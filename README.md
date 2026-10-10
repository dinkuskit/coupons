# coupons

`@dinkuskit/coupons` is the home of the hosted DinkusKit coupon
service, which brings coupons to Registry stores running DinkusKit Commerce on
EmDash. Commerce's Registry build no longer carries coupons
([commerce#75](https://github.com/dinkuskit/commerce/pull/75)) because of the
Registry's 128 KiB per-file limit, and EmDash 1.2 has no way for one plugin to
call another on the same site. So coupons come back as a Cloudflare Worker
with one Durable Object per store, called by Commerce checkout over HTTPS, plus
a small Coupons admin Registry plugin. The service is a tested scaffold and is
not deployed yet. Store owners and their agents manage coupons with the
`dinkus-coupons` command-line tool first; the admin plugin is not built yet.

Commerce keeps setting prices. The service evaluates a code only against lines
Commerce has already priced, never against browser prices or totals, and uses
Commerce's own coupon evaluator pinned by commit rather than a copy.

The feature set is the agreed v1: one code per order, percentage or fixed total
discounts, all merchandise or selected products, sale-item inclusion defaulting
to exclude, eligible-merchandise minimum spend before the coupon, percentage
maximum discount, global redemption caps, payment reservation/consume/release
and unknown-outcome reconciliation, frozen accepted discounts for existing
payment sessions, and new-session evaluation against current rules.

See:

- [Hosted coupon service and HTTP contract](docs/hosted-coupon-service.md)
- [`dinkus-coupons` CLI specification](docs/CLI-SPEC.md) and its agent skill,
  [skills/coupons-cli](skills/coupons-cli/SKILL.md)
- [Agreed v1 coupon semantics and acceptance matrix](docs/basic-v1-handoff.md)
- [Earlier integration request, superseded](docs/v1-integration-request.md)

Advanced stacking, BOGO, bulk, marketing, analytics, Inventory dependencies,
store credit, gift cards, cashback, loyalty, and referrals remain out of scope.
Rounding/allocation, zero-total behavior, and code normalization are questions
for the owning contract; this repository invents no policy.

The package remains private at `0.0.0`. The Commerce commit
`8a04c0b16b381b89531c88d1a655aad6c0c461c3` is a historical read-only
reference, not a dependency or current SDK claim.

## Development

```sh
npm ci
npm run check:pin             # vendor/commerce matches Commerce at commercePin
npm run typecheck
npm test                      # CLI and workflow tests in Node
npm run test:runtime          # Worker and Durable Object in local workerd
npm run build                 # wrangler dry run
```

`src/worker.ts` routes `/v1/stores/{siteId}/...` and checks the store's
token; `src/store.ts` is the per-store Durable Object that runs Commerce's
coupon core over its own SQLite storage. Nothing is deployed yet.

## Command-line tool

`bin/dinkus-coupons.mjs` lists coupons, shows how many uses are left, and
creates or turns coupons off and on. Every change is previewed by the service
and needs that preview's confirmation value, typed at the prompt or passed as
`--confirm`. It needs a `coupons:admin` pass in `DINKUS_COUPONS_TOKEN` and an
endpoint from `--endpoint`, `DINKUS_COUPONS_ENDPOINT` or user config.

```sh
export DINKUS_COUPONS_ENDPOINT=https://coupons.example
bin/dinkus-coupons.mjs --site store-1 coupons list
bin/dinkus-coupons.mjs --site store-1 coupons create --code FALL10 --percent 10 \
  --ends 2026-11-30T23:59:59-05:00 --time-zone America/New_York --cap 500
```

The tool lives outside every plugin bundle. See
[docs/CLI-SPEC.md](docs/CLI-SPEC.md) for flags, output, exit codes, and how
to recover a change whose outcome is unknown.

Commerce's coupon core, and the Commerce files it imports, are copied
unchanged under `vendor/commerce` from the commit in `package.json`
`dinkuskit.commercePin`. To move the pin, change `commercePin` and run
`npm run check:pin -- --update`.

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
