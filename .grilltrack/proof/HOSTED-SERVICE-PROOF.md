# Hosted coupon service decision proof

- **Track:** `gt-20260930183102-25d567`
- **Focus:** `hosted-coupon-service`, confirmed by the project owner on the
  coupons#12 decision card on 2026-10-08.
- **Baseline:** `git:8afa5904` (`origin/main` when the slice started).
- **Scope:** documentation and ledger only. No runtime, deployment, secret or
  production change is part of this slice.

## Artifacts

- `docs/hosted-coupon-service.md`: rationale, shape, single-evaluator import,
  HTTP contract v1, failure behaviour, Commerce-side changes, references.
- `AGENTS.md` and `README.md`: the repository boundary now names the hosted
  service; Commerce keeps prices, cart, checkout, order, money, tax and refunds.

## Fidelity checks

- Registry constraint: EmDash 1.2.0 `isHostAllowed` (`dist/context-*.mjs`),
  `@emdash-cms/plugin-cli@0.13.3` `AllowedHostsSchema`, and the Registry
  `releaseExtension` lexicon accept exact hosts, `*.` suffixes and a bare `*`
  only; there is no same-site token. Upstream docs agree
  (docs.emdashcms.com Capabilities & Security).
- Single evaluator: Commerce `eafd3e8` `src/features/coupons` takes storage
  through `CouponCollection` and `CouponCatalogStorage` only, and bundles
  standalone with no runtime `emdash` import (esbuild, 45 KB unminified).
- Contract: each checkout endpoint maps to one `CheckoutCouponPort` or
  `CouponAttemptPort` method and each admin endpoint to one `CouponAdminPort`
  method at that commit; priced lines carry Commerce's own `regular` and `sale`
  price record.
- `checkout-total-preservation` still holds: the contract's "When the service
  is down" section keeps fail-closed behaviour for accepted discounts, never
  charges the undiscounted total for a discounted session, and never releases a
  capped use on an unknown outcome.
- `agreed-v1-terms` are unchanged and remain the feature set.

## Feasibility evidence outside this slice

A local scaffold of the Worker and per-store Durable Object running the pinned
core passed 8 runtime tests in workerd on 2026-10-08 (full paid checkout, cap
under concurrent reservations, issued-quote check, admin uniqueness and
revisions). It ships in a follow-up PR and is not claimed as proof of this
documentation slice.

## Evaluator copy (2026-10-08)

`single-coupon-evaluator` was reopened and re-locked: the review bot refuses
PRs that add a git submodule, so the project owner chose an exact copy of the
Commerce files the build needs instead. Checked on the scaffold PR (coupons#13):

- `vendor/commerce` holds 70 files copied by `npm run check:pin -- --update`
  from Commerce commit `eafd3e83120c70120ccbe0a8684770b2739a4edf`; these are
  exactly the Commerce files the Worker build resolves.
- `npm run check:pin` verifies all 70 byte-for-byte against that commit, and
  fails on an edited copy or on a file that does not exist at the pin (both
  cases tried).
- The Worker bundle is unchanged by the switch (104.50 KiB, 25.06 KiB
  gzipped), typecheck reports no errors in this repository's sources, and the
  6 workflow tests and 8 runtime tests pass.
- The HTTP contract is unchanged, so `coupon-service-http-contract` is
  reverified against the same document.
