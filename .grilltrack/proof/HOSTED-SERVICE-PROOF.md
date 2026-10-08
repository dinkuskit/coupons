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
