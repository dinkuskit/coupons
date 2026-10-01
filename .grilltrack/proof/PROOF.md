# GrillTrack Verification Proof: Coupons v1 Boundary Handoff

- **Track ID**: `gt-20260930183102-25d567`
- **Domain**: `commerce-v1-coupons-boundary`
- **Cadence**: `sequential`
- **Repository**: `dinkuskit/coupons`
- **Branch**: `codex/coupons-v1-boundary-20260930`
- **Base Commit**: `92b330906b37492fd0680efad563f3e4f54c3898`
- **Commerce Snapshot Reference**: `8a04c0b16b381b89531c88d1a655aad6c0c461c3` (read-only preparation reference; defines no SDK package or dependency range, and no published range is verified)
- **Verification Scope**: **Requirements and documentation verified only**. No runtime basic coupon engine has been implemented, enforced, or executed in this repository. The test scenario and acceptance matrices represent future proof design for Commerce core implementation.
- **Verification Timestamp**: `2026-09-30T18:58:00+00:00`

---

## 1. Verified Decisions & Boundary Alignment

The following architectural decisions have been adjudicated, repaired, implemented, and verified in the GrillTrack ledger:

1. **`coupon-v1-scope`**:
   - Basic coupon codes are REQUIRED for DinkusKit Commerce v1: one code per order, percentage or fixed amount, expiration, usage limits, discount preserved through checkout. Whole-order / storewide application in basic v1.
   - Advanced stacking, BOGO, condition groups, schedules, and product/customer targeting are deferred to the advanced `@dinkuskit/coupons` extension.
2. **`commerce-money-engine-ownership`**:
   - DinkusKit Commerce is the sole owner of the basic coupon engine, admin admission, and canonical pricing, cart, checkout, and order money.
   - Pinned snapshot anchor for `Money` is confirmed at `src/features/catalog/types.ts#L129-L132` (prior rejection was adjudicated as a false positive).
   - `@dinkuskit/coupons` is an advanced extension only and must never act as a parallel money writer.
3. **`registry-sandbox-runtime-boundary`**:
   - Every future plugin must be an EmDash Registry-enabled sandbox with no native escape.
   - Gated on actual supported Commerce public contract and published release range when available, not an assumed SDK package.
4. **`excluded-financial-semantics`**:
   - Tax, refund, and store-credit semantics are excluded from this basic coupon boundary; store credit, gift cards, cashback, loyalty, and referrals are separate domains.
5. **`checkout-total-preservation`**:
   - Required acceptance invariant (Issue 34): for a neutral 1000 item with a 250 accepted discount yielding a 750 total, any evaluation or processor failure, timeout, or total mismatch must fail safely and must never silently charge 1000 or create a paid order. No automatic release on failure.

---

## 2. Verified Documentation Artifacts

All links are repository-relative from this proof file:

1. [`../../AGENTS.md`](../../AGENTS.md):
   - Confirms Commerce sole ownership of basic coupon engine and canonical money.
   - Pinned snapshot `8a04c0b16b381b89531c88d1a655aad6c0c461c3` identified as read-only preparation reference.
   - Gated on actual supported Commerce public contract and published release range rather than an assumed SDK package.
   - Registry sandbox requirement with no native escape preserved.
   - Isolated branch/worktree working rules for eventual implementation retained.
2. [`../../README.md`](../../README.md):
   - Aligned with DinkusKit Commerce v1 owning basic coupon codes.
   - Direct navigation link to `docs/basic-v1-handoff.md` provided.
   - Clarifies advanced capabilities are deferred post-v1 plans, not a currently registered or available pipeline.
   - Retains verified wording regarding no invented SDK dependency range.
3. [`../../package.json`](../../package.json):
   - Description confirms `"Advanced promotions for DinkusKit Commerce on EmDash"`.
   - Preserves `"private": true` and `"version": "0.0.0"`.
4. [`REVIEW.md`](REVIEW.md):
   - Located under `.grilltrack/proof/REVIEW.md` (no root `REVIEW.md`).
   - Adjudicates `reject_false_positive` for the Money anchor (`types.ts#L129-L132`), which is verified in the pinned source.
   - Details accepted fixes: missing checkout contracts (`CartLine`, `CheckoutLine`, `CheckoutAttempt.payment`, `CommerceOrder.total`, `CheckoutStore`, `CheckoutExecution`, `reconcileCheckout`, private `freeze()`), storewide scope narrowing, restored acceptance design matrix, Issue 34 clarification, and SDK contract gating.
5. [`../../docs/basic-v1-handoff.md`](../../docs/basic-v1-handoff.md):
   - Audited source contracts linking public package exports (`src/index.ts`, `src/features/catalog/index.ts`, `src/features/checkout/index.ts`) and verified files.
   - Accurately documents `Money` (lines 129–132), `resolveCatalogItemPrice` (no sale schedule evaluation; `customerPays` at line 185), `saleIsStrictlyLower` (line 53), `parseMinorUnits` (`MAX_SAFE_INTEGER` bound), zero-total gate (line 60), and `PaymentOutcome.total` (present only on `open`, `paid`, and `expired-unpaid`).
   - Includes compact grouped rows for checkout types and operations; explicitly maintains `freeze()` as a private internal helper.
   - Restores the 12-case minimal future acceptance matrix (no-code 1000 baseline, fixed 250 / 25% yielding 750, pre-freeze rejection, stale-applied UI clear, provider mismatch fail-closed without automatic release, lost response recovery, cart mutation guard, duplicate paid order idempotency, post-freeze expiry retention, concurrent last-use race, fractional percentage rounding, and zero-total handling).
   - Details the ordered 4-step dependency and proof plan without premature extension runtime prerequisites.
   - Links public Commerce Issue 34 ([`dinkuskit/commerce#34`](https://github.com/dinkuskit/commerce/issues/34)) with historical pilot context vs confirmed v1 prerequisite.

---

## 3. Actual Documentation & Verification Checks

| Check | Target / Tool | Status | Detail |
| :--- | :--- | :--- | :--- |
| **GrillTrack Ledger Validation** | `grilltrack_ledger.py validate` | **PASS** | Validated projection, review histories, confirmations, and sequential dependencies. |
| **Adjudication Review Binding** | `.grilltrack/proof/REVIEW.md` | **PASS** | Adjudicated `reject_false_positive` for Money anchor and `required_fix` for affected scope, bound to pre-edit handoff hash. |
| **JSON Syntax & Package Guard** | `package.json` | **PASS** | Valid JSON; `private: true`, `version: 0.0.0`. |
| **Source Contract Verification** | Upstream snapshot `8a04c0b` | **PASS** | All source links point to public exports or verified line anchors; whole-file references used where appropriate. |
| **Relative Path & Front-Door Hygiene** | Proof & handoff links | **PASS** | No root `REVIEW.md`; review artifact located in `.grilltrack/proof/REVIEW.md`. All public links valid relative; no `file://`, local paths, or job IDs. |
| **Owner Decisions Preserved** | Undecided semantics | **PASS** | Open decisions (basis points vs percent, mutable counts vs append-only, timestamp unit/expiry bound, zero total handling) preserved without premature choice; advanced targeting deferred. |

> [!NOTE]
> **Verification Limitation**: This verification covers specification, documentation, metadata, link, and ledger integrity. No browser, integration, or runtime test suite was executed because this repository is currently a docs-only design stub with no runtime coupon implementation.

---

## 4. Open Owner Decisions (Explicitly Undecided Semantics)

The following items are explicitly left as open implementation decisions for DinkusKit Commerce:
- Code normalization (case folding, whitespace trimming, character sets).
- Percentage discount precision (basis points vs integer percent), base, and rounding against regular vs sale pricing (`saleIsStrictlyLower`).
- The repaired handoff fixes lifecycle ordering: Commerce atomically reserves
  the cap before any payable provider session is created, keyed by durable
  attempt/coupon/rule/quote identities; unknown creation or transport outcomes
  hold the reservation, and only verified not-created releases it. Mutable
  counters versus event logs remain an owner implementation choice.
- Expiration timestamp format and inclusive vs exclusive boundary comparison.
- Discount bounds and zero-total checkout policy when discount &ge; subtotal (noting card slice rejects zero totals at `orchestrate.ts#L60`), without synthetic taxes or refunds.
- Line-item discount allocation vs whole-order discount representation.
