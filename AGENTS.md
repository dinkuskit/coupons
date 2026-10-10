# Agent Contract

This public repository owns the advanced DinkusKit Coupons extension for
DinkusKit Commerce on EmDash. Keep it generic: site copy, customer data,
branding, credentials, and production configuration do not belong here.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Use
`./scripts/grilltrack --project . validate` or `show` for ledger reads.
The CLI-only ledger rule remains in force. SmokySkills is enabled only after
maintainer access and an immutable commit pin are supplied.

## Boundary

The boundary below was accepted on 2026-10-08 and is recorded in
[docs/hosted-coupon-service.md](docs/hosted-coupon-service.md) and the
GrillTrack ledger.

- This repository owns the hosted DinkusKit coupon service for Registry
  stores: a Cloudflare Worker with one Durable Object per store that holds
  coupon records and redemption attempts, and the HTTP contract Commerce
  checkout and the Coupons admin plugin call.
- DinkusKit Commerce remains the sole owner of catalog prices, cart,
  checkout, order, money, tax, and refunds. The service evaluates coupons only
  against lines Commerce has already priced. It never trusts browser prices or
  totals and never writes an order or payment amount.
- There is one coupon evaluator: Commerce's `features/coupons`, imported here
  pinned to an exact Commerce commit. Do not copy or fork it; bump the pin in
  its own PR with the contract tests re-run.
- The agreed v1 terms still define the feature: one code per order,
  percentage or fixed total discounts, all merchandise or selected products,
  sale-item inclusion defaulting to exclude, eligible minimum spend, a
  percentage maximum, global redemption caps, the reserve, consume, release
  and reconcile lifecycle, and frozen discounts for existing payment sessions
  (`docs/basic-v1-handoff.md`).
- Store credit, gift cards, cashback, loyalty, referrals, stacking, BOGO,
  bulk, marketing, analytics, and Inventory dependencies are not owned here.

## Bootstrap State

The service is a scaffold: a Cloudflare Worker (`src/worker.ts`) and one
`StoreCoupons` Durable Object per store (`src/store.ts`), tested in the local
Workers runtime. It is not deployed and has no production configuration. Run
`npm ci`, `npm run check:pin`, `npm run typecheck`, `npm test` and
`npm run test:runtime` before pushing.

`bin/dinkus-coupons.mjs` and `cli/` are the operations CLI
([docs/CLI-SPEC.md](docs/CLI-SPEC.md)). `cli/kernel.mjs` is the shared
DinkusKit CLI kernel; keep it byte-identical with Commerce's and change it
there first. Nothing under `src/` imports `cli/`. Agents changing coupons use
the CLI as [skills/coupons-cli](skills/coupons-cli/SKILL.md) describes.
Keep the package private until its dogfood and release gates pass.

Import Commerce's coupon core only through `src/core.ts`. Never edit files
under `vendor/commerce`: they are an exact copy of Commerce at
`package.json` `dinkuskit.commercePin`. A pin bump changes `commercePin` and
rewrites the copy with `npm run check:pin -- --update` in the same commit.

Every plugin from this repository, including the Coupons admin plugin, must be
Registry-enabled and sandboxed with no native escape. The hosted service is
not an EmDash plugin and is not bound by the plugin file limit.

`plugins/coupons-admin` is the Coupons admin plugin. It talks only to the
hosted service at `coupons.dinkuskit.com` and changes coupons only through the
service's preview and confirm routes. Before pushing a change to it, also run
`npm run test:plugin` and `npm run build:plugin`; the second fails if the
backend passes the Registry's 128 KiB per-file limit.

The Commerce source at
`8a04c0b16b381b89531c88d1a655aad6c0c461c3` is a pinned historical reference
only. The service's Commerce pin is set in its own PR.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
