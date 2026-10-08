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

All requests go to one fixed origin, `coupons.dinkuskit.com` in production
(configurable per environment), under `/v1/stores/{siteId}`. It runs on the
same Cloudflare account and domain as Payments (decided by the project owner on
2026-10-08).

The origin is an API for other programs, not a website. Shoppers' browsers
never call it; Commerce calls it from the store's server. `GET /` returns one
plain-text line naming the service and nothing else. Every other path needs a
valid token for a specific store and returns a JSON error without one.

### Authentication

Bearer JWT, verified the way Payments verifies Commerce today: `RS256` or
`ES256`, issuer and audience from the service's configuration, keys from its
JWKS URL, `site_id` claim equal to `{siteId}` in the path, `iat` no more than
one hour old. Tokens come from the same issuer that signs Payments tokens, so a
store sets up one credential flow, not two (decided for now by the project
owner on 2026-10-08; revisit if DinkusKit gets a shared account issuer).
Scopes:

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
  "regular": { "currency": "USD", "minor": "2000" },
  "sale": { "currency": "USD", "minor": "1500" } }
```

`regular` and the optional `sale` are Commerce's own catalog price record for
the product, read by Commerce at checkout. The evaluator applies the same rules
it applies inside Commerce: the shopper pays `sale` when present, and a line
with a sale price is a sale item for the coupon's sale-item rule. `sale` must
be lower than `regular`. A quote takes 1 to 100 lines, and a product that
appears twice must carry the same price both times. Shipping and tax are never
lines.

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
- `quote` stores the issued quote under `quoteId` for 24 hours. A new
  attempt (`reserve` or `release-unstarted`) accepts only a quote equal, field
  for field, to one the service issued for that store and coupon, so a quote
  cannot be edited between the two calls (`409 QUOTE_NOT_ISSUED`). Retries of
  an attempt that already exists skip this check and rely on the attempt's
  frozen quote.
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
| `PUT /coupons/{couponId}` with `{ expectedRevision, ...changes }` | `edit` |
| `POST /coupons/{couponId}/disable` with `expectedRevision` | `disable` |
| `GET /coupons/{couponId}/counts` | `getCounts` |

Bodies are the inputs Commerce's `CouponAdminPort` already validates: create
takes `{ code, globalCap, rule, disabled? }`, and edit changes any of `code`,
`globalCap`, `disabled` and `rule`. A code already used by another coupon in
the store is `409 CODE_IN_USE`.

### Errors

Errors are `{ "error": { "code": "<CODE>", "message": "<text>" } }`, with the
code taken from Commerce's own error types.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_INPUT` (including unexpected fields, such as a browser total) |
| 401 / 403 | `UNAUTHENTICATED`, `FORBIDDEN` (bad token, wrong `site_id` or scope) |
| 404 | `NOT_FOUND` (unknown code, coupon, attempt or path), `UNKNOWN_ATTEMPT` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CAPACITY_EXHAUSTED`, `CONFLICTING_ATTEMPT`, `TERMINAL_CONFLICT`, `CONTENTION`, `QUOTE_NOT_ISSUED`, `REVISION_CONFLICT`, `CODE_IN_USE` |
| 413 | `BODY_TOO_LARGE` (request bodies over 64 KiB) |
| 422 | `NOT_APPLICABLE` (inactive, disabled, minimum not met) |
| 500 | `CORRUPTED_RECORD`, `STORAGE_UNAVAILABLE`, `INTERNAL` |
| 503 | `NOT_CONFIGURED` (token issuer settings missing) |

Commerce reads responses with the same bounded reader it uses for Payments.

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
- The Registry manifest declares `network:request` with `coupons.dinkuskit.com`
  and `payments.dinkuskit.com` in `allowedHosts`. Commerce's Registry manifest
  asks for no network access today, so Registry stores cannot reach Payments
  yet either; both hosts land together. That changes Commerce's consent
  screen, so it ships with a version bump.
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

- Storage growth: Commerce keeps every attempt inside the coupon record. A
  coupon with a very large cap needs attempts split out of the record before
  it reaches Durable Object value limits; the service will measure this before
  release.

## References

- EmDash, [Capabilities & Security](https://docs.emdashcms.com/plugins/creating-plugins/capabilities/):
  `network:request` reaches only `allowedHosts`, the consent dialog names
  declared hosts, unrestricted access is meant for operator-supplied
  destinations only, and one plugin cannot read another plugin's storage or KV.
- EmDash, [Publishing](https://docs.emdashcms.com/plugins/creating-plugins/publishing/):
  Registry publishing is sandboxed-only, with files capped at 128 KB each.
- EmDash, [Choosing a Plugin Format](https://docs.emdashcms.com/plugins/creating-plugins/choosing-a-format/):
  sandboxed plugins install in one click from the admin Registry; native
  plugins need an npm install, a config edit and a redeploy.
- Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/):
  one Durable Object per unit that needs coordination, with serialized
  operations for booking or inventory-style limits, about 1,000 requests per
  second per object.
- Cloudflare, [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/):
  2 MB per stored value or row and 10 GB per object on Workers Paid, which is
  what the storage-growth question above is measured against.
- Cloudflare, [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):
  how `coupons.dinkuskit.com` attaches to the Worker, with DNS and certificates
  created by Cloudflare.
