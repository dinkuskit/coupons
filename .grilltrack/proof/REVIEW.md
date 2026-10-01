# Review & Adjudication: Coupons v1 Boundary Handoff Documentation

- **Source Identity**: `sha256:96e85995505f732976b00a0492e95396cb6026e3141514ea66484b99cbf21a85`
- **Target**: `docs/basic-v1-handoff.md`
- **Adjudication**: `findings`
- **Classifications**: `reject_false_positive`, `required_fix`

---

## 1. Adjudication of Prior Review Claims

### 1.1 False Positive: `Money` Interface Location
- **Prior Claim**: The prior review incorrectly asserted that `Money` at `src/features/catalog/types.ts#L129-L132` was an invalid reference and rejected the anchor.
- **Audited Source Grounding**: In the pinned Commerce source snapshot (`8a04c0b16b381b89531c88d1a655aad6c0c461c3`), [`src/features/catalog/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/types.ts) lines 129–132 explicitly define:
  ```ts
  export interface Money {
    currency: typeof COMMERCE_CURRENCY_USD;
    minor: string;
  }
  ```
- **Adjudication**: **`reject_false_positive`**. The anchor at `types.ts#L129-L132` is valid and correct. Rejecting it was a false positive. Documentation notes claiming this anchor was invalid are corrected.

### 1.2 Audited Anchor Precision vs. Whole-File Links
To prevent brittle or misaligned line numbers from being claimed as audited:
- `price.customerPays` in [`src/features/catalog/price.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/price.ts) is at **line 185** (not 184).
- `saleIsStrictlyLower` in [`src/features/catalog/money.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/money.ts) begins at **line 53** (not 51).
- The zero-total checkout reject in [`src/features/checkout/orchestrate.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts) is at **line 60** (`if (minor === "0") fail(...)`, not 61).
- Documentation should cite verified exact lines or link whole files directly rather than claiming unverified ranges.

---

## 2. Accepted Required Fixes (`required_fix`)

The following documentation and contract corrections are accepted and resolved:

### 2.1 Missing Checkout Source Contracts & Invariants
The handoff specification must explicitly document existing checkout types and functions from `src/features/checkout/types.ts`, `src/features/checkout/index.ts`, and `src/features/checkout/orchestrate.ts`:
- `CartLine`: Input cart line item `{ catalogItemId: string; quantity: number }`.
- `CheckoutLine`: Line item frozen into checkout extending `CartLine` with resolved item name and unit price: `extends CartLine { name: string; unitPrice: Money }`.
- `CheckoutAttempt.payment`: Carries `PaymentRequest` with immutable attempt ID, provider binding reference, frozen `lines: CheckoutLine[]`, canonical `total: Money`, `paymentWindowSeconds: 1800`, and `paymentMethods: readonly ["card"]`.
- `CommerceOrder.total`: Immutable final order total (`CommerceOrder.total: Money`), matching accepted quote and payment total.
- `CheckoutStore.read / compareAndSet`: Atomic read (`read(cartId): Promise<{ version: string; record: CheckoutRecord } | null>`) and optimistic concurrency control (`compareAndSet(cartId, version, record): Promise<boolean>`).
- `CheckoutExecution`: Execution context carrying store, catalog availability, inventory provider resolution, and payment provider resolution.
- `reconcileCheckout`: Public checkout API (`reconcileCheckout(e, cartId, attemptId)`) driving pending checkout attempts to resolution.
- `freeze()`: **Private internal helper** in `orchestrate.ts` that resolves catalog pricing and constructs the reserving attempt; kept strictly private and internal, never exported as public checkout API.

### 2.2 Narrowing Basic v1 Scope (Excluding Category/Item Targeting)
- The owner-decisions row in `docs/basic-v1-handoff.md` previously claimed max scope (storewide vs category vs item-level) was an open decision.
- In basic Commerce v1, basic coupon codes apply storewide / whole-order. Advanced category/item eligibility, condition groups, and customer targeting remain deferred to the post-v1 `@dinkuskit/coupons` extension rather than a basic v1 prerequisite.
- Usage-limit scope, count, and reservation/commit/release semantics remain owner decisions, but targeting is strictly deferred.

### 2.3 Minimal Future Acceptance Design Cases Restored
The handoff document restores the comprehensive acceptance matrix:
1. **Baseline No-Code Checkout**: 1000 minor units item produces 1000 minor units total.
2. **Fixed 250 & Exact 25% Discount**: Both evaluate against neutral 1000 subtotal to yield 750 accepted total.
3. **Pre-Freeze Invalidation**: Invalid, disabled, missing, expired, or exhausted code before `freeze()` rejects application; exact expiry boundary comparison (inclusive vs exclusive) remains owner decision.
4. **Stale-Applied UI Clearance & Explicit Acceptance**: Stale or revoked promotion cannot silently charge full price 1000; UI must clear stale applied state, and any revised full-price quote requires explicit shopper acceptance.
5. **Provider Total Mismatch Fail-Closed**: Payment provider total 1000 vs accepted 750 rejects with no paid order and NO automatic release.
6. **Unknown / Lost Response Recovery**: Idempotent retry retains attempt and operation identity without generating a duplicate checkout or modifying accepted totals.
7. **Cart Mutation Guard**: Changing cart items or quantities follows existing frozen guard; requires terminal release before a new checkout attempt can be created.
8. **Duplicate Usage / Webhook / Paid Order**: Re-reconciliation of an already-paid attempt returns existing paid attempt and order total 750 without duplicate charges or modifications.
9. **Post-Freeze Stale / Expiry / Exhaustion**: A frozen attempt retains its accepted 750 total; expiry or exhaustion post-freeze does not silently bump amount to 1000.
10. **Concurrent Final-Use Race**: At most one shopper completes paid order with the final available usage under owner-chosen atomic lifecycle.
11. **Fractional Percentages & Discount Bounds**: Rounding and zero-total gate (noting card slice rejects zero totals at `orchestrate.ts#L60`) depend on owner decisions.
12. **Admin Admission & Ordered Plan**: Coupon creation/disablement admission requirements belong to Commerce / future Registry only. Ordered dependency plan:
    `Commerce owner settles semantics -> implements basic engine/admin -> proves 750 through Payments and order under failures -> Registry admission/release-range gates; no extension runtime prerequisite`.

### 2.4 Commerce Issue 34 Clarification
- Explicitly link public Commerce Issue 34 ([dinkuskit/commerce#34](https://github.com/dinkuskit/commerce/issues/34)).
- Clarify the original pilot status statement ("Status: follow-up contract/acceptance work. This issue does not enable discounts in the current card/USD checkout slice or make advanced coupons a new launch dependency") vs the confirmed Commerce v1 prerequisite: basic coupon codes are a confirmed Commerce v1 core requirement, while advanced promotions remain deferred post-v1 extensions.

### 2.5 SDK Range Gating & Proof Hygiene
- In `AGENTS.md`, remove the assumed `@dinkuskit/commerce-sdk` package requirement. Gate future implementation on actual supported Commerce public contracts and published release ranges when available.
- In `docs/basic-v1-handoff.md`, remove the local worktree path reference (`.grilltrack/work/v1-boundary-20260930/commerce-source`).
- In `.grilltrack/proof/PROOF.md`, omit guessed timestamps or use actual verification time; ensure all links are repository-relative with no `file://`, local paths, or job IDs.
- Relocate this review artifact from root `REVIEW.md` to `.grilltrack/proof/REVIEW.md`.
