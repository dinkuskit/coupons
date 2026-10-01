# Agreed v1 documentation proof

- **Track:** `gt-20260930183102-25d567`
- **Baseline:** `git:edeeeecb59f38cc93a8d87acdacf7e8983b876d0` (`origin/main` at slice start)
- **Lineage restored:** PR6 commit `4538e8c030750de98b4e857ef6492c13527aed4a`
- **Worker phase:** docs-only fidelity; no runtime, provider, secret, or
  production mutation was performed.

## Artifacts

- `AGENTS.md` establishes Commerce ownership and the docs-only boundary.
- `README.md` replaces prior whole-order and refund-exclusion requirements.
- `docs/basic-v1-handoff.md` records the confirmed semantics and acceptance
  matrix.
- `docs/v1-integration-request.md` labels proposed interfaces and owner
  acceptance requests; it makes no SDK claim.
- `.grilltrack/work/agreed-v1-run/` contains ignored run-state artifacts.

## Fidelity checks

- Confirmed one code/order, fixed-total or percentage discounts, all or
  selected merchandise, sale-item default exclusion, eligible pre-coupon
  minimum spend, percentage maximum, global cap, pending reservation,
  confirmed settlement, unknown reconciliation, session freeze, admin/shopper
  surfaces, and no automatic refund restoration.
- Confirmed exclusions include stacking, BOGO, bulk, marketing, analytics,
  Inventory, per-customer restrictions, and guest-email enforcement.
- Rounding/allocation, zero-total behavior, and normalization remain questions.
- Historical Commerce source is linked with an explicit historical caveat.
- WooCommerce comparison is limited to the official linked documentation
  checked September 30, 2026; no extra Woo scope was adopted.

## Verification limitation

This proof covers documentation, local link targets, ledger integrity, and
the requested repository test. It does not prove Commerce, Payments, checkout,
order, refund, or runtime success. Any implementation requires owner-accepted
typed contracts and fresh proof.

## Finite repair and re-verification

The follow-up repair corrected the integration boundary and preserved the
unaffected Registry-enabled sandbox/no-native-escape lock:

- Commerce owns the durable atomic cap ledger, merchant admin, coupon
  evaluation, and frozen discounted order. Payments transports only the exact
  accepted amount and verified outcomes; Template storefront owns shopper
  apply/remove/display.
- Proposed cap ports carry the durable original attempt ID, coupon ID, and
  immutable rule/quote revisions with idempotency and atomic-concurrency
  requirements. The cap reservation exists before any payable provider session
  is created and is keyed by those durable identities; the provider session ID
  is optional until confirmed creation, then maps exactly once to the original
  attempt. Unknown create/transport outcomes hold the reservation, while only
  a verified not-created result releases it safely. Stale or duplicate events
  cannot double consume/release or release a consumed slot.
- Percentage representation remains unresolved through the documented
  `PercentageRepresentationPending` placeholder rather than being presented
  as a selected rate. The accepted-total failure invariant and lifecycle matrix
  now cover final-slot concurrency, retries, stale events, invalid browser
  totals, forbidden admin access, timezone boundaries, refunds, verified
  not-created release, unknown holds, and no silent full-price paid order.

Actual verification commands and results:

| Command | Result |
| --- | --- |
| `python3 <installed-grilltrack-cli> --project . validate` | PASS (`valid`) |
| `git diff --check` | PASS |
| repository-relative documentation link check | PASS (3 links) |
| `node --test tests/workflows/*.test.mjs` | PASS (6 tests, 6 passed, 0 failed) |

The ledger validation is a worker self-check of the repaired documentation
state. Parent external review of the exact eventual commit remains pending;
this proof is not an official clean review or reviewer clearance.
