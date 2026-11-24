import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { courier, lines, owner, storeCode, store } from "./store.mjs";

const routes = plugin.routes;
const inbox = (ctx, input) => routes["courier/inbox"].handler(courier(input), ctx);
const save = async (ctx, fields) => (await routes["tools/save"].handler(owner({ discount: "percent", percent: "10", ...fields }), ctx)).coupon;
const paid = (orderId, addons, over = {}) => ({ id: `${orderId}:paid`, at: "2026-11-24T15:00:00.000Z",
  data: { orderId, number: 1001, test: false, email: "sam@example.test", lines: [], total: { currency: "USD", minor: "12600" }, addons, ...over } });
const used = async (ctx, id) => (await routes["tools/get"].handler(owner({ id }), ctx)).coupon.used;

test("the inbox is for the store's courier only, and asks Commerce for paid orders", async () => {
  const ctx = store();
  await assert.rejects(routes["courier/inbox"].handler(owner({ courier: 1, op: "wants" }), ctx), /^PluginRouteError: COURIER_ONLY/);
  await assert.rejects(inbox(ctx, { op: "deliver", from: "dinkus-commerce", topic: "order.shipped", items: [] }), /UNWANTED_TOPIC/);
  assert.deepEqual(await inbox(ctx, { op: "wants" }), { courier: 1, wants: [{ from: "dinkus-commerce", topic: "order.paid", after: null, limit: 50 }] });
});

test("a paid order turns its hold into one counted use, once, and a test order never counts", async () => {
  const ctx = store();
  const coupon = await save(ctx, { code: "ONE", limit: "1" });
  const { answer } = await routes["checkout/answer"].handler(storeCode({ cart: "cart-1", codes: ["one"], lines: lines(), hold: true }), ctx);
  const delivery = { op: "deliver", from: "dinkus-commerce", topic: "order.paid", after: null, next: "k1",
    items: [paid("order-1", [{ from: "dinkus-coupons", ref: answer.ref, codes: answer.codes }]), paid("order-2", [])] };
  assert.deepEqual(await inbox(ctx, delivery), { courier: 1, saved: 1, moved: true });
  assert.equal(await used(ctx, coupon.id), 1);
  assert.equal(ctx.storage.holds.rows.size, 0, "the hold is gone once the use counts");
  // The same delivery again changes nothing.
  assert.deepEqual(await inbox(ctx, { ...delivery, after: "k1", next: "k1" }), { courier: 1, saved: 0, moved: false });
  assert.equal(await used(ctx, coupon.id), 1);
  // The one use is gone for everyone else now.
  const late = await routes["checkout/answer"].handler(storeCode({ cart: "cart-2", codes: ["ONE"], lines: lines() }), ctx);
  assert.equal(late.codes[0].reason, "used_up");
  // A test order is kept but does not count.
  await inbox(ctx, { ...delivery, after: "k1", next: "k2", items: [paid("order-3", [{ from: "dinkus-coupons", codes: ["ONE"] }], { test: true })] });
  assert.equal(await used(ctx, coupon.id), 1);
  assert.equal(ctx.storage.uses.rows.size, 2);
  assert.doesNotMatch(JSON.stringify([...ctx.storage.uses.rows.values()]), /example\.test/);
});

test("a payment after the hold lapsed still counts, even over the limit, and a rename since checkout loses nothing", async () => {
  const ctx = store();
  const coupon = await save(ctx, { code: "LAST", limit: "1" });
  const first = await routes["checkout/answer"].handler(storeCode({ cart: "a", codes: ["LAST"], lines: lines(), hold: true }), ctx);
  for (const row of ctx.storage.holds.rows.values()) row.data.until = new Date(Date.now() - 1).toISOString();
  const second = await routes["checkout/answer"].handler(storeCode({ cart: "b", codes: ["LAST"], lines: lines(), hold: true }), ctx);
  assert.equal(second.codes[0].ok, true);
  await routes["tools/save"].handler(owner({ id: coupon.id, version: 1, code: "RENAMED" }), ctx);
  await inbox(ctx, { op: "deliver", from: "dinkus-commerce", topic: "order.paid", after: null, next: "k1", items: [
    paid("order-b", [{ from: "dinkus-coupons", ref: second.answer.ref, codes: ["LAST"] }]),
    paid("order-a", [{ from: "dinkus-coupons", ref: first.answer.ref, codes: ["LAST"] }]),
  ] });
  assert.equal(await used(ctx, coupon.id), 2);
});
