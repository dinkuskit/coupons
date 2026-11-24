# Agent Contract

This public repository owns DinkusKit Coupons, the one optional coupons
module for DinkusKit Commerce on EmDash: the `dinkus-coupons` EmDash Registry
plugin. Keep it generic: site copy, customer data,
branding, credentials, and production configuration do not belong here.

## Direction and research

Read the organization [vision](https://github.com/dinkuskit/.github/blob/main/VISION.md)
and [scope and planning](https://github.com/dinkuskit/.github/blob/main/ROADMAP.md)
with this repository's charter and current decisions. They describe direction
and the store baseline; they do not reopen local locks or establish implemented
capabilities.

Use the installed `emdash-commerce` skill for material product or architecture
questions and relevant grills. Its selective REA guidance distinguishes
research, accepted design, active work and verified behavior. Reuse the owning
issue or proposal for unresolved questions; research alone does not authorize
implementation or expand an active release.

## Running GrillTrack

Run `./scripts/agent-skills` first; it installs the pinned SaariusSkills
skills into ignored `.cursor/skills/`. Use
`./scripts/grilltrack --project . validate` or `show` for ledger reads.
The bundle keeps its existing pin; `emdash-commerce` has a separate exact
revision in that script, including its reference files. The CLI-only ledger
rule remains in force. SmokySkills is enabled only after
maintainer access and an immutable commit pin are supplied.

In Claude Code cloud sessions `.claude/hooks/session-start.sh` checks Node
against `.nvmrc`, runs `npm ci` and `./scripts/agent-skills`, then reports
anything missing; read that report before running project scripts.

## Boundary

The boundary was accepted on 24 Nov 2026 and is recorded in the GrillTrack
ledger (`coupons-plugin-home-20261124` and the decisions beside it) and in
[docs/plugin.md](docs/plugin.md).

- This repository is one sandboxed Registry plugin at the repository root
  (`emdash-plugin.jsonc`, `src/`). Coupons, held uses, paid uses and guess
  counts live in the store's own plugin storage. There is no hosted service,
  no command-line tool and no copy of Commerce.
- EmDash plugins cannot call each other. The store's own checkout code asks
  `checkout/answer` and hands the answer to Commerce's add-ons door
  (`checkout/addons/start`, Commerce's `docs/implementation/addons-door.md`).
  Commerce stays the owner of prices, cart, checkout, orders, money and tax,
  and checks every line and price in the answer again.
- Commerce's `order.paid` news, carried by the store's courier
  (dinkuskit/courier), counts a use once per order and coupon.
- Every route is private. The checkout doors and the courier inbox refuse any
  call with a signed-in person (`STORE_ONLY`, `COURIER_ONLY`); the admin page
  and the agent (MCP) tools are for Administrators. The plugin asks for no
  capability and no network host; `scripts/check-registry-bundle.mjs` fails
  the build if that changes.
- The rule set is the giants' shared set in `coupons-v1-settings-20261124`,
  combined Shopify's way (`coupons-combining-20261124`). Buy X get Y,
  automatic discounts, customer groups, store credit, gift cards, loyalty and
  referrals are not built here.

## Working state

Run `npm ci`, `npm run typecheck` and `npm test` before pushing. `npm test`
builds the plugin, runs the official Registry packaging, which fails above the
128 KiB per-file limit, and runs the tests against the built plugin. Keep the
package private until its release gates pass.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
