#!/usr/bin/env node
// Packages the Coupons admin plugin with EmDash's own Registry packaging, so a
// backend over the Registry's per-file limit fails the build. bundlePlugin
// enforces the limit; this script only reports the size and the headroom left.
import { bundlePlugin } from "@emdash-cms/plugin-cli";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const REGISTRY_FILE_LIMIT_BYTES = 128 * 1024;
const plugin = resolve("plugins/coupons-admin");
const directory = resolve(plugin, "dist/registry-bundle");
const extracted = resolve(directory, "extracted");
await rm(directory, { recursive: true, force: true });
await mkdir(extracted, { recursive: true });
const artifact = await bundlePlugin({ dir: plugin, outDir: resolve(directory, "build") });
execFileSync("tar", ["-xf", artifact.tarballPath, "-C", extracted]);
const backend = await readFile(resolve(extracted, "backend.js"));
const manifest = JSON.parse(await readFile(resolve(extracted, "manifest.json"), "utf8"));
console.log([
  "registry_bundle=pass",
  `backend_bytes=${backend.byteLength}`,
  `headroom_bytes=${REGISTRY_FILE_LIMIT_BYTES - backend.byteLength}`,
  `backend_sha256=${createHash("sha256").update(backend).digest("hex")}`,
  `allowed_hosts=${manifest.allowedHosts.join(",")}`,
].join(" "));
