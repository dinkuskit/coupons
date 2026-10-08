# Hosted coupon service for Registry stores

**Status:** proposed. The GrillTrack decisions `hosted-coupon-service`,
`single-coupon-evaluator`, `coupon-service-http-contract` and
`coupon-admin-registry-plugin` record it. Nothing here is implemented yet.
Merging this document with those decisions locked is what changes the
repository's purpose; until then the Agent Contract's older boundary stands.

## Why this exists

Coupons are table stakes for a store, and the plan was for DinkusKit Commerce
to carry basic coupons itself. Two facts ended that for Registry installs:

- The EmDash Registry caps each plugin file at 128 KiB (131,072 bytes).
  Commerce's compiled backend reached 130,798 bytes, and coupons were about a
  fifth of it. [commerce#75](https://github.com/dinkuskit/commerce/pull/75)
  (merged, Commerce `eafd3e8`) took coupons out of the Registry build; native
  installs keep them only as a developer setup.
- EmDash 1.2 gives one plugin no supported way to call another plugin on the
  same site. `PluginContext` has no plugin-to-plugin call, hooks are a fixed
  list, and plugin storage belongs to one plugin.

DinkusKit plugins ship as Registry plugins (see the README's Install type), so
coupons have to come back in a form a Registry store can install.

### Why not a Coupons plugin on the same site

A Registry plugin can only reach hosts listed in its manifest `allowedHosts`
(`createHttpAccess` and `isHostAllowed` in `emdash@1.2.0`
`dist/context-*.mjs`). Checked against `emdash@1.2.0`,
`@emdash-cms/plugin-cli@0.13.3` and the Registry `releaseExtension` lexicon:

- Patterns are an exact hostname, a leading `*.` subdomain wildcard, or a bare
  `*`. There is no "this site" or same-origin token.
- A store's hostname is unknown when Commerce is published, so the only
  patterns that cover every store are `*` or the
  `network:request:unrestricted` capability. Both let Commerce reach any host,
  and the admin consent screen shows them as "Connect to any network host".
- Every plugin request also passes SSRF validation, and the two plugins would
  still need a shared secret, since a site route is reachable by anyone.

So a same-site Coupons plugin would cost every merchant a broad network
permission on Commerce, which is what the Registry's host list exists to
avoid. A hosted service at one fixed host keeps Commerce's permission narrow.
This is the same pattern Payments and Inventory already use.

## The shape

```
 Shopper ──▶ Commerce (Registry plugin on the store)
                │  prices the cart from its own catalog
                │  HTTPS, scoped JWT, fixed host
                ▼
        DinkusKit Coupons Worker ──▶ Durable Object per store
                                      coupon records + redemption attempts
                ▲
                │  HTTPS, scoped JWT
 Merchant ──▶ Coupons admin (small Registry plugin; CLI later)
```

- **Coupons service** (this repository): a Cloudflare Worker with one Durable
  Object per store (`siteId`). The Durable Object holds that store's coupon
  records and redemption attempts and serializes every change to them, which
  is what makes global redemption caps safe under concurrent checkouts.
- **Commerce** keeps every money decision it owns today: catalog prices, cart,
  checkout, order, payment amount, tax, refunds. It sends the service the
  lines it has already priced and receives a discount quote. It never forwards
  browser-supplied prices or totals.
- **Coupons admin** is a separate small Registry plugin with the admin screens
  (list, create, edit, disable, counts). It calls the same service. An
  operations CLI follows the create-cli pattern used by the other DinkusKit
  CLIs, after this lands.

## One evaluator, imported by commit

The coupon core in Commerce (`src/features/coupons`: evaluator, rule
validation, caps, the reserve, consume, release and reconcile lifecycle,
about 1,350 lines of plain TypeScript) is not copied. The service depends on
`@dinkuskit/commerce` pinned to an exact commit and imports
`@dinkuskit/commerce/features/coupons`, so there is one evaluator.

The core already takes its storage through narrow ports, which is what makes
this work without forking it:

- `CouponCollection` (`get`, `getVersioned`, `put`, `query`, `compareAndSet`)
  is implemented over the store's Durable Object storage.
- `CouponCatalogStorage` (`catalog.get`, price lookup) is implemented in
  memory from the priced lines Commerce sends with each quote. The evaluator
  then sees exactly the prices Commerce charges, and nothing else.

Bumping the pin is a deliberate PR in this repository, with the contract tests
re-run. If Commerce later publishes the core as its own package, the pin
becomes a version range.

## HTTP contract v1

All requests go to one fixed origin (proposed: `coupons.dinkuskit.com`,
configurable per environment) under `/v1/stores/{siteId}`.

### Authentication

Bearer JWT, verified the way Payments verifies Commerce today: `RS256` or
`ES256`, issuer and audience from the service's configuration, keys from its
JWKS URL, `site_id` claim equal to `{siteId}` in the path, `iat` no more than
one hour old. Scopes:

| Scope | Allows |
| --- | --- |
| `coupons:checkout` | quote and the redemption lifecycle |
| `coupons:admin` | coupon create, edit, disable, list, counts |

Commerce holds only `coupons:checkout`. The admin plugin and CLI hold
`coupons:admin`.

### Money and lines

Money is `{ "currency": "USD", "minor": "<non-negative integer string>" }`,
as in Commerce. A priced line is:

```json
{ "productId": "prod_1", "quantity": 2,
  "unitPrice": { "currency": "USD", "minor": "1500" }, "onSale": false }
```

`unitPrice` is what the shopper pays per unit after any sale price, resolved
by Commerce from its own catalog. `onSale` drives the coupon's sale-item rule.
Shipping and tax are never lines.

### Checkout endpoints (`coupons:checkout`)

| Method and path | Port operation | Body | Success |
| --- | --- | --- | --- |
| `POST /quotes` | `quote` | `{ quoteId, code, lines }` | `200 { couponId, quote }` |
| `POST /redemptions` | `reserve` | `{ couponId, attemptId, quote, overallPayableTotal }` | `200 { attempt }` |
| `POST /redemptions/{attemptId}/release-unstarted` | `releaseUnstarted` | `{ couponId, quote, overallPayableTotal }` | `200 { attempt }` |
| `POST /redemptions/{attemptId}/provider-session` | `attachProviderSession` | `{ couponId, providerSessionId }` | `200 { attempt }` |
| `POST /redemptions/{attemptId}/reconcile` | `reconcile` | `{ couponId, reconciliation }` | `200 { attempt }` |
| `POST /redemptions/{attemptId}/free-order` | `reconcileFreeOrder` | `{ couponId, proof }` | `200 { attempt }` |
| `GET /redemptions/{attemptId}?couponId=` | `get` | | `200 { attempt }` or `404` |

`quote`, `attempt`, `reconciliation` and `proof` use Commerce's existing
`CouponQuote`, `CouponAttempt`, `CouponProviderReconciliation` and
`CouponFreeOrderProof` shapes unchanged. In checkout terms: reserve holds a
capped use while payment is pending, a `verified-success` reconciliation
consumes it, `confirmed-failure`, `confirmed-cancel` and `verified-not-created`
release it, and `unknown` keeps it pending until a later reconciliation.

Rules the service enforces:

- The service uses its own clock for "now". Commerce does not send it.
- `quote` stores the issued quote under `quoteId`. `reserve` accepts only a
  quote byte-for-byte equal to one the service issued for that store, so a
  quote cannot be edited between the two calls.
- Every lifecycle call is idempotent on `attemptId`. Retrying with the same
  body returns the same attempt; a different body for the same attempt is a
  `409 CONFLICTING_ATTEMPT`.
- An attempt that already has a payment session keeps its accepted discount
  after the coupon is edited, disabled or expires. New quotes use current
  rules.

### Admin endpoints (`coupons:admin`)

| Method and path | Port operation |
| --- | --- |
| `GET /coupons` | `list` |
| `POST /coupons` | `create` |
| `GET /coupons/{couponId}` | `get` |
| `PUT /coupons/{couponId}` with `expectedRevision` | `edit` |
| `POST /coupons/{couponId}/disable` with `expectedRevision` | `disable` |
| `GET /coupons/{couponId}/counts` | `getCounts` |

Bodies are the inputs Commerce's `CouponAdminPort` already validates.

### Errors

Errors are `{ "error": { "code": "<CODE>", "message": "<text>" } }`, with the
code taken from Commerce's own error types.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_INPUT` |
| 401 / 403 | `UNAUTHENTICATED`, `FORBIDDEN` (bad token, wrong `site_id` or scope) |
| 404 | `NOT_FOUND` (unknown code, coupon or attempt) |
| 409 | `CAPACITY_EXHAUSTED`, `CONFLICTING_ATTEMPT`, `TERMINAL_CONFLICT`, `CONTENTION` |
| 422 | `NOT_APPLICABLE` (inactive, disabled, minimum not met, no eligible items) |
| 500 | `CORRUPTED_RECORD`, `STORAGE_UNAVAILABLE` |

Response bodies are capped at 64 KiB, and Commerce reads them with the same
bounded reader it uses for Payments.

### When the service is down

- **Quote fails** (timeout, network error, 5xx): the coupon is unavailable.
  The shopper is told the code can't be applied right now, and checkout
  carries on at full price only if the shopper continues without it.
- **Reserve fails or its outcome is unknown**: Commerce retries with the same
  `attemptId`. It never starts a payment session for the discounted total
  without a reserved attempt, and it never silently charges the undiscounted
  total for a session the shopper accepted with a discount. This is the
  existing `checkout-total-preservation` decision.
- **Reconcile fails**: the attempt stays pending, which holds a capped use but
  never loses money. Commerce retries from its existing payment wake path.

## What changes in Commerce (separate PRs there)

- An HTTP `CheckoutCouponPort` that resolves prices from Commerce's catalog,
  sends priced lines, and maps the endpoints above. It must keep Commerce's
  Registry backend under 128 KiB, measured with the official packager.
- The Registry manifest declares `network:request` with the coupons host in
  `allowedHosts`. That changes Commerce's consent screen, so it ships with a
  version bump.
- Settings for the coupons origin and a `coupons:checkout` credential, stored
  the way the Payments credential is.

## Proof before release

- The contract tests run Commerce's own coupon test cases through the HTTP
  port against the Worker in `wrangler dev`.
- The acceptance matrix in [v1-integration-request.md](v1-integration-request.md)
  passes end to end: Registry Commerce plus this service plus Payments test
  mode.
- Both the Coupons admin plugin and Commerce's Registry build pass
  `emdash-plugin validate` and the 128 KiB per-file check.

## Open questions

- Hosting and account: which Cloudflare account and hostname serve production,
  and who issues `coupons:*` tokens (the Payments issuer, or a shared DinkusKit
  account issuer).
- Storage growth: Commerce keeps every attempt inside the coupon record. A
  coupon with a very large cap needs attempts split out of the record before
  it reaches Durable Object value limits; the service will measure this before
  release.
