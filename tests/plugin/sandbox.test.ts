// The built Coupons admin plugin inside EmDash's production sandbox runner:
// its manifest, its encrypted pass setting, its admin permission, and the only
// network calls it makes. The coupon service's answers are queued here; the
// screens against the real service are covered in tests/runtime.
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const SERVICE = "https://coupons.dinkuskit.com/v1/stores/shop-1";
let host: PluginRuntimeTestHost;

beforeEach(async () => {
  // EmDash encrypts secret settings with this site key; a fresh random one per test.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const prefix = ["emdash", "enc", "v1", ""].join("_");
  process.env.EMDASH_ENCRYPTION_KEY = prefix + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  host = await createPluginRuntimeTestHost();
});
afterEach(async () => { await host.dispose(); });

// An unsigned stand-in built at run time: the plugin reads only the store and
// expiry from a pass, and the queued answers stand in for the service's check.
function pass(): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const now = Math.floor(Date.now() / 1000);
  return [encode({ alg: "ES256" }), encode({ site_id: "shop-1", scope: "coupons:admin", iat: now, exp: now + 3600 }), "c2ln"].join(".");
}

const coupon = {
  couponId: "coupon-1", code: "SPRING", disabled: false, globalCap: 100, revision: 1, createdAt: "2026-10-01T00:00:00.000Z",
  rule: {
    ruleId: "rule-1", version: 1, discount: { kind: "percentage", basisPoints: 2500 }, appliesTo: "all-merchandise",
    selectedProductIds: [], includeSaleItems: false, minimumEligibleMerchandise: { currency: "USD", minor: "0" },
    startsAt: "2026-10-01T04:00:00.000Z", endsAt: "2031-01-01T04:59:59.000Z", timeZone: "America/New_York",
  },
};

test("the plugin asks for the coupon service host and nothing else", () => {
  expect(host.manifest).toMatchObject({
    capabilities: ["network:request"],
    allowedHosts: ["coupons.dinkuskit.com"],
    hooks: [],
    routes: [{ name: "admin", permission: "plugins:manage" }],
    admin: { pages: [{ path: "/coupons", label: "Coupons" }], settingsSchema: { couponsAdminPass: { type: "secret" } } },
  });
});

test("without a pass the page points to settings and makes no network call", async () => {
  const response = await host.admin.loadPage("/coupons");
  expect(JSON.stringify(response)).toContain("Add your coupon pass");
  expect(host.http.requests()).toEqual([]);
});

test("the saved pass is stored encrypted and sent only to the coupon service", async () => {
  const token = pass();
  expect(await host.actions.plugin.updateSettings({ couponsAdminPass: token })).toMatchObject({ success: true });
  expect(JSON.stringify(await host.inspect.settings.raw("couponsAdminPass"))).not.toContain(token);
  await host.http.respond(`${SERVICE}/coupons`, Response.json({ coupons: [coupon] }));
  const response = await host.admin.loadPage("/coupons");
  expect(JSON.stringify(response)).toContain("SPRING");
  expect(host.http.requests()).toEqual([expect.objectContaining({
    url: `${SERVICE}/coupons`, method: "GET",
    headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
  })]);
});

test("a change waits in plugin KV between preview and confirm and commits the previewed request", async () => {
  expect(await host.actions.plugin.updateSettings({ couponsAdminPass: pass() })).toMatchObject({ success: true });
  const confirmation = `cfm-${"a".repeat(32)}`;
  const { couponId: _id, revision: _revision, createdAt: _created, ...after } = coupon;
  await host.http.respond(`${SERVICE}/coupons/previews`, Response.json({
    preview: { action: "create", couponId: null, before: null, after: { ...after, normalizedCode: "SPRING" } },
    confirmation: { value: confirmation, expiresAt: new Date(Date.now() + 300_000).toISOString() },
  }));
  const previewed = await host.admin.submit("/coupons", "preview_create", {
    code: "SPRING", discount_kind: "percentage", percent: "25", min_spend: "0", ends_on: "2030-12-31",
    time_zone: "America/New_York", uses: 100,
  }, { blockId: "create" });
  expect(JSON.stringify(previewed)).toContain("Nothing has changed yet");
  const pending = await host.inspect.kv.list();
  expect(pending).toHaveLength(1);

  await host.http.respond(`${SERVICE}/coupons/commands`, Response.json({ outcome: "committed", commandId: "ignored", coupon }));
  await host.http.respond(`${SERVICE}/coupons/coupon-1/counts`, Response.json({
    counts: { couponId: "coupon-1", cap: 100, capacity: 100, pending: 0, consumed: 0, released: 0, remaining: 100 },
  }));
  const committed = await host.admin.act("/coupons", "confirm", { value: confirmation });
  expect(committed.toast).toEqual({ type: "success", message: "Coupon SPRING created." });
  expect(await host.inspect.kv.list()).toEqual([]);

  const [previewRequest, commitRequest] = host.http.requests();
  const sent = JSON.parse(new TextDecoder().decode(previewRequest!.body));
  const commit = JSON.parse(new TextDecoder().decode(commitRequest!.body));
  expect(commit).toEqual({ commandId: expect.stringMatching(/^cmd-[0-9a-f-]{36}$/), confirmation, request: sent });
  expect(sent).toMatchObject({ action: "create", coupon: { code: "SPRING", globalCap: 100, rule: { endsAt: "2030-12-31T23:59:59-05:00" } } });
});

test("people who can't manage plugins can't open the page", async () => {
  const editor = await host.fixtures.user({ email: "editor@example.invalid", role: "editor" });
  await expect(host.admin.loadPage("/coupons", { user: editor })).rejects.toThrow(/\(403\)/);
  expect(host.http.requests()).toEqual([]);
});
