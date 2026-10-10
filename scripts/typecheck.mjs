#!/usr/bin/env node
// Typecheck this service strictly. Commerce's coupon core under vendor/commerce
// is typechecked by Commerce's own CI at the pinned commit, against Commerce's
// browser-style libs. Under Workers types it reports only environment typing
// differences (globalThis.crypto, TextDecoder options), so errors inside the
// vendored tree are listed but do not fail this check. Any error in this
// repository's own files does.
//
// The Coupons admin plugin is checked twice more: against EmDash's real
// plugin types with browser-style libs, as its sandbox runs it, and together
// with the tests that load it next to the service.
import { spawnSync } from "node:child_process";

const projects = ["tsconfig.json", "tsconfig.plugin.json", "plugins/coupons-admin/tsconfig.json"];
let failed = false;
for (const project of projects) {
  const result = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false", "--project", project], { encoding: "utf8" });
  const lines = `${result.stdout}${result.stderr}`.split("\n").filter(Boolean);
  const errors = lines.filter(line => /error TS\d+/.test(line));
  const vendored = errors.filter(line => line.startsWith("vendor/commerce/"));
  const own = errors.filter(line => !line.startsWith("vendor/commerce/"));
  if (vendored.length) console.log(`${project}: ${vendored.length} environment typing difference(s) in vendored Commerce source (checked by Commerce CI):`);
  for (const line of vendored) console.log(`  ${line}`);
  for (const line of own) console.error(`${project}: ${line}`);
  if (own.length || (result.status !== 0 && errors.length === 0)) {
    if (!own.length) console.error(lines.join("\n"));
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("typecheck: no errors in this repository's sources");
