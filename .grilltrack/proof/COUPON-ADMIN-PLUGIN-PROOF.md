# Coupons admin plugin proof

- **Track:** `gt-20260930183102-25d567`
- **Focus:** `coupon-admin-plugin`, the second half of the project owner's
  "Coupon admin" choice on 2026-10-10 (the CLI half merged in coupons#15).
- **Baseline:** `git:075fe33` (`origin/main` when the slice started).
- **Decisions:** `coupon-admin-plugin-v1` and `coupon-admin-edit-preview`,
  proposed and waiting for the project owner's approval. They are not locked.
- **Scope:** the service's edit preview and attempt-free admin answers, the
  Coupons admin Registry plugin, its tests, CI steps and docs. No deployment,
  secret, published package, Registry listing or production change is part
  of this slice.

## Artifacts

- `src/store.ts`: admin preview action `edit` (code, use cap, rule fields
  replaced whole; whole next rule frozen at preview; bound to the revision;
  `NO_CHANGE` for an edit to current values). Every admin answer leaves out
  redemption attempts.
- `plugins/coupons-admin/`: `emdash-plugin.jsonc` (slug `dinkus-coupons`,
  `network:request` for `coupons.dinkuskit.com` only, one secret setting, one
  admin page), `src/plugin.ts` (routing, admin check, preview and confirm,
  pending changes in plugin KV), `src/screens.ts` (Block Kit),
  `src/terms.ts` (form to coupon terms, days in a time zone),
  `src/service.ts` (pass reading, service calls), `README.md`.
- `tests/runtime/admin-plugin.test.ts`, `tests/plugin/sandbox.test.ts`,
  `vitest.plugin.config.ts`, `tsconfig.plugin.json`,
  `scripts/check-plugin-bundle.mjs`, `scripts/typecheck.mjs`,
  `.github/workflows/ci.yml`, `package.json` (EmDash 1.2.0 dev packages,
  `test:plugin`, `build:plugin`).
- `docs/hosted-coupon-service.md`, `docs/CLI-SPEC.md`, `README.md`,
  `AGENTS.md`.

## Checks (2026-10-10, Node 22, local workerd, also from a clean `npm ci`)

- `npm run check:pin`: 70 Commerce files match `eafd3e8`; nothing under
  `vendor/` changed.
- `npm run typecheck`: no errors in this repository's sources, for the
  service, for the plugin against EmDash's real types with browser libs, and
  for the plugin tests.
- `npm test`: 18 Node tests pass (CLI and workflow tests unchanged).
- `npm run test:runtime`: 29 tests pass in workerd.
  - Service (17): edit previews the whole next coupon and commits exactly
    that once; `NO_CHANGE`, `CODE_IN_USE`, unknown fields, a rule id, a bad
    day and a negative cap are refused before anything is stored; a letter
    case change keeps the coupon's own code; a stale revision and a code
    taken after the preview are stored rejections; list and get carry no
    attempts after a paid checkout.
  - Plugin screens against the real Worker (12, every answer checked with
    EmDash's `validateBlockResponse`): a missing, unreadable, undecryptable,
    checkout-only or hour-old pass is explained before any network call;
    non-administrators and other surfaces are refused; a refused pass sends
    the owner to settings; create refuses bad input with the form kept, shows
    the preview, creates on confirm, and a second click changes nothing;
    edit shows only what changed and keeps untouched times; a form opened
    before another change is reloaded; turn off and on, and cancel; only the
    previewing administrator can confirm; an expired preview changes nothing;
    a lost answer is checked again without a second change; 25 a page; a
    day-old pending change is forgotten; day boundaries across daylight
    saving; date text; pass reading.
- `npm run test:plugin`: 5 tests pass with the built plugin in EmDash 1.2.0's
  sandbox runner (`@emdash-cms/plugin-test` 0.2.8): manifest asks only for
  `coupons.dinkuskit.com`; no pass means no network call; the pass is stored
  encrypted and sent only as the bearer token to the service; a change waits
  in plugin KV and the commit sends exactly the previewed request; an editor
  gets 403.
- `npm run build`: `wrangler deploy --dry-run` bundles the Worker.
- `npm run build:plugin`: manifest valid; Registry packaging passes;
  `backend.js` 24,439 bytes, 106,633 bytes under the 128 KiB per-file limit.
- The diff has no credential-shaped strings: test passes are signed or
  assembled at run time, and the test site key is built from random bytes.

## Fidelity

- `coupon-admin-registry-plugin`: a separate small Registry plugin with list,
  create, edit, disable and counts, calling the service with
  `coupons:admin`, sandboxed, `network:request` limited to the service host.
- `coupon-admin-preview-confirm`: the plugin changes coupons only through
  previews and commands; the edit action extends the same binding (exact
  request, revision, five minutes, single use, stored result by command id).
- `agreed-v1-terms`: the plugin's form offers exactly the agreed v1 terms.
- `agreed-v1-session-freeze`: turning off still goes through Commerce's
  `edit`, which leaves attempts with a payment session unchanged; the screen
  says checkouts that applied the coupon keep their discount.
- `single-coupon-evaluator`: rules are validated only by the pinned Commerce
  core in the service; the plugin checks only form input.
- `coupon-service-http-contract`: routes are unchanged; the edit action is
  additive; admin answers lose the attempts field, which no client read.
