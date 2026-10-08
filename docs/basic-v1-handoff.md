# Agreed v1 basic coupon handoff

**Status:** documentation-only requirements handoff. These are confirmed
semantic requirements, not an implemented Commerce or Coupons runtime.

**Owners (updated 2026-10-08):** the ownership in the first version of this
handoff is superseded by [hosted-coupon-service.md](hosted-coupon-service.md).
The confirmed semantics and acceptance matrix below still define the v1 feature
set. For Registry stores, coupon records, the global-cap ledger, redemption
attempts and coupon admin live in the hosted coupon service in this repository,
which runs Commerce's own evaluator pinned by commit. DinkusKit Commerce owns
prices, cart, checkout, order, money, tax and refunds, and sends the service
lines it has already priced. Payments owns transport and payment outcomes.
Templates own shopper presentation. The coupon service never writes an order or
payment amount.

**Historical reference:** the PR6 source snapshot
[`8a04c0b16b381b89531c88d1a655aad6c0c461c3`](https://github.com/dinkuskit/commerce/tree/8a04c0b16b381b89531c88d1a655aad6c0c461c3)
is pinned historical context only. It is not proof of the current checkout
contract, an SDK package, or a dependency range.

## Confirmed semantics

- One coupon code per order.
- The discount is either a percentage or a fixed total amount.
- Eligibility is all merchandise or selected products. Shipping and tax are
  excluded from discount and minimum-spend calculations.
- Merchants choose sale-item inclusion; the v1 default is exclude.
- Minimum spend is measured against eligible merchandise before the coupon.
- Percentage coupons have a maximum discount amount.
- A global redemption cap is required. There are no per-customer
  restrictions or guest-email enforcement.
- While payment is pending, capped usage is reserved. Confirmed success
  consumes it; confirmed failure or cancellation releases it. Unknown
  outcomes require reconciliation and must not be released solely because a
  timer expired. A refund never automatically restores redemption.
- An already-created, still-valid payment session freezes its accepted discount
  despite later edits, disabling, or expiry. New sessions use current rules.
- Commerce persists the frozen discounted order and the payment must use its
  exact accepted total. An evaluator or processor error, timeout, or total
  mismatch fails closed: it must never silently charge the full-price total
  and must not create a paid order until a verified matching success exists.
- EmDash admin must support list/create/edit/disable, explicit-timezone starts
  and ends, and counts. Shoppers can apply and remove a coupon.
- Payment amount, persisted-order amount, and refund behavior require eventual
  cross-owner verification; no runtime success is claimed here.

## Explicit exclusions and questions

No stacking, BOGO, bulk, marketing, analytics, or Inventory dependency is
part of this handoff. Store credit, gift cards, cashback, loyalty, and
referrals remain separate domains.

The owning contract must still settle monetary rounding and allocation, zero
total behavior, and code normalization. These are questions, not policies
invented by this repository.

## Acceptance matrix

| Case | Required eventual acceptance |
| --- | --- |
| Fixed amount | Eligible merchandise of 1000 with a fixed 250 discount yields an accepted 750 total. |
| Percentage | Eligible merchandise of 1000 with a 25% discount yields an accepted 750 total, subject to the owner-accepted rounding rule. |
| Product eligibility | Selected-product and all-merchandise scopes exclude shipping and tax from discount and minimum spend. |
| Sale items | Default excludes sale items; an explicit merchant choice can include them. |
| Minimum spend | The pre-coupon eligible-merchandise amount controls eligibility. |
| Maximum percentage | A percentage result cannot exceed its configured maximum discount amount. |
| Redemption cap | Concurrent attempts cannot consume more than the global cap. Pending reserves, confirmed success consumes, confirmed failure/cancel releases, and unknown outcomes reconcile. |
| Concurrent final slot | Atomic reservation permits no more than one successful consumer of the last slot. |
| Duplicate settlement/retry | Repeated success, failure, or cancellation is idempotent; it cannot double consume or release. |
| Out-of-order stale event | A stale provider event cannot alter the current attempt or release a consumed slot. |
| Invalid browser total | Browser-supplied totals are ignored or rejected; only the frozen accepted total is payable. |
| Forbidden admin access | Admin calls without the store's `coupons:admin` token are rejected and leave coupon, rule, and cap state unchanged. |
| Session freeze | Edits, disablement, or expiry do not change an accepted discount in an existing still-valid payment session; a new session evaluates current rules. |
| Failure/unknown | Evaluation or processor failure, timeout, or accepted-total mismatch fails closed with no silent full-price charge or paid order; unknown remains pending until reconciliation and a timer alone cannot release it. |
| Timezone boundary | Start/end inclusivity and timezone representation remain an explicit owner question. |
| Order/refund | Payment and persisted order retain the accepted amount; refund behavior is verified by the owning order/payment flow, and refunds do not restore redemption automatically. |
| Admin/shopper | Admin lifecycle, explicit time zones, counts, apply, and remove are available through owner-accepted interfaces. |

The HTTP contract that implements these semantics is in
[`hosted-coupon-service.md`](hosted-coupon-service.md).
[`v1-integration-request.md`](v1-integration-request.md) is the earlier
request it replaces, kept for history.
