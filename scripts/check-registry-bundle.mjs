import { bundlePlugin } from "@emdash-cms/plugin-cli";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

// Runs the official Registry packaging on this repository's root plugin, so a
// backend over the 128 KiB per-file cap (RFC 0001) fails the build instead of a
// later install. bundlePlugin enforces the limit; this reports the headroom.
const REGISTRY_FILE_LIMIT_BYTES = 128 * 1024;
const directory = resolve(".tmp/registry-bundle");
await rm(directory, { recursive: true, force: true });
const extracted = resolve(directory, "extracted");
await mkdir(extracted, { recursive: true });
const artifact = await bundlePlugin({ dir: resolve("."), outDir: resolve(directory, "build") });
execFileSync("tar", ["-xf", artifact.tarballPath, "-C", extracted]);
const backend = await readFile(resolve(extracted, "backend.js"));
const manifest = JSON.parse(await readFile(resolve(extracted, "manifest.json"), "utf8"));
if (manifest.id !== "dinkus-coupons") throw new Error(`unexpected plugin id ${manifest.id}`);
// No public route: shoppers reach Coupons only through the store's own checkout code
// (commerce-addons-door-20261124), and the courier and agent tools use private routes too.
const open = manifest.routes.filter(route => route.public).map(route => route.name);
if (open.length) throw new Error(`the Coupons plugin has no public routes, found: ${open.join()}`);
for (const name of ["admin", "checkout/answer", "checkout/release", "courier/inbox", "tools/list", "tools/get", "tools/save", "tools/turn"]) {
  const route = manifest.routes.find(entry => entry.name === name);
  if (!route || route.permission !== "plugins:manage") throw new Error(`${name} must be a private route with the plugins:manage permission`);
}
// No network host and no capability: coupons and their uses stay in the store's own database.
if ((manifest.allowedHosts ?? []).length > 0 || (manifest.capabilities ?? []).length > 0) throw new Error("the Coupons plugin asks for no host and no capability");
const tools = (manifest.mcp?.tools ?? []).map(tool => tool.name).sort().join();
if (tools !== "get_coupon,list_coupons,save_coupon,turn_coupon") throw new Error(`unexpected agent tools: ${tools}`);
console.log([
  "registry_bundle=pass",
  `backend_bytes=${backend.byteLength}`,
  `headroom_bytes=${REGISTRY_FILE_LIMIT_BYTES - backend.byteLength}`,
  `backend_sha256=${createHash("sha256").update(backend).digest("hex")}`,
].join(" "));
