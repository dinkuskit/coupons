// The Coupons admin plugin's screens, driven the way EmDash drives them,
// against the real coupon service Worker. Every answer must be valid Block Kit.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { validateBlockResponse, type Block, type BlockResponse } from "@emdash-cms/blocks/server";
import worker from "../../src/worker";
import plugin, { handleAdmin } from "../../plugins/coupons-admin/src/plugin";
import { dayBoundary, editChanges, newDraft, termsFromDraft, when, type Coupon } from "../../plugins/coupons-admin/src/terms";
import { readPass } from "../../plugins/coupons-admin/src/service";

const audience = "dinkus-coupons";
const hour = 60 * 60 * 1000;
let site: string;
let issuer: string;
let sign: (options?: { scope?: string; issuedAt?: number; key?: CryptoKey }) => Promise<string>;
let pass: string | null | Error;
let kv: Map<string, unknown>;
let fetchSpy: (url: string, init?: RequestInit) => Promise<Response>;
const configured = () => ({ ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: `${issuer}/jwks` }) as unknown as Env;
const service = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), configured());

beforeEach(async () => {
  site = `site-${crypto.randomUUID()}`;
  issuer = `https://accounts-${crypto.randomUUID()}.example.invalid`;
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic", alg: "ES256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (new URL(String(input)).href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  sign = ({ scope = "coupons:admin", issuedAt = Math.floor(Date.now() / 1000), key = privateKey } = {}) =>
    new SignJWT({ site_id: site, scope }).setProtectedHeader({ alg: "ES256", kid: "synthetic" }).setIssuer(issuer)
      .setAudience(audience).setSubject("synthetic-store").setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3600).sign(key);
  pass = await sign();
  kv = new Map();
  fetchSpy = service;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const admin = { id: "admin-1", email: "owner@example.invalid", name: "Owner", role: 50, createdAt: "2026-01-01T00:00:00Z" };

function context() {
  return {
    plugin: { id: "dinkus-coupons", version: "0.1.0" },
    settings: { get: async (key: string) => {
      if (pass instanceof Error) throw pass;
      return key === "couponsAdminPass" ? pass : null;
    } },
    kv: {
      get: async (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : null),
      set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      delete: async (key: string) => kv.delete(key),
      list: async (prefix = "") => [...kv].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    },
    http: { fetch: (url: string, init?: RequestInit) => fetchSpy(url, init) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as never;
}

async function send(input: unknown, user: Record<string, unknown> = admin, surface = "admin-page"): Promise<BlockResponse> {
  const response = await handleAdmin({
    input, request: { url: "https://shop.example.invalid/_emdash/api/plugins/dinkus-coupons/admin", method: "POST", headers: {} },
    ui: { surface, locale: "en", direction: "ltr" }, user,
  } as never, context());
  const checked = validateBlockResponse(response, { pluginPagePaths: ["/coupons"] });
  expect(checked.errors).toEqual([]);
  return response;
}
const load = () => send({ type: "page_load", page: "/coupons" });
const act = (action_id: string, value?: unknown, user?: Record<string, unknown>) =>
  send({ type: "block_action", action_id, page: "/coupons", ...(value === undefined ? {} : { value }) }, user);
const submit = (action_id: string, values: Record<string, unknown>, block_id?: string) =>
  send({ type: "form_submit", action_id, page: "/coupons", values, ...(block_id ? { block_id } : {}) });

const find = <T extends Block["type"]>(response: BlockResponse, type: T) =>
  response.blocks.filter((block): block is Extract<Block, { type: T }> => block.type === type);
const text = (response: BlockResponse) => JSON.stringify(response);
const buttons = (response: BlockResponse) =>
  find(response, "actions").flatMap(block => block.elements).filter(element => element.type === "button") as Array<{ label: string; action_id: string; value?: unknown }>;
const button = (response: BlockResponse, label: string) => {
  const found = buttons(response).find(element => element.label === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
};

async function coupons(): Promise<Coupon[]> {
  const response = await service(`https://coupons.example.invalid/v1/stores/${site}/coupons`, { headers: { authorization: `Bearer ${await sign()}` } });
  return (await response.json() as { coupons: Coupon[] }).coupons;
}

async function seed(code: string, rule: Record<string, unknown> = {}, globalCap = 10): Promise<Coupon> {
  const response = await service(`https://coupons.example.invalid/v1/stores/${site}/coupons`, {
    method: "POST", headers: { authorization: `Bearer ${await sign()}`, "content-type": "application/json" },
    body: JSON.stringify({ code, globalCap, rule: {
      discount: { kind: "percentage", basisPoints: 2000 }, appliesTo: "all-merchandise", selectedProductIds: [],
      includeSaleItems: false, minimumEligibleMerchandise: { currency: "USD", minor: "0" },
      startsAt: "2026-10-01T09:30:00-04:00", endsAt: "2030-06-30T17:00:00-04:00", timeZone: "America/New_York", ...rule,
    } }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { coupon: Coupon }).coupon;
}

const spring = {
  code: "Spring", discount_kind: "percentage", percent: "25", max_discount: "10", min_spend: "50", products: "",
  include_sale_items: false, starts_on: "", ends_on: "2030-12-31", time_zone: "America/New_York", uses: 100,
};

test("the plugin declares one admin route that needs the plugins:manage permission", () => {
  expect(Object.keys(plugin.routes ?? {})).toEqual(["admin"]);
  expect(plugin.routes?.admin).toMatchObject({ permission: "plugins:manage" });
});

test("the coupon page asks for a usable pass before it calls the service", async () => {
  const requests: string[] = [];
  fetchSpy = (url, init) => { requests.push(url); return service(url, init); };
  pass = null;
  const missing = await load();
  expect(text(missing)).toContain("Add your coupon pass");
  expect(find(missing, "actions")[0]!.elements[0]).toEqual({ type: "link", label: "Open settings", target: { kind: "plugin-settings" }, appearance: "primary" });
  pass = "not a pass";
  expect(text(await load())).toContain("doesn't look like a coupon pass");
  pass = new Error("the site's encryption key changed");
  expect(text(await load())).toContain("doesn't look like a coupon pass");
  pass = await sign({ scope: "coupons:checkout" });
  expect(text(await load())).toContain("can't manage coupons");
  pass = await sign({ issuedAt: Math.floor((Date.now() - 2 * hour) / 1000) });
  expect(text(await load())).toContain("has expired");
  expect(requests).toEqual([]);

  pass = await sign();
  expect(text(await send({ type: "page_load", page: "/coupons" }, { ...admin, role: 40 }))).toContain("Only site administrators");
  expect(text(await send({ type: "page_load", page: "/coupons" }, admin, "dashboard-widget"))).toContain("Only site administrators");
  expect(requests).toEqual([]);
  expect(text(await load())).toContain("No coupons yet");
  expect(requests).toEqual([`https://coupons.dinkuskit.com/v1/stores/${site}/coupons`]);
});

test("a pass the service refuses sends the owner back to settings", async () => {
  pass = await sign({ key: (await generateKeyPair("ES256")).privateKey });
  expect(text(await load())).toContain("didn't accept your pass");
});

test("an owner creates a coupon by previewing it and confirming it once", async () => {
  const form = await act("new");
  expect(find(form, "form")[0]).toMatchObject({ block_id: "create", submit: { action_id: "preview_create" } });

  const refused = await submit("preview_create", { ...spring, code: "", percent: "0", ends_on: "" });
  expect(text(refused)).toContain("Enter a code.");
  expect(text(refused)).toContain("Enter a percent off");
  expect(text(refused)).toContain("Pick the last day");
  // The form comes back as the owner left it.
  expect(find(refused, "form")[0]!.fields.find(field => field.action_id === "max_discount")).toMatchObject({ initial_value: "10" });

  const previewed = await submit("preview_create", spring);
  expect(text(previewed)).toContain("Nothing has changed yet");
  expect(find(previewed, "fields")[0]!.fields).toEqual(expect.arrayContaining([
    { label: "Code", value: "Spring" },
    { label: "Discount", value: "25% off, at most $10.00" },
    { label: "Minimum spend", value: "$50.00" },
    { label: "Ends", value: "Dec 31, 2030, 11:59 PM EST" },
    { label: "Uses allowed", value: "100" },
  ]));
  expect(await coupons()).toEqual([]);
  expect(kv.size).toBe(1);

  const confirmation = button(previewed, "Create coupon").value;
  const created = await act("confirm", confirmation);
  expect(created.toast).toEqual({ type: "success", message: "Coupon Spring created." });
  expect(find(created, "stats")[0]!.items).toEqual(expect.arrayContaining([{ label: "Left", value: 100 }]));
  expect(kv.size).toBe(0);
  const [stored] = await coupons();
  expect(stored).toMatchObject({ code: "Spring", globalCap: 100, rule: { endsAt: "2031-01-01T04:59:59.000Z", timeZone: "America/New_York" } });

  const again = await act("confirm", confirmation);
  expect(text(again)).toContain("isn't waiting any more");
  expect(await coupons()).toHaveLength(1);

  const taken = await submit("preview_create", { ...spring, code: " spring " });
  expect(text(taken)).toContain("Another coupon already uses this code");
});

test("an edit previews only what changed and keeps the times the owner left alone", async () => {
  const seeded = await seed("AUTUMN");
  const opened = await act("open", seeded.couponId);
  expect(text(opened)).toContain("Coupon AUTUMN");
  const form = await act("edit", seeded.couponId);
  const [editForm] = find(form, "form");
  expect(editForm!.block_id).toBe(`edit:${seeded.couponId}:1`);
  const values = Object.fromEntries(editForm!.fields.map(field => [field.action_id, "initial_value" in field ? field.initial_value : undefined]));
  expect(values).toMatchObject({ code: "AUTUMN", percent: "20", starts_on: "2026-10-01", ends_on: "2030-06-30", time_zone: "America/New_York", uses: 10 });

  expect(text(await submit("preview_edit", values, editForm!.block_id))).toContain("You haven't changed anything yet.");
  const previewed = await submit("preview_edit", { ...values, uses: 5 }, editForm!.block_id);
  expect(find(previewed, "table")[0]!.rows).toEqual([{ what: "Uses allowed", now: "10", after: "5" }]);
  const saved = await act("confirm", button(previewed, "Save changes").value);
  expect(saved.toast?.message).toBe("Coupon AUTUMN saved.");
  const [stored] = await coupons();
  expect(stored).toMatchObject({ globalCap: 5, revision: 2, rule: { startsAt: seeded.rule.startsAt, endsAt: seeded.rule.endsAt, version: 1 } });

  // A form opened before that save is out of date.
  const stale = await submit("preview_edit", { ...values, percent: "30" }, editForm!.block_id);
  expect(text(stale)).toContain("changed while you were editing");
  expect(find(stale, "form")[0]!.block_id).toBe(`edit:${seeded.couponId}:2`);
});

test("turning a coupon off and on goes through preview and confirm, and cancel changes nothing", async () => {
  const seeded = await seed("WINTER");
  const off = await act("turn_off", seeded.couponId);
  expect(find(off, "table")[0]!.rows).toEqual([{ what: "Status", now: "On", after: "Off" }]);
  expect(text(off)).toContain("keep their discount");
  const turnedOff = await act("confirm", button(off, "Turn off").value);
  expect(text(turnedOff)).toContain("This coupon is turned off");
  expect((await coupons())[0]!.disabled).toBe(true);

  const on = await act("turn_on", seeded.couponId);
  const cancelled = await act("cancel", button(on, "Cancel").value);
  expect(cancelled.toast).toEqual({ type: "info", message: "Cancelled. Nothing was changed." });
  expect(kv.size).toBe(0);
  expect((await coupons())[0]!.disabled).toBe(true);
  expect(button(cancelled, "Turn on").action_id).toBe("turn_on");
});

test("only the owner who previewed can confirm, and an expired preview changes nothing", async () => {
  const previewed = await submit("preview_create", spring);
  const confirmation = button(previewed, "Create coupon").value;
  expect(text(await act("confirm", confirmation, { ...admin, id: "admin-2" }))).toContain("Only the person who previewed");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5 * 60 * 1000 + 1 });
  pass = await sign();
  const late = await act("confirm", confirmation);
  expect(text(late)).toContain("expired after 5 minutes");
  expect(kv.size).toBe(0);
  expect(await coupons()).toEqual([]);
});

test("a lost answer is checked again without making the change twice", async () => {
  const previewed = await submit("preview_create", spring);
  let dropped = false;
  fetchSpy = async (url, init) => {
    const response = await service(url, init);
    if (!dropped && url.endsWith("/coupons/commands")) {
      dropped = true;
      throw new Error("connection reset after the service answered");
    }
    return response;
  };
  const unknown = await act("confirm", button(previewed, "Create coupon").value);
  expect(text(unknown)).toContain("couldn't tell whether this change went through");
  expect(await coupons()).toHaveLength(1);
  expect(kv.size).toBe(1);
  const checked = await act("confirm", button(unknown, "Check again").value);
  expect(checked.toast).toEqual({ type: "success", message: "Coupon Spring created." });
  expect(await coupons()).toHaveLength(1);
  expect(kv.size).toBe(0);
});

test("the list shows 25 coupons a page, newest first, and a day-old preview is forgotten", async () => {
  for (let index = 0; index < 27; index += 1) await seed(`CODE${String(index).padStart(2, "0")}`);
  const first = await load();
  expect(find(first, "table")[0]!.rows).toHaveLength(25);
  expect(text(first)).toContain("Showing 1 to 25 of 27 coupons");
  const second = await act("list", button(first, "Next").value);
  expect(find(second, "table")[0]!.rows).toHaveLength(2);
  expect(button(second, "Previous").value).toBe(0);

  kv.set("pending:cfm-old", { createdAt: Date.now() - 25 * hour });
  kv.set("pending:cfm-new", { createdAt: Date.now() });
  await load();
  expect([...kv.keys()]).toEqual(["pending:cfm-new"]);
});

test("days become the start and end of the day in the coupon's time zone, across daylight saving", () => {
  expect(dayBoundary("2026-03-08", "start", "America/New_York")).toBe("2026-03-08T00:00:00-05:00");
  expect(dayBoundary("2026-03-08", "end", "America/New_York")).toBe("2026-03-08T23:59:59-04:00");
  expect(dayBoundary("2026-11-01", "end", "America/Los_Angeles")).toBe("2026-11-01T23:59:59-08:00");
  expect(dayBoundary("2026-07-04", "start", "UTC")).toBe("2026-07-04T00:00:00+00:00");
  expect(dayBoundary("2026-02-30", "start", "UTC")).toBeNull();
  expect(when("2026-03-08T04:59:59.000Z", "America/New_York")).toBe("Mar 7, 2026, 11:59 PM EST");
  expect(when("2026-07-04T16:05:30.000Z", "America/Los_Angeles")).toBe("Jul 4, 2026, 9:05:30 AM PDT");
  expect(when("2026-07-04T00:00:00.000Z", "UTC")).toBe("Jul 4, 2026, 12:00 AM UTC");

  const fixed = termsFromDraft({ ...newDraft(), code: "TEN", kind: "fixed", amount: "$1,250.5", endsOn: "2030-01-31", uses: "3" });
  expect(fixed).toMatchObject({ terms: { rule: { discount: { kind: "fixed", amount: { currency: "USD", minor: "125050" } } } } });
  const past = termsFromDraft({ ...newDraft(), code: "OLD", percent: "10", endsOn: "2020-01-31", uses: "3" });
  expect(past).toEqual({ problems: ["The last day has already passed; pick a later one."] });
});

test("an edit sends only the fields that changed, and moving the time zone moves both days with it", async () => {
  const seeded = await seed("ZONE");
  const draft = { ...newDraft(), code: "ZONE", percent: "20", startsOn: "2026-10-01", endsOn: "2030-06-30", timeZone: "America/New_York", uses: "10" };
  const same = termsFromDraft(draft, seeded);
  expect("terms" in same && editChanges(same.terms, seeded)).toBeNull();
  const moved = termsFromDraft({ ...draft, timeZone: "America/Chicago" }, seeded);
  expect("terms" in moved && editChanges(moved.terms, seeded)).toEqual({ rule: {
    startsAt: "2026-10-01T00:00:00-05:00", endsAt: "2030-06-30T23:59:59-05:00", timeZone: "America/Chicago",
  } });
});

test("a pass is read for its store and refused before calling when it is too old", () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const now = Math.floor(Date.now() / 1000);
  const token = (claims: Record<string, unknown>) => [encode({ alg: "ES256" }), encode(claims), "c2ln"].join(".");
  expect(readPass(token({ site_id: "shop-1", scope: "coupons:admin", iat: now - 60, exp: now + 3000 }))).toMatchObject({ siteId: "shop-1" });
  expect(readPass(token({ site_id: "shop/1", scope: "coupons:admin", iat: now, exp: now + 60 }))).toBe("unreadable");
  expect(readPass(token({ site_id: "shop-1", scope: "coupons:admin", iat: now - 3601, exp: now + 60 }))).toBe("expired");
  expect(readPass(`  ${token({ site_id: "shop-1", scope: "coupons:admin", iat: now, exp: now + 60 })}  `)).toMatchObject({ siteId: "shop-1" });
});
