# `dinkus-coupons` CLI Specification

Status: locked v1 interface, implemented in this repository against the
hosted coupon service. The project owner approved GrillTrack decisions
`coupons-cli-v1` and `coupon-admin-preview-confirm` on 2026-10-10. The
service is not deployed, so examples here are contract transcripts with
fictional IDs, not production proof.

## Name and purpose

Executable: `dinkus-coupons`

Package: `@dinkuskit/coupons` (private, unpublished)

One-liner: list, create, and turn coupons on or off in the hosted DinkusKit
coupon service, with a preview a person confirms before anything changes.

`dinkus-coupons` is a client of the service's HTTP contract
([hosted-coupon-service.md](hosted-coupon-service.md)), not a second coupon
engine. It never opens the store's Durable Object, never checks coupon rules
itself, and never sets a price. Rule validation, code uniqueness, revisions,
and use counts stay in the service, which runs Commerce's own coupon core.

It ships outside every plugin bundle, so it adds nothing to the Coupons admin
plugin or to Commerce's Registry backend.

## Implementation shape

```text
bin/dinkus-coupons.mjs   thin executable entrypoint
cli/kernel.mjs           shared DinkusKit CLI kernel (byte-identical with
                         Commerce, Inventory and Payments)
cli/spec.mjs             command tree, flags, help text
cli/client.mjs           connection rules and the authenticated service client
cli/commands.mjs         command behaviour and output shaping
cli/pending-store.mjs    operator-local store for changes with an unknown outcome
```

Dependency-free ESM on Node 22 (`.nvmrc`), no build step. The package
manifest maps `"bin": { "dinkus-coupons": "./bin/dinkus-coupons.mjs" }`.
Nothing under `src/` imports `cli/`, and nothing under `cli/` imports the
Worker or the vendored coupon core.

## Usage

```text
dinkus-coupons [global flags] <noun> <verb> [arguments]
```

`-h` and `--help` show help for the command named so far and ignore every
other argument. `--version` prints only the installed version. Both exit `0`.

## Command tree

```text
dinkus-coupons coupons list
dinkus-coupons coupons show <coupon-id>
dinkus-coupons coupons create
dinkus-coupons coupons disable <coupon-id>
dinkus-coupons coupons enable <coupon-id>
dinkus-coupons coupons edit <coupon-id>          (planned)

dinkus-coupons commands show <command-id>
dinkus-coupons commands resolve <command-id>
```

### Read commands

- `coupons list` reads `GET /coupons`: every coupon in the store with its
  code, on/off state, discount, end time, total uses allowed, and revision.
- `coupons show` reads `GET /coupons/{id}` and `GET /coupons/{id}/counts`:
  the coupon plus how many uses are consumed, held by checkouts in progress,
  and left. The coupon's redemption attempts are never printed.

### Change commands

- `coupons create` creates one coupon from the agreed v1 terms: one code,
  percentage (with an optional maximum) or fixed USD amount off, all
  merchandise or selected Commerce products, sale items excluded unless
  `--include-sale-items`, a minimum eligible spend, a start and end with an
  explicit time zone, and a total use cap.
- `coupons disable` turns a coupon off. Checkouts that already reserved it
  keep their accepted discount (`agreed-v1-session-freeze`); new checkouts
  cannot apply it.
- `coupons enable` turns a coupon back on.
- `coupons edit` is planned. It exits `1` with `not_implemented` and sends
  nothing. The service previews edits (`action: "edit"`) since the Coupons
  admin plugin needed them; the CLI command comes in a later change.

Deleting a coupon is not offered: coupon records hold the redemption history
that caps depend on. Turn a coupon off instead.

## Global flags

| Flag | Contract |
| --- | --- |
| `-h`, `--help` | Show context-appropriate help; ignore other arguments. |
| `--version` | Print only the installed version. |
| `--profile <name>` | Select non-secret endpoint and site metadata from config. |
| `--endpoint <url>` | Coupon service origin, such as `https://coupons.example`. Never carries credentials. |
| `--site <id>` | Store id (the pass's `site_id`). Required as a flag for changes. |
| `--json` | Emit exactly one JSON document on stdout. Not with `--plain`. |
| `--plain` | Emit one tab-separated `key=value` record per line. Not with `--json`. |
| `--no-input` | Never prompt. A change without `--confirm` fails closed. |
| `--no-color` | Disable color. `NO_COLOR` and `TERM=dumb` do the same. |
| `--timeout <duration>` | Bound each request. A change that times out after sending is `unknown`, never assumed failed. |

Profiles and the environment may choose the store for reads. A change needs
`--site` on that command line; the CLI never takes a change's store from a
profile, the environment, a hostname, or the current directory. Every result
repeats the resolved store and endpoint in `context`.

## `coupons create` flags

| Flag | Contract |
| --- | --- |
| `--code <code>` | Required. The code shoppers type; matching ignores case. The service refuses a code another coupon in the store uses (`CODE_IN_USE`). |
| `--percent <p>` | Percentage off eligible merchandise, more than 0 and at most 100, up to two decimals. Exactly one of `--percent` and `--amount`. |
| `--max-discount <usd>` | Largest discount a `--percent` coupon gives. Not allowed with `--amount`. |
| `--amount <usd>` | Fixed USD amount off eligible merchandise. |
| `--min-spend <usd>` | Eligible merchandise needed before the coupon applies. Default `0`. |
| `--product <product-id>` | Repeatable. Limits the coupon to these Commerce products; without it the coupon applies to all merchandise. |
| `--include-sale-items` | Let the coupon discount items already on sale. Default: excluded. |
| `--starts <time>` | Start time with a UTC offset, such as `2026-11-01T00:00:00-05:00`. Default: the moment the service previews the change, shown in the preview. |
| `--ends <time>` | Required. End time with a UTC offset. |
| `--time-zone <zone>` | IANA time zone the store reports in. Default `UTC`. |
| `--cap <uses>` | Required. Total uses allowed across all shoppers, a whole number from 1. |
| `--disabled` | Create the coupon turned off. |

Amounts are USD with at most two decimals (`5`, `12.50`) and are sent as
Commerce money, `{ "currency": "USD", "minor": "1250" }`. Malformed input
exits `2` before anything is sent. Every other rule (end after start, a known
time zone, product ids) is the service's to judge.

## Preview and confirmation

There is no `--force`. Every change is previewed by the service and committed
only with that preview's confirmation value.

- `--dry-run` asks the service for a preview (`POST /coupons/previews`) and
  prints it with a confirmation value. Nothing changes.
- `--confirm <value>` commits the change only if the request is exactly the
  one previewed. Not with `--dry-run`.
- With neither flag in an interactive terminal, the CLI previews, prints the
  preview to stderr, and asks the person to type the confirmation value. Any
  other answer, or end of input, sends nothing (exit `4`, `not_confirmed`).
- With `--no-input` and no `--confirm`, the change stops before contacting
  the service (exit `4`, `confirmation_required`).

The safe pattern for scripts and agents is two runs with the same arguments:

1. run with `--dry-run --json` and read `data.before`, `data.after`, and
   `confirmation`;
2. run again with `--no-input --confirm <value> --json` before
   `confirmation.expiresAt`.

The service binds a confirmation to the store, the exact request, and, for
turning a coupon off or on, the coupon's revision at preview time. It lasts
five minutes and can be used once. A create preview also fixes the values the
service filled in (the rule id, and the start time when `--starts` was left
out), so the coupon created is the one previewed. A confirmation is not a
credential: it cannot approve a different code, amount, product, store, or a
coupon that changed since the preview (`REVISION_CONFLICT`).

## Changes whose outcome is unknown

Immediately before sending a change, the CLI picks a command id
(`cmd-` plus 32 hex characters), freezes the request body, and writes both to
the operator-local pending store, `$XDG_STATE_HOME/dinkuskit/coupons/commands/`
(default `~/.local/state/...`), with user-only permissions. The record holds
the command id, store, endpoint, frozen body and its digest, and the terminal
result once known. It never holds the pass or coupon records.

If the request fails after sending (network error, timeout, 5xx, or an answer
outside the contract), the CLI prints `outcome=unknown` and the command id,
keeps the frozen request, and exits `3` (`5` for an answer outside the
contract). Then:

- `commands show <command-id>` prints the local record and asks the service
  (`GET /coupons/commands/{id}`) whether that command was committed.
- `commands resolve <command-id>` resends the exact frozen bytes under the
  same command id. The service answers an exact retry with the first result,
  even after the five-minute window, so this never makes a change twice. A
  closed record returns its stored result without sending anything; a missing
  or altered record blocks replay.

Both need the same `--site` and `--endpoint` the change was sent with
(`context_mismatch` otherwise).

## Output contract

Default output is short human-readable text. Times show as wall-clock time in
the coupon's own time zone. Warnings, prompts, and diagnostics go to stderr;
requested data goes to stdout.

`--json` emits one document with `schema` (`dinkuskit.coupons.cli/v1`),
`command`, `outcome`, and `context` (`siteId`, `endpoint`). Read commands use
`outcome: "ok"` and `data`, which passes the service's records through. A
preview uses `outcome: "preview"` with `data` (`action`, `couponId`,
`before`, `after`) and `confirmation` (`value`, `expiresAt`). A change result
carries `commandId` and exactly one of:

- `data`, the committed coupon, when `outcome` is `committed`;
- `rejection` (`code`, `message`) when `outcome` is `rejected`; or
- `unknown` (`reason`, `next`) when `outcome` is `unknown`.

Failures carry `error` (`code`, `message`) and the resolved `context`.

`--plain` prints one record per line. The first fields are always `schema`,
`command`, and `outcome`. Coupon records continue with `record=coupon`,
`couponId`, `code`, `disabled`, `discount` (JSON), `appliesTo`, `startsAt`,
`endsAt`, `globalCap`, and `revision`; `coupons show` adds `consumed`,
`pending`, and `remaining`. Tabs, newlines, and backslashes in values are
escaped.

JSON and plain field names are compatibility surfaces. New optional fields may
appear within v1; changed meanings need a new schema version. Human text is not
a parsing interface.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Read done, preview returned, change committed, or command looked up. |
| `1` | The service refused the change on its merits (`rejected`: `INVALID_INPUT`, `NOT_FOUND`, `REVISION_CONFLICT`, `CODE_IN_USE`, or `NO_CHANGE` at preview), a coupon or command was not found, or the command is planned. Nothing changed. |
| `2` | Fix the invocation: bad flag, missing argument, malformed amount or time, invalid id, invalid non-secret config. |
| `3` | The service could not be reached, or a sent change has an unknown outcome. |
| `4` | Blocked: missing pass, pass refused (401/403), endpoint from project config, confirmation required, not confirmed, or the confirmation gate (`CONFIRMATION_NOT_FOUND`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_ALREADY_USED`, `CONFIRMATION_MISMATCH`, `CONFLICTING_COMMAND`). Only a fresh preview retries a gate refusal. |
| `5` | The service answered outside its contract. Stop and report. |

Ctrl-C before a change is sent exits `4` with nothing sent. After sending, it
exits `3` with the frozen request kept for `commands resolve`.

## Configuration and authentication

Non-secret configuration precedence:

```text
flags > environment > project config > user config > built-ins
```

- environment: `DINKUS_COUPONS_ENDPOINT`, `DINKUS_COUPONS_SITE`,
  `DINKUS_COUPONS_PROFILE`;
- project config: `.dinkuskit/coupons.json`, shared non-secret metadata only;
- user config: `$XDG_CONFIG_HOME/dinkuskit/coupons/config.json`;
- built-ins: output and timeout defaults only. There is no built-in
  production endpoint or store.

The pass is a `coupons:admin` token for the store, supplied only through
`DINKUS_COUPONS_TOKEN` by the operator's secret manager or shell. There is no
`--token` flag, and a config file containing a secret-looking key is refused.
Error output names the variable, never its value.

The pass is sent only to an endpoint from `--endpoint`,
`DINKUS_COUPONS_ENDPOINT`, or user config. Project config comes with the
working directory, so when it supplies the endpoint, directly or through a
profile, every command stops with `untrusted_endpoint` (exit `4`) before
sending anything. Project config may still supply the store for reads.

The service, not the CLI, decides what a pass may do. The CLI grants nothing.

## Contract transcripts

### List coupons

```sh
dinkus-coupons --endpoint https://coupons.example --site store_demo coupons list
```

```text
CODE    COUPON ID  ON   DISCOUNT                  ENDS                     USES  REV
FALL10  cpn_demo   yes  10% off (at most $25.00)  2026-11-30 22:59:59 CST  500   1
```

### Preview a coupon

```sh
dinkus-coupons --endpoint https://coupons.example --site store_demo \
  coupons create --code FALL10 --percent 10 --max-discount 25 \
  --starts 2026-11-01T00:00:00-05:00 --ends 2026-11-30T22:59:59-06:00 \
  --time-zone America/Chicago --cap 500 --dry-run --json
```

```json
{
  "schema": "dinkuskit.coupons.cli/v1",
  "command": "coupons.create",
  "outcome": "preview",
  "context": { "siteId": "store_demo", "endpoint": "https://coupons.example" },
  "data": {
    "action": "create",
    "couponId": null,
    "before": null,
    "after": {
      "code": "FALL10",
      "globalCap": 500,
      "disabled": false,
      "rule": {
        "ruleId": "rule_demo",
        "version": 1,
        "discount": {
          "kind": "percentage",
          "basisPoints": 1000,
          "maximum": { "currency": "USD", "minor": "2500" }
        },
        "appliesTo": "all-merchandise",
        "selectedProductIds": [],
        "includeSaleItems": false,
        "minimumEligibleMerchandise": { "currency": "USD", "minor": "0" },
        "startsAt": "2026-11-01T05:00:00.000Z",
        "endsAt": "2026-12-01T04:59:59.000Z",
        "timeZone": "America/Chicago"
      }
    }
  },
  "confirmation": {
    "value": "cfm-0123456789abcdef0123456789abcdef",
    "expiresAt": "2026-10-10T12:05:00.000Z"
  }
}
```

### Commit it

The same arguments with `--no-input --confirm cfm-0123456789abcdef0123456789abcdef --json`
replacing `--dry-run --json` return `outcome: "committed"`, a `commandId`, and
the new coupon in `data`. Running that commit a second time with a new
command id is `CONFIRMATION_ALREADY_USED` (exit `4`); it never creates a
second coupon.

### Turn it off

```sh
dinkus-coupons --endpoint https://coupons.example --site store_demo \
  coupons disable cpn_demo
```

```text
store: store_demo
change: disable
code: FALL10
coupon id: cpn_demo
status: on -> off
confirmation: cfm-0123456789abcdef0123456789abcdef (expires 2026-10-10T12:05:00.000Z)
Type cfm-0123456789abcdef0123456789abcdef to make this change, or anything else to cancel:
```

## Tests

- `tests/cli/dinkus-coupons.test.mjs` (`npm test`): help and version at every
  depth, JSON, plain and human output, configuration precedence and the
  token-endpoint rule, flag validation before any request, the preview,
  prompt and `--confirm` paths, the frozen request, each commit answer's
  outcome and exit code, unknown-outcome recovery that resends identical
  bytes, a loopback HTTP run of the real executable, and the import boundary.
- `tests/runtime/cli.test.mjs` (`npm run test:runtime`): the same command
  functions against the real Worker and Durable Object in workerd: create,
  preview, confirm, a checkout quote that uses the new coupon, counts,
  disable, a reused confirmation, and a lost answer resolved without a second
  change.
