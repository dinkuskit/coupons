# v1 integration request

**Status: superseded on 2026-10-08** by
[hosted-coupon-service.md](hosted-coupon-service.md), which the project owner
accepted. This request is kept for history. Its ownership boundary, proposed
ports and owner acceptance matrix no longer apply: coupon records, the cap
ledger, redemption attempts and coupon admin moved to the hosted coupon
service, with Commerce keeping prices, cart, checkout, order, money, tax and
refunds. The required lifecycle matrix below still describes required
behavior; where it says "Commerce reservation", the reservation is now made by
the coupon service at Commerce's request, before any payable provider session.

## Ownership boundary (superseded)

Commerce owns coupon evaluation, canonical quote/order construction, and the
durable atomic global-cap ledger. Payments only transports the Commerce-accepted
amount and reports verified provider outcomes. Template storefront owns
shopper-facing apply/remove/display. EmDash merchant admin is owned by
Commerce, not Template. No browser amount, payment session, or provider event
may perform coupon evaluation, build an order, or count redemptions.

## Proposed semantic ports (superseded)

These are review shapes, not typed contracts to implement. Commerce, Payments,
and Template owners must accept or replace them against an immutable baseline.

```ts
type CouponScope =
  | { kind: "all-merchandise"; includeSaleItems: boolean }
  | { kind: "selected-products"; productIds: string[]; includeSaleItems: boolean };

type CouponRule = {
  code: string;
  discount: { kind: "fixed-total"; amount: Money }
    | { kind: "percentage"; rate: PercentageRepresentationPending; maximum: Money };
  scope: CouponScope;
  minimumEligibleMerchandise: Money;
  redemptionCap: number;
  startsAt: string;
  endsAt: string;
};

type AcceptedCoupon = {
  couponId: string;
  code: string;
  discount: Money;
  eligibleMerchandise: Money;
  acceptedTotal: Money;
  attemptId: string;
  immutableRuleRevision: string;
  immutableQuoteRevision: string;
};
```

`PercentageRepresentationPending` is a compilable placeholder type for an
unresolved owner decision; it does not choose basis points, integer percent,
precision, or rounding. `Money`, allocation, zero-total behavior, normalization,
timestamps, and storage identities are also unresolved.

The proposed Commerce-owned cap port is conceptually equivalent to:

```ts
type PercentageRepresentationPending = never;

reserveCap(
  attemptId: string,
  couponId: string,
  immutableRuleRevision: string,
  immutableQuoteRevision: string,
  idempotencyKey: string,
): Promise<"reserved" | "already-reserved" | "unavailable">;

mapProviderSession(
  attemptId: string,
  couponId: string,
  immutableRuleRevision: string,
  immutableQuoteRevision: string,
  providerSessionId: string,
  idempotencyKey: string,
): Promise<"mapped" | "already-mapped" | "conflict">;

settleCap(
  attemptId: string,
  couponId: string,
  immutableRuleRevision: string,
  immutableQuoteRevision: string,
  providerSessionId: string | undefined,
  outcome: "confirmed-success" | "confirmed-failure" | "cancelled" | "unknown",
  idempotencyKey: string,
): Promise<"consumed" | "released" | "pending" | "already-final">;
```

These names and return values are proposed requirements, not implemented APIs.
Commerce must atomically reserve the cap **before** Payments creates a payable
provider session, keyed by the durable Commerce attempt, coupon, immutable rule
revision, and immutable quote revision. The provider session ID is absent from
the reservation; after confirmed creation, Payments maps that ID exactly once to
the original durable attempt. It is never a replacement key for the attempt.
Atomic concurrency is required for the cap ledger. Duplicate
success/failure/cancel events are idempotent; stale out-of-order events cannot
double consume or release a consumed slot. A quote acceptance/change creates a
safe current attempt identity; retries retain the frozen original attempt.
Unknown create or transport outcomes hold the reserved slot until authoritative
reconciliation. Only a verified not-created result safely releases it. Unknown
settlement remains pending until verified reconciliation; a timer alone cannot
release it, and a refund does not automatically restore redemption.

Commerce persists the frozen discounted order. Payments carries only the exact
accepted amount and verified outcomes; it never counts usage, constructs an
order, or evaluates a coupon.

## Acceptance matrix by owner (superseded)

| Owner | Requested acceptance | Evidence required |
| --- | --- | --- |
| Commerce | Evaluates one code/order, persists the frozen accepted quote/order, owns merchant admin and the atomic cap ledger, and defines immutable attempt/rule/quote identities. | Immutable baseline, accepted contract, and owner tests. |
| Payments transport | Creates/maps a provider session once, carries the exact accepted amount, and reports only verified success/failure/cancel/unknown outcomes. It never evaluates coupons, constructs orders, or counts usage. | Provider-transport contract and reconciliation proof. |
| Template storefront | Shopper apply/remove/display and stale/current-session states. | Accepted shopper contract and user-visible verification. |

The existing checkout owner must provide the immutable baseline and typed
acceptance for payment-session freeze, payment amount, persisted-order amount,
merchant admin, and refund behavior before any runtime integration is attempted.

## Required lifecycle matrix

| Case | Required behavior |
| --- | --- |
| Concurrent final slot | Atomic Commerce reservation occurs before any payable provider-session creation and permits no more than one successful consumer of the last slot. |
| Duplicate settlement/retry | Repeated success, failure, or cancellation is idempotent and cannot double consume/release. |
| Out-of-order stale event | A stale event cannot change the current attempt or release a consumed slot. |
| Invalid browser total | Commerce ignores or rejects browser totals; only the frozen accepted total is payable. |
| Forbidden admin access | Non-Commerce admin access is rejected and leaves coupon/rule/cap state unchanged. |
| Timezone boundary | Start/end inclusivity and timezone representation remain an explicit owner question. |
| Refund | A refund does not automatically restore redemption. |
| Failure | Evaluation/processor failure, timeout, or accepted-total mismatch fails closed; it must not silently charge full price or create a paid order. A verified not-created provider session releases the pre-existing reservation safely. |
| Unknown create/transport outcome | The pre-existing reservation remains held until authoritative reconciliation; it is not released merely because session creation did not return a definitive result. |
| Unknown settlement outcome | The hold remains pending until verified reconciliation; a timer alone cannot release it. |

## Historical and scope notes

The PR6 Commerce commit
[`8a04c0b16b381b89531c88d1a655aad6c0c461c3`](https://github.com/dinkuskit/commerce/tree/8a04c0b16b381b89531c88d1a655aad6c0c461c3)
is a historical reference only. It does not prove these proposals, define a
current SDK, or authorize a dependency.

No stacking, BOGO, bulk, marketing, analytics, Inventory dependency, customer
restriction, or guest-email enforcement is requested. Rounding/allocation,
zero-total behavior, and normalization remain questions.

WooCommerce's official coupon-management documentation
([checked September 30, 2026](https://woocommerce.com/document/coupon-management/))
groups coupon controls under general settings, restrictions, and usage limits.
This handoff differs in an important detail: its fixed discount is a total
discount semantic, whereas WooCommerce describes fixed-product coupons as
applied per item. WooCommerce's minimum-spend discussion includes subtotal plus
tax; this handoff measures eligible merchandise before the coupon and excludes
shipping and tax. No additional shipping, category, or email scope is adopted
from that comparison.
