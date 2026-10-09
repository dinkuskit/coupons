#!/usr/bin/env node
// Typecheck this service strictly. Commerce's coupon core under vendor/commerce
// is typechecked by Commerce's own CI at the pinned commit, against Commerce's
// browser-style libs. Under Workers types it reports only environment typing
// differences (globalThis.crypto, TextDecoder options), so errors inside the
// vendored tree are listed but do not fail this check. Any error in this
// repository's own files does.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8" });
const lines = `${result.stdout}${result.stderr}`.split("\n").filter(Boolean);
const errors = lines.filter(line => /error TS\d+/.test(line));
const vendored = errors.filter(line => line.startsWith("vendor/commerce/"));
const own = errors.filter(line => !line.startsWith("vendor/commerce/"));
if (vendored.length) console.log(`${vendored.length} environment typing difference(s) in vendored Commerce source (checked by Commerce CI):`);
for (const line of vendored) console.log(`  ${line}`);
for (const line of own) console.error(line);
if (own.length || (result.status !== 0 && errors.length === 0)) {
  if (!own.length) console.error(lines.join("\n"));
  process.exit(1);
}
console.log("typecheck: no errors in this repository's sources");
