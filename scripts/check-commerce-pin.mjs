#!/usr/bin/env node
// The service runs Commerce's own coupon core from a copy under
// vendor/commerce: every Commerce file the Worker build resolves, so every
// line that ships is in this repository's diffs. Fail unless each copied file
// is byte-for-byte the same path at package.json "dinkuskit.commercePin" in
// dinkuskit/commerce, so a pin bump is always an explicit, reviewed edit.
//
//   npm run check:pin                         verify the copy
//   npm run check:pin -- --update [path...]   rewrite the copy from the pin,
//                                             adding any named Commerce paths
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const COMMERCE = "https://github.com/dinkuskit/commerce.git";
const VENDOR = "vendor/commerce";

class PinError extends Error {}

function fail(message) {
  throw new PinError(message);
}

function copied(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) return copied(path, relative);
    if (!stat.isFile()) fail(`${VENDOR}/${relative} must be a regular file`);
    return [relative];
  });
}

function main() {
  const pin = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dinkuskit?.commercePin;
  if (!/^[0-9a-f]{40}$/.test(pin ?? "")) fail("package.json dinkuskit.commercePin must be a full 40-character commit");

  const [mode, ...named] = process.argv.slice(2);
  const update = mode === "--update";
  if (mode !== undefined && !update) fail(`unknown argument: ${mode}`);
  for (const path of named) {
    if (posix.normalize(path) !== path || !path.startsWith("src/") || path.split("/").includes("..")) {
      fail(`${path} must be a normalized Commerce path under src/`);
    }
  }

  const wanted = [...new Set([...copied(VENDOR), ...named])].sort();
  if (wanted.length === 0) fail(`${VENDOR} is empty`);

  const repo = mkdtempSync(join(tmpdir(), "commerce-pin-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  try {
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", COMMERCE, pin);
    if (git("rev-parse", "FETCH_HEAD").toString().trim() !== pin) fail(`fetched Commerce commit is not ${pin}`);
    const tracked = new Set(git("ls-tree", "-r", "--name-only", "FETCH_HEAD").toString().split("\n"));
    const problems = [];
    for (const path of wanted) {
      if (!tracked.has(path)) {
        problems.push(`${path} does not exist in Commerce at ${pin}`);
        continue;
      }
      const upstream = git("cat-file", "blob", `FETCH_HEAD:${path}`);
      const target = join(VENDOR, path);
      if (update) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, upstream);
      } else if (!readFileSync(target).equals(upstream)) {
        problems.push(`${path} differs from Commerce at ${pin}`);
      }
    }
    if (problems.length) fail(`Commerce copy does not match the pin:\n  ${problems.join("\n  ")}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log(`${update ? "Copied" : "Verified"} ${wanted.length} Commerce files at ${pin}`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof PinError)) throw error;
  console.error(error.message);
  process.exit(1);
}
