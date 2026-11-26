import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import plugin from "../dist/plugin.mjs";
import { owner, store } from "./store.mjs";

const admin = plugin.routes.admin.handler;
const text = response => JSON.stringify(response);
const valid = response => { const checked = validateBlockResponse(response); assert.equal(checked.valid, true, JSON.stringify(checked.errors)); return response; };
const press = (ctx, action_id, value) => admin(owner({ type: "block_action", action_id, value }), ctx);
const submit = (ctx, action_id, values) => admin(owner({ type: "form_submit", action_id, values }), ctx);
const form = response => response.blocks.find(block => block.type === "form");

test("the Coupons page is for Administrators", async () => {
  assert.equal(plugin.routes.admin.public, false);
  assert.equal(plugin.routes.admin.permission, "plugins:manage");
  for (const route of [owner({ type: "page_load" }, 40), { ...owner({ type: "page_load" }), user: undefined }, owner({ type: "page_load" }, 50, "widget")]) {
    assert.match(text(await admin(route, store())), /Coupons is for Administrators/);
  }
});

test("an empty store lists no coupons, warns that the courier has not come by, and offers the time zone", async () => {
  const page = valid(await admin(owner({ type: "page_load" }), store()));
  assert.match(text(page), /No coupons yet/);
  assert.match(text(page), /Paid uses aren't being counted yet/);
  assert.equal(form(page).fields[0].initial_value, "America/New_York");
});

test("create a coupon from the form, see it listed, edit it and turn it off", async () => {
  const ctx = store();
  const blank = valid(await press(ctx, "new"));
  assert.equal(form(blank).submit.action_id, "create");
  const refused = valid(await submit(ctx, "create", { code: "spring sale", discount: "percent", percent: "150" }));
  assert.match(text(refused), /no spaces/);
  assert.match(text(refused), /from 0.01 to 100/);
  assert.equal(form(refused).fields.find(field => field.action_id === "code").initial_value, "spring sale", "a refused form keeps what was typed");

  const made = valid(await submit(ctx, "create", { code: "Spring25", discount: "percent", percent: "25", endsOn: "2099-03-31", limit: "100", on: true }));
  assert.equal(made.toast.message, "Coupon Spring25 created.");
  assert.match(text(made), /25% off the order/);
  assert.match(text(made), /Mar 31, 2099, 11:59 PM EDT/);
  const [id] = ctx.storage.coupons.rows.keys();

  const dupe = valid(await submit(ctx, "create", { code: "SPRING25", discount: "order", dollars: "5", on: true }));
  assert.match(text(dupe), /Another coupon already uses that code/);

  const list = valid(await admin(owner({ type: "page_load" }), ctx));
  const row = list.blocks.find(block => block.type === "table").rows[0];
  assert.deepEqual([row.code, row.status, row.used], ["Spring25", "🟢 On", "0 of 100"]);

  const editing = valid(await press(ctx, "edit", id));
  assert.equal(form(editing).submit.action_id, `save:1:${id}`);
  const saved = valid(await submit(ctx, "save:1:" + id, { code: "Spring25", discount: "order", dollars: "10", endsOn: "2099-03-31", limit: "100" }));
  assert.match(saved.toast.message, /Checkouts already started keep the terms/);
  const after = ctx.storage.coupons.rows.get(id).data;
  assert.equal(after.version, 2);
  assert.deepEqual(after.amount, { type: "order", cents: "1000" });
  assert.equal(after.ends, "2099-04-01T03:59:59.000Z", "an unchanged last day keeps its exact time");

  const stale = valid(await submit(ctx, "save:1:" + id, { code: "Spring25", discount: "order", dollars: "12" }));
  assert.match(text(stale), /Someone changed this coupon/);

  const off = valid(await press(ctx, "turn_off", id));
  assert.match(off.toast.message, /Turned off/);
  assert.equal(ctx.storage.coupons.rows.get(id).data.on, false);
  assert.equal(ctx.storage.coupons.rows.get(id).data.version, 3);
});

test("malformed dollar amounts don't create or change coupons", async () => {
  const ctx = store();
  const save = fields => plugin.routes["tools/save"].handler(owner(fields), ctx);
  const fixed = { code: "TRAIL", discount: "order" };
  const refused = valid(await submit(ctx, "create", { ...fixed, dollars: "0,25" }));
  assert.match(text(refused), /Enter the dollars off/);
  assert.equal(form(refused).fields.find(field => field.action_id === "dollars").initial_value, "0,25");
  assert.equal(ctx.storage.coupons.rows.size, 0);

  for (const dollars of ["12.5,0", "1,,200", "12,34.50", "10,000,000.01"]) {
    assert.equal((await save({ ...fixed, dollars })).saved, false, dollars);
  }
  const made = await save({ ...fixed, discount: "each", dollars: "$1,200.50", minimum: "amount", minimumDollars: "10,000,000" });
  assert.equal(made.saved, true);
  const { id, version } = made.coupon;
  const before = structuredClone(ctx.storage.coupons.rows.get(id).data);
  assert.deepEqual([before.amount, before.minimum], [{ type: "each", cents: "120050" }, { type: "amount", cents: "1000000000" }]);

  const edit = valid(await submit(ctx, `save:${version}:${id}`, { dollars: "12.5,0" }));
  assert.match(text(edit), /Enter the dollars off/);
  assert.match(text(await save({ id, version, minimumDollars: "1,50" })), /Enter the minimum order amount/);
  assert.deepEqual(ctx.storage.coupons.rows.get(id).data, before);

  const corrected = await save({ id, version, dollars: "12.5", minimumDollars: "1.50" });
  assert.equal(corrected.saved, true);
  assert.deepEqual([corrected.coupon.id, corrected.coupon.version], [id, version + 1]);
  const after = ctx.storage.coupons.rows.get(id).data;
  assert.deepEqual([after.amount, after.minimum], [{ type: "each", cents: "1250" }, { type: "amount", cents: "150" }]);
});

test("the store's time zone decides when a coupon's days start and end", async () => {
  const ctx = store();
  const saved = valid(await submit(ctx, "save_zone", { timeZone: "America/Los_Angeles" }));
  assert.match(saved.toast.message, /Saved/);
  await submit(ctx, "create", { code: "WEST", discount: "percent", percent: "5", startsOn: "2099-06-01", on: true });
  const coupon = [...ctx.storage.coupons.rows.values()][0].data;
  assert.equal(coupon.starts, "2099-06-01T07:00:00.000Z");
  assert.match(text(await submit(ctx, "save_zone", { timeZone: "Mars/Olympus" })), /Pick a time zone from the list/);
});

test("the agent tools: create, read, edit with the version read, and turn off, with plain problems for bad input", async () => {
  const ctx = store();
  const tools = plugin.routes;
  await assert.rejects(tools["tools/list"].handler(owner({}, 40), ctx), /ADMINISTRATORS_ONLY/);
  const bad = await tools["tools/save"].handler(owner({ code: "X", discount: "each" }), ctx);
  assert.deepEqual(bad, { saved: false, problems: ["Enter the dollars off, such as 5 or 12.50."] });
  const made = await tools["tools/save"].handler(owner({ code: "SHIPFREE", discount: "none", freeShipping: true, oncePerShopper: true }), ctx);
  assert.equal(made.saved, true);
  assert.equal(made.coupon.terms.Discount, "Free shipping");
  assert.equal((await tools["tools/get"].handler(owner({ code: "shipfree" }), ctx)).coupon.id, made.coupon.id);
  const edited = await tools["tools/save"].handler(owner({ id: made.coupon.id, version: 1, discount: "percent", percent: "10" }), ctx);
  assert.equal(edited.coupon.version, 2);
  assert.equal(edited.coupon.terms.Discount, "10% off the order and free shipping");
  assert.equal((await tools["tools/turn"].handler(owner({ id: made.coupon.id, on: false }), ctx)).coupon.on, false);
  assert.equal((await tools["tools/list"].handler(owner({}), ctx)).coupons.length, 1);

  const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));
  const names = (manifest.mcp?.tools ?? []).map(tool => `${tool.name}:${tool.route}:${tool.permission}`).sort();
  assert.deepEqual(names, ["get_coupon:tools/get:plugins:manage", "list_coupons:tools/list:plugins:manage", "save_coupon:tools/save:plugins:manage", "turn_coupon:tools/turn:plugins:manage"]);
});

test("activating schedules the 15-minute sweep that deletes ended holds", async () => {
  const ctx = store();
  await plugin.hooks["plugin:activate"]({}, ctx);
  assert.equal(ctx.tasks.get("sweep"), "*/15 * * * *");
  await ctx.storage.holds.put("old", { coupon: "c", cart: "x", ref: "h", until: new Date(Date.now() - 1).toISOString() });
  await ctx.storage.holds.put("live", { coupon: "c", cart: "y", ref: "h2", until: new Date(Date.now() + 60_000).toISOString() });
  await plugin.hooks.cron({ name: "sweep" }, ctx);
  assert.deepEqual([...ctx.storage.holds.rows.keys()], ["live"]);
});
