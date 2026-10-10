# Coupon admin CLI proof

- **Track:** `gt-20260930183102-25d567`
- **Focus:** `coupon-admin-cli`, from the project owner's "Coupon admin"
  choice on the thread's decision card on 2026-10-10.
- **Baseline:** `git:ca529d3` (`origin/main` when the slice started).
- **Decisions:** `coupon-admin-preview-confirm` and `coupons-cli-v1`, proposed
  for the project owner to lock.
- **Scope:** service routes, the `dinkus-coupons` CLI, its spec and agent
  skill, and docs. No deployment, secret, published package or production
  change is part of this slice.

## Artifacts

- `src/store.ts`, `src/worker.ts`: `POST /coupons/previews`,
  `POST /coupons/commands`, `GET /coupons/commands/{id}` under
  `coupons:admin`, with `admin_previews` and `admin_commands` tables in the
  store's Durable Object. `src/core.ts` re-exports Commerce's
  `normalizeCouponRule` so a preview freezes the exact rule the core accepts.
- `bin/dinkus-coupons.mjs`, `cli/`: the CLI. `cli/kernel.mjs` is
  byte-identical with Commerce `cli/kernel.mjs` at `554e085`.
- `docs/CLI-SPEC.md`, `skills/coupons-cli/SKILL.md`,
  `docs/hosted-coupon-service.md`, `README.md`, `AGENTS.md`.

## Checks (2026-10-10, Node 22, local workerd)

- `npm run check:pin`: 70 Commerce files match `eafd3e8`; nothing under
  `vendor/` changed.
- `npm run typecheck`: no errors in this repository's sources.
- `npm test`: 18 Node tests pass, 12 of them for the CLI against a stand-in
  service (output modes, configuration and token-endpoint rules, input
  checks before any request, preview, prompt and `--confirm`, each commit
  answer's outcome and exit code, unknown-outcome recovery resending
  identical bytes, a loopback HTTP run of the executable, import boundary).
- `npm run test:runtime`: 15 tests pass in workerd. Service: a previewed
  create commits once (changed request refused, key order ignored, exact
  retry returns the first result, lookup, used and unknown confirmations,
  conflicting command id, checkout pass refused); disable and enable bind to
  the previewed revision; refused previews store nothing; expiry after five
  minutes. CLI against the real Worker: create, then a checkout quote uses the
  coupon, counts, disable stops new quotes, a reused confirmation is
  blocked, and a lost answer resolves without a second change.
- `npm run build`: `wrangler deploy --dry-run` bundles the Worker.
- The diff has no credential-shaped strings; test passes are joined at
  runtime from plain words.

## Fidelity

- `agreed-v1-terms`: the CLI exposes exactly the agreed v1 coupon terms and
  adds none. Edits stay planned until the service previews them.
- `agreed-v1-session-freeze`: disable goes through Commerce's `edit`, which
  leaves attempts with a payment session unchanged.
- `coupon-service-http-contract`: existing routes and their answers are
  unchanged; the new routes are additive under `coupons:admin`.
- `single-coupon-evaluator`: the service still validates coupons only through
  the pinned Commerce core; the CLI validates only flag syntax.
