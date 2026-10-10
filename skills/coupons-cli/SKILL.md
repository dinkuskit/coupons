---
name: coupons-cli
description: List, create, and turn DinkusKit coupons on or off for a store with the dinkus-coupons CLI instead of hand-written calls to the coupon service.
---

# Coupons CLI

Use `bin/dinkus-coupons.mjs` (installed name `dinkus-coupons`, Node 22, no
build) for every coupon read or change. The CLI owns the mechanics: the pass,
the store check, preview and confirmation, the pending-change store, and exit
codes. Do not rebuild those with `curl` or scripts. The contract is
[docs/CLI-SPEC.md](../../docs/CLI-SPEC.md).

The caller's environment must already provide `DINKUS_COUPONS_TOKEN`, a
`coupons:admin` pass for the store. Never print, paste, or write it anywhere,
and never put it in a config file. Set the service with `--endpoint`,
`DINKUS_COUPONS_ENDPOINT` or user config: the CLI refuses (exit `4`,
`untrusted_endpoint`) to send the pass to an endpoint from the working
directory's `.dinkuskit/coupons.json`.

## Reading

1. `dinkus-coupons --site <store> coupons list --json` lists every coupon.
2. `dinkus-coupons --site <store> coupons show <coupon-id> --json` adds how
   many uses are consumed, held by checkouts in progress, and left.
3. Read `outcome` and `context` before `data`.

## Changing coupons

1. Run the change with `--dry-run --json`, passing `--site` on the command
   line. For `coupons create`, give every term the merchant asked for: code,
   `--percent` (with `--max-discount` if they set one) or `--amount`, `--ends`
   with its UTC offset, `--time-zone`, `--cap`, and `--product`,
   `--min-spend`, `--include-sale-items` or `--starts` when they apply. Never
   guess a store, product id, cap, or end date.
2. Read `data.after` (and `data.before` for disable or enable). If it is not
   what the merchant asked for, stop and ask them.
3. Commit with the same arguments plus `--no-input --confirm <value>` from that
   preview, within five minutes.

To change a coupon's code, cap, or rule, `coupons edit` is planned and exits
`1`. Do not call the service's edit route directly; tell the merchant it is
not available yet. To stop a coupon, use `coupons disable`; there is no delete.

## Exit codes

- `0` done. `1` the service refused the change (`rejected`, such as
  `CODE_IN_USE`), something was not found, or the command is planned: report
  the code, do not retry as new.
- `2` fix the invocation. `4` a pass, permission, or confirmation gate: ask
  the merchant; previewing again is the only retry.
- `3` with `outcome: "unknown"`: run
  `dinkus-coupons --site <store> commands resolve <commandId>`. Never submit
  the change again as a new command.
- `5` the service broke its contract: stop and report.

This skill does not authorize deploying the service or changing a production
store without the merchant's go-ahead for that exact change.
