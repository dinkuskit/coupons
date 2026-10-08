#!/usr/bin/env node
// The service runs Commerce's own coupon core from the vendor/commerce
// submodule. Fail when the checked-out submodule commit differs from the pin
// recorded in package.json, so a pin bump is always an explicit, reviewed edit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pin = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dinkuskit?.commercePin;
if (!/^[0-9a-f]{40}$/.test(pin ?? "")) {
  console.error("package.json dinkuskit.commercePin must be a full 40-character commit");
  process.exit(1);
}
let actual;
try {
  actual = execFileSync("git", ["-C", "vendor/commerce", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  console.error("vendor/commerce is not checked out; run: git submodule update --init");
  process.exit(1);
}
const gitlink = execFileSync("git", ["ls-tree", "HEAD", "vendor/commerce"], { encoding: "utf8" }).split(/\s+/)[2];
if (actual !== pin || (gitlink && gitlink !== pin)) {
  console.error(`Commerce pin mismatch: package.json ${pin}, submodule checkout ${actual}, committed gitlink ${gitlink ?? "none"}`);
  process.exit(1);
}
console.log(`Commerce coupon core pinned at ${pin}`);
