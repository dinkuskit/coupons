# DinkusKit Commerce v1 Basic Coupon Boundary & Requirements Handoff

- **Target System**: DinkusKit Commerce v1 Core
- **Extension Repository**: `@dinkuskit/coupons` (deferred post-v1 design stub)
- **Reference Commerce Source Snapshot**: [`8a04c0b16b381b89531c88d1a655aad6c0c461c3`](https://github.com/dinkuskit/commerce/tree/8a04c0b16b381b89531c88d1a655aad6c0c461c3)
- **Reference Nature**: Read-only preparation reference (upstream defines no SDK package or dependency range, and no published SDK range has been verified; this is not a package dependency, integration binding, or pinned package identity)
- **Document Role**: Requirements preparation and bounded semantic API handoff contract. DinkusKit Commerce is the sole owner and implementor; this document defines requirements and boundary invariants without deciding internal interfaces, storage schemas, or runtime engine details.

---

## 1. Executive Summary & Core Boundary Principles

1. **Sole Engine & Money Ownership**:
   DinkusKit Commerce is the sole owner of the basic coupon engine, admin admission, and canonical pricing, cart, checkout, order, and money calculation. The `@dinkuskit/coupons` extension is a deferred post-v1 plugin that will never act as a parallel money writer or calculate conflicting cart totals.

2. **Commerce v1 Scope Baseline**:
   Basic coupon codes are **required** for DinkusKit Commerce v1:
   - At most **one code per order**.
   - Fixed amount or percentage discount.
   - Expiration and usage limits.
   - Discount strictly preserved through checkout to order completion.
   - **No-code checkout remains the baseline**.
   - Basic v1 coupons apply whole-order / storewide. Advanced capabilities (category/item targeting, customer targeting, stacking, BOGO, condition groups, schedules, simulation, reporting) are deferred to post-v1.

3. **Runtime Sandbox Model**:
   Every future plugin and extension must operate within an EmDash Registry-enabled sandbox with no native escape. Final totals and discount validation are strictly server-side; browser-submitted amounts or discounts are never trusted.

4. **Financial Exclusions**:
   Tax, refund, and store-credit semantics are explicitly **excluded** from this basic coupon boundary. Store credit, gift cards, cashback, loyalty, and referrals represent distinct financial and marketing domains.

---

## 2. Commerce Source Reference & Audited Public Exports

The following reference contracts from the Commerce source snapshot ([`8a04c0b`](https://github.com/dinkuskit/commerce/tree/8a04c0b16b381b89531c88d1a655aad6c0c461c3)) define the boundary:

### 2.1 Public Package Exports
As declared in [`package.json`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/package.json):
- `.` &rarr; [`src/index.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/index.ts): Root exports aggregating catalog and checkout features.
- `./features/catalog` &rarr; [`src/features/catalog/index.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/index.ts): Public catalog interface and routes.
- `./features/checkout` &rarr; [`src/features/checkout/index.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/index.ts): Public checkout interface (`startCheckout`, `reconcileCheckout`, `CheckoutError`, `createCheckoutStore`, and types). Note: `freeze()` is internal to `orchestrate.ts` and not exported.

### 2.2 Audited Source Contracts & Invariants

| Contract / Symbol | Source Location | Invariants & Operational Semantics |
| :--- | :--- | :--- |
| `Money` | [`src/features/catalog/types.ts#L129-L132`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/types.ts#L129-L132) | `{ currency: "USD", minor: string }`. Currency constant is `COMMERCE_CURRENCY_USD = "USD"` ([`src/features/catalog/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/types.ts)). |
| `parseMinorUnits` | [`src/features/catalog/money.ts#L11-L23`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/money.ts#L11-L23) | Validates non-negative integer string regex `/^(0\|[1-9][0-9]*)$/`. Parses to `bigint` and strictly enforces upper bound `<= BigInt(Number.MAX_SAFE_INTEGER)`. |
| `normalizeMoney` | [`src/features/catalog/money.ts#L25-L45`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/money.ts#L25-L45) | Validates plain object with exactly two keys (`currency`, `minor`), verifies currency is `"USD"`, and invokes `parseMinorUnits`. |
| `saleIsStrictlyLower` | [`src/features/catalog/money.ts#L53-L58`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/money.ts#L53-L58) | Enforces that stored `sale` price is strictly lower than `regular` price in the same currency. |
| `resolveCatalogItemPrice` | [`src/features/catalog/price.ts#L173-L187`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/price.ts#L173-L187) | **No active sale schedule evaluation**. Reads stored record, validates values, and evaluates `customerPays = price.sale ?? price.regular` at [`price.ts#L185`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/catalog/price.ts#L185). |
| `CartLine` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Untrusted cart input line: `{ catalogItemId: string; quantity: number }`. Validated server-side during pricing and freeze. |
| `CheckoutLine` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Frozen checkout line extending `CartLine` with resolved item name and unit price: `extends CartLine { name: string; unitPrice: Money }`. |
| `CheckoutAttempt.payment` (`PaymentRequest`) | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Carries immutable `attemptId`, `bindingRef`, frozen `lines: CheckoutLine[]`, canonical `total: Money`, `paymentWindowSeconds: 1800`, and `paymentMethods: readonly ["card"]`. |
| `CommerceOrder.total` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Immutable completed order total `total: Money` within `CommerceOrder` (`orderId`, `receiptId`, `attemptId`, `paymentId`, `lines`, `total`). Must exactly match accepted quote and `PaymentRequest.total`. |
| `CheckoutStore.read / compareAndSet` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Storage port for atomic aggregate access: `read(cartId)` retrieves `{ version: string; record: CheckoutRecord } \| null`; `compareAndSet(cartId, version, record)` provides atomic inserts and optimistic concurrency control across processes. |
| `CheckoutExecution` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Execution context holding `store: CheckoutStore`, catalog availability resolvers, inventory provider resolution, and payment provider resolution (`paymentBindingRef`, `resolvePayments`). |
| `startCheckout` | [`src/features/checkout/index.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/index.ts) / [`src/features/checkout/orchestrate.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts) | Public checkout API: `startCheckout(e: CheckoutExecution, cartId: string, rawCart: unknown, retryAfter?: string): Promise<CheckoutAttempt>`. Preserves existing 4-argument signature and caller compatibility. |
| `reconcileCheckout` | [`src/features/checkout/index.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/index.ts) / [`src/features/checkout/orchestrate.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts) | Public checkout API: `reconcileCheckout(e: CheckoutExecution, cartId: string, attemptId: string): Promise<CheckoutAttempt>` driving pending attempt forward via `drive(e, cartId, attemptId, false)`. |
| `freeze()` (internal) | [`src/features/checkout/orchestrate.ts#L26-L62`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts#L26-L62) | **Private internal helper function** (not exported as public API). Resolves catalog item pricing, builds `lines`, enforces zero-total reject gate (`if (minor === "0") fail(...)` at [`orchestrate.ts#L60`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts#L60)), and constructs `CheckoutAttempt` in phase `"reserving"`. Kept strictly internal. |
| `PaymentOutcome` | [`src/features/checkout/types.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/types.ts) | Discriminated union. **Important**: `.total: Money` is present **only** on `{ outcome: "open" }`, `{ outcome: "paid" }`, and `{ outcome: "expired-unpaid" }`. It is **not** present on `{ outcome: "unknown" }` or `{ outcome: "not-created" }`. |
| `drive` State Loop | [`src/features/checkout/orchestrate.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts) | Payment transport exceptions are caught and return the persisted attempt (typically in phase `"paying"`). Total mismatches in `validateOutcome` throw immediately before CAS/order creation and do **not** set phase `"releasing"`. |

---

## 3. Bounded Semantic API Handoff

Rather than prescribing concrete TypeScript interfaces or schemas that belong to the Commerce owner, this section specifies the **required semantic inputs, outputs, identities, statuses, quote acceptance, discount evidence, frozen attempts, and order totals**.

### 3.1 Required Commerce-Owned Capabilities

1. **Promotion Inputs**:
   - Cart line items (item ID, quantity, resolved catalog unit price).
   - Currency context (canonical `"USD"`).
   - Optional single coupon code string (at most one code per order; no-code checkout is baseline).
   - Preserved checkout capability parameters (`cartId`, `retryAfter`).

2. **Promotion Outputs & Statuses**:
   - Status: Clear semantic distinction between applicable, rejected with reason (e.g. invalid code, expired, usage limit reached, criteria not met), and not applied.
   - Quote: Evaluated discount amount in canonical minor units, resulting subtotal, and resulting checkout total.
   - Explicit `unknown` representation: Network or provider transport failures must never be assumed to be successes or clean releases.

3. **Quote Acceptance Invariant**:
   - When a shopper accepts a discount quote (e.g. 1000 item discounted by 250 yielding 750), this quote becomes the accepted checkout total.
   - **No silent escalation**: An accepted quote of 750 may **never** silently revert to 1000. If coupon eligibility changes prior to freeze or payment, any revised quote requires **explicit shopper acceptance**.

4. **Discount Evidence & Frozen Attempt Integrity**:
   - Provenance attached to the frozen checkout attempt (`CheckoutAttempt.payment.lines` or discount record) and persisted into the durable order (`CommerceOrder`).
   - The frozen payment total (`PaymentRequest.total`) must exactly equal the accepted total and match the eventual `CommerceOrder.total`.
   - `startCheckout` caller compatibility: Baseline 4-argument signature `(e, cartId, rawCart, retryAfter?)` must not have its argument positions or semantics broken.

5. **Sole Owner Implementation**:
   - DinkusKit Commerce designs, implements, and maintains the internal data types, storage collections, and service layer. This handoff defines boundary requirements only.

---

## 4. Decided vs. Undecided Owner Boundaries

To prevent over-prescription while guaranteeing safety, the table below delineates locked boundary decisions from open Commerce owner implementation choices:

| Domain | Locked Boundary Requirement | Open Owner Implementation Decision |
| :--- | :--- | :--- |
| **Scope & Multiplicity** | At most one coupon code per order; no-code checkout is the baseline. Storewide/whole-order application in basic v1. Advanced product/customer targeting deferred. | Usage-limit scope (total usage count vs per-customer/order identifier) and policy when code is submitted without items. |
| **Discount Representation** | Fixed minor-unit discount or percentage discount; preserved through checkout. | Basis points vs integer percentage format; precision and rounding methods (e.g. half-up vs floor) against regular vs sale price (noting `saleIsStrictlyLower`). |
| **Lifecycle & Atomicity** | Atomic transition; no double redemption; discount preserved into final order. | Reservation at checkout freeze vs commit at payment capture; usage counter mechanism (mutable counter vs event-log/append-only). |
| **Expiry & Timing** | Expiration limit supported; frozen total cannot silently change post-expiry. | Timestamp representation (epoch seconds vs ms vs ISO string); inclusive vs exclusive deadline comparison at exact expiration boundary. |
| **Discount Bounds & Totals** | Discount cannot cause silent full-price charge; discount exceeding subtotal must be bounded. | Policy when discount &ge; subtotal: cap at subtotal, reject coupon, or zero-total handling (noting current card slice rejects zero totals at [`orchestrate.ts#L60`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts#L60)) without inventing synthetic minimums, refunds, or taxes. |
| **Code Normalization** | Single code accepted and verified server-side. | Case sensitivity (uppercase folding), whitespace trimming, allowed character sets. |
| **Order Consistency** | Total discount evidence must reconcile with `PaymentRequest.total` and `CommerceOrder.total`. | Line-item discount allocation vs whole-order discount line presentation. |

---

## 5. Checkout State Semantics & Failure Handling (Issue 34 Alignment)

The basic coupon boundary aligns strictly with Commerce checkout state machine semantics in [`src/features/checkout/orchestrate.ts`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts) and public Commerce Issue 34 ([`dinkuskit/commerce#34`](https://github.com/dinkuskit/commerce/issues/34)):

### 5.1 Context: Issue 34 Pilot Background vs. Confirmed Commerce v1 Prerequisite
In public Commerce Issue 34 ([`dinkuskit/commerce#34`](https://github.com/dinkuskit/commerce/issues/34)), the original description noted:
> *"Status: follow-up contract/acceptance work. This issue does not enable discounts in the current card/USD checkout slice or make advanced coupons a new launch dependency."*

This historical note reflected an early pilot state where promotions were not yet enabled in the initial card/USD slice and advanced promotional engines were not a launch blocker. Under the confirmed Commerce v1 boundary:
- **Basic coupon codes are a confirmed Commerce v1 core prerequisite**: One code per order, fixed amount or percentage discount, expiration, usage limits, and strict checkout preservation are required in Commerce v1.
- **Advanced promotions remain deferred post-v1 extensions**: Stacking, BOGO, reward products, condition groups, schedules, customer targeting, simulation, and reporting remain deferred to the `@dinkuskit/coupons` extension.

### 5.2 Existing State Machine Invariants
1. **Payment Transport Failure**:
   In `drive()`, transport errors during session creation or lookup are caught by `try { ... } catch { return attempt; }`. The persisted attempt is returned as-is (typically in phase `"paying"`). Transport failures do **not** authorize release, do **not** release coupon usage, and do **not** permit initiating a new attempt.
2. **Unknown Outcome**:
   If `outcome.outcome === "unknown"`, `drive()` returns the persisted attempt. It does **not** transition to `"releasing"`.
3. **Total Mismatch**:
   In `validateOutcome()`, if the payment provider's total does not match `attempt.payment.total`, the function throws `CheckoutError("Payment total mismatch")` before any storage CAS or order creation. It does **not** set phase `"releasing"`. Asserting generic "error &rarr; release" is strictly incorrect.
4. **Authoritative Terminal Release**:
   Only authoritative `{ outcome: "not-created" }` and `{ outcome: "expired-unpaid" }` transition `next.phase = "releasing"`.
5. **Stock Release Gate**:
   In phase `"releasing"`, stock release must return `"released"` before the checkout attempt transitions to phase `"released"`. A new checkout attempt can only be initiated when the previous attempt has reached `"released"`.

---

## 6. Minimal Future Acceptance Design Cases

The table below restores the minimal future acceptance design matrix. These design cases specify required Commerce-side invariants for future test implementation; **no runtime test suite or coupon engine is implemented in this repository**:

| ID | Scenario | Precondition | Trigger / Event | Expected System Invariant | Prohibited / Failure Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TC-01** | **Baseline No-Code Checkout** | Cart with item price 1000 minor units. No coupon code applied. | Shopper initiates checkout. | Total frozen and billed is exactly 1000. `CommerceOrder.total` is 1000. | Any alteration of total without discount. |
| **TC-02** | **Fixed Amount Discount (250 on 1000)** | Item price 1000 minor units. Valid fixed-amount coupon (250 units). | Coupon applied to cart. | Subtotal 1000, discount 250, accepted quote 750. Attempt frozen with `payment.total = 750`. | Silent reversion to 1000; rounding errors. |
| **TC-03** | **Exact Percentage Discount (25% on 1000)** | Item price 1000 minor units. Valid percentage coupon (25%). | Coupon applied to cart. | Evaluated discount 250, accepted quote 750. Attempt frozen with `payment.total = 750`. | Inaccurate basis or percentage evaluation. |
| **TC-04** | **Pre-Freeze Invalidation / Missing / Disabled / Expired / Exhausted** | Cart subtotal 1000. Code is disabled, non-existent, expired, or exhausted prior to freeze. | Shopper submits coupon code or initiates checkout. | Code rejected with clear status; checkout proceeds at full price 1000 or remains un-discounted. Exact expiry boundary (inclusive vs exclusive) follows owner decision. | Applying invalid or expired discount; crashing checkout. |
| **TC-05** | **Stale-Applied UI Clearance & Explicit Acceptance** | Coupon applied in UI, but becomes invalid or revoked before freeze. | Shopper views cart or attempts checkout. | UI clears stale 'applied' status; any revised full-price quote (1000) requires **explicit shopper acceptance**. | Silently proceeding to payment at full price without explicit acceptance. |
| **TC-06** | **Provider Total Mismatch (Issue 34 Invariant)** | Frozen attempt with accepted total 750. | Payment provider returns total 1000 (ignoring discount). | `validateOutcome()` throws `CheckoutError("Payment total mismatch")` before CAS/order. **NO paid order created**; **NO automatic release**. Attempt remains in phase `"paying"`. | Silently creating paid order at 1000; silently releasing attempt. |
| **TC-07** | **Unknown / Lost Response Recovery** | Frozen attempt with total 750 in phase `"paying"`. | Payment provider returns HTTP 500, network drop, or `{ outcome: "unknown" }`. | `drive()` catches error and returns persisted attempt. Retry retains attempt and operation identity; does not re-apply coupon or create duplicate attempt. | Bumping total to 1000; resetting session deadline; releasing holds. |
| **TC-08** | **Cart Mutation Guard** | Attempt frozen with total 750 in phase `"reserving"`. | Shopper attempts to mutate cart (add/remove items, change quantities). | Existing attempt guard prevents parallel active attempts. New attempt rejected until prior attempt reaches terminal `"released"` via release fence. | Mutating frozen cart in-place; running simultaneous attempts on one cart. |
| **TC-09** | **Duplicate Reconcile / Webhook on Paid Order** | Attempt has reached phase `"paid"` with total 750 and created `CommerceOrder`. | Duplicate payment webhook or retry `reconcileCheckout()` received. | Returns existing paid attempt and order total 750 idempotently. | Charging customer twice; modifying order total; recording double coupon redemption. |
| **TC-10** | **Post-Freeze Stale / Expiry / Exhaustion** | Attempt frozen at 750 within valid 1800s payment window. | Coupon expires, is disabled, or exhausts usage limits while shopper is on payment page. | Frozen attempt retains accepted total 750. Owner lifecycle honors frozen session or cancels safely; paid order must **never** be invalidated without refund semantics. | Silently altering payment amount to 1000 upon session completion; corrupting paid order. |
| **TC-11** | **Concurrent Last-Use Race** | Coupon has exactly 1 remaining usage. Two shoppers apply code simultaneously. | Both shoppers attempt checkout concurrently. | Under owner-chosen atomic lifecycle (reserve-at-freeze vs commit-at-paid), exactly one shopper completes paid order with discount; second fails safely or receives revised quote. | Exceeding usage limit; double redemption. |
| **TC-12** | **Fractional Percentages & Zero-Total Gate** | Percentage discount yielding fractional cents, or discount &ge; subtotal. | Shopper applies coupon to cart. | Precision and rounding follow owner decision (e.g. half-up vs floor). Policy when discount &ge; subtotal bounds total (cap vs reject vs zero total, noting card slice rejects 0-total at [`orchestrate.ts#L60`](https://github.com/dinkuskit/commerce/blob/8a04c0b16b381b89531c88d1a655aad6c0c461c3/src/features/checkout/orchestrate.ts#L60)). | Negative totals; synthetic tax/refund injection; silent un-audited clamping. |

---

## 7. Ordered Implementation & Proof Plan

To ensure rigorous boundary enforcement without premature dependencies, the transition to active promotion support follows this ordered sequence:

```
[Commerce Owner Settles Semantics & Canonical Contract]
                      │
                      ▼
[Commerce Implements Basic Engine & Coupon Admin Admission]
                      │
                      ▼
[Proves 750 Total Through Payments & Order Under Failure Invariants]
                      │
                      ▼
[EmDash Registry Admission & Published Release-Range Gates]
```

1. **Step 1: Canonical Contract & Semantics Settlement**:
   Commerce owner settles open decisions: usage limit tracking mechanism (mutable counter vs append-only log), timestamp format and inclusive/exclusive boundary comparison, fractional percentage rounding, and zero-total gate policy.
2. **Step 2: Basic Promotion Engine & Admin Implementation**:
   Commerce implements basic storewide coupon creation, validation, and disablement (type, value, expiration, limits). Admin admission requirements belong strictly to Commerce / future Registry; no coupon engine or admin is implemented in `@dinkuskit/coupons`.
3. **Step 3: Verification of Accepted Total Preservation (750 on 1000)**:
   Commerce proves through Payments and order lifecycle tests that accepted discount (750 total) is strictly preserved, processor mismatches fail closed without automatic release, and duplicate webhooks/retries are idempotent.
4. **Step 4: Registry Admission & Extension Release Gates**:
   Once Commerce publishes its supported public contract and release range, the `@dinkuskit/coupons` extension can be admitted to the Registry sandbox. No extension runtime prerequisite blocks Commerce v1 core.

---

## 8. Public Safe Status

This requirements handoff document is committed to public documentation as the verified boundary specification between DinkusKit Commerce v1 and future promotional extensions.
