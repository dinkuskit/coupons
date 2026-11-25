import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../dist/plugin.mjs";
import { lines, owner, storeCode, store } from "./store.mjs";

const routes = plugin.routes;
const save = async (ctx, fields) => {
  const done = await routes["tools/save"].handler(owner({ discount: "percent", percent: "10", ...fields }), ctx);
  assert.equal(done.saved, true, JSON.stringify(done.problems));
  return done.coupon;
};
const ask = (ctx, input) => routes["checkout/answer"].handler(storeCode({ cart: "cart-1", lines: lines(), ...input }), ctx);
const offs = answer => answer.lines.map(line => line.off);

test("only the store's own code may ask, and a malformed ask is refused before anything is read", async () => {
  const ctx = store();
  await assert.rejects(routes["checkout/answer"].handler({ ...owner({ cart: "c", codes: [], lines: lines() }) }, ctx), /^PluginRouteError: STORE_ONLY/);
  await assert.rejects(routes["checkout/release"].handler(owner({ cart: "c" }), ctx), /STORE_ONLY/);
  for (const bad of [
    { codes: ["A"], lines: [] },
    { codes: ["A"], lines: [{ ...lines()[0], price: "12.50" }] },
    { codes: ["A"], lines: [{ ...lines()[0], price: "1000000001" }] },
    { codes: ["A"], lines: [lines()[0], lines()[0]] },
    { codes: ["A", "B", "C", "D", "E", "F", "G"] },
    { codes: ["x".repeat(65)] },
    { codes: ["A"], total: "100" },
  ]) await assert.rejects(ask(ctx, bad), /BAD_REQUEST/);
});

test("percent off the order, dollars off the order spread by price, and dollars off each item", async () => {
  const ctx = store();
  await save(ctx, { code: "TEN" });
  await save(ctx, { code: "FIVE", discount: "order", dollars: "5" });
  await save(ctx, { code: "EACH", discount: "each", dollars: "2", appliesTo: "categories", ids: ["footwear"] });
  // Lines: boots $80, mugs 2 x $15, socks 3 x $10 (on sale): $140.
  const ten = await ask(ctx, { codes: ["ten"] });
  assert.deepEqual(offs(ten.answer), ["800", "300", "300"]);
  assert.deepEqual(ten.codes, [{ code: "TEN", ok: true, off: "1400", freeShipping: false }]);
  assert.equal(ten.answer.from, "dinkus-coupons");
  assert.deepEqual(ten.answer.codes, ["TEN"]);
  assert.equal(ten.answer.ref, undefined, "only a hold names a ref");
  // Each line names the item, unit price and quantity it priced, so Commerce refuses it for a cart that changed since.
  assert.deepEqual(ten.answer.lines.map(line => [line.item, line.price, line.qty]), [["boots", "8000", 1], ["mug", "1500", 2], ["socks-m", "1000", 3]]);
  const five = await ask(ctx, { codes: ["Five"] });
  assert.deepEqual(offs(five.answer), ["286", "107", "107"]);
  const each = await ask(ctx, { codes: ["EACH"] });
  assert.deepEqual(offs(each.answer), ["200", "0", "600"]);
});

test("sale items are discounted unless the coupon excludes them; a minimum counts only what the coupon reaches", async () => {
  const ctx = store();
  await save(ctx, { code: "NOSALE", excludeSale: true });
  await save(ctx, { code: "BIG", minimum: "amount", minimumDollars: "150" });
  await save(ctx, { code: "THREE", minimum: "items", minimumItems: "3", appliesTo: "products", ids: ["socks"] });
  await save(ctx, { code: "KIT", appliesTo: "categories", ids: ["garden"] });
  assert.deepEqual(offs((await ask(ctx, { codes: ["NOSALE"] })).answer), ["800", "300", "0"]);
  const big = await ask(ctx, { codes: ["BIG"] });
  assert.equal(big.answer, null);
  assert.deepEqual(big.codes, [{ code: "BIG", ok: false, reason: "minimum", message: "This code needs an order of $150.00 or more." }]);
  assert.deepEqual(offs((await ask(ctx, { codes: ["THREE"] })).answer), ["0", "0", "300"]);
  assert.equal((await ask(ctx, { codes: ["KIT"] })).codes[0].reason, "no_items");
});

test("a turned-off code answers exactly like a code that does not exist", async () => {
  const ctx = store();
  const coupon = await save(ctx, { code: "GONE" });
  await routes["tools/turn"].handler(owner({ id: coupon.id, on: false }), ctx);
  const off = await ask(ctx, { codes: ["GONE"] });
  const none = await ask(ctx, { codes: ["NOPE"], cart: "cart-2" });
  assert.deepEqual(off.codes[0], { ...none.codes[0], code: "GONE" });
  assert.equal(off.codes[0].reason, "not_found");
});

test("dates: not started yet, and ended", async () => {
  const ctx = store();
  await save(ctx, { code: "LATER", startsOn: "2099-01-01" });
  const ended = await save(ctx, { code: "OLD" });
  const row = ctx.storage.coupons.rows.get(ended.id);
  row.data.ends = "2020-01-01T04:59:59.000Z";
  assert.equal((await ask(ctx, { codes: ["LATER"] })).codes[0].reason, "not_started");
  assert.equal((await ask(ctx, { codes: ["OLD"] })).codes[0].reason, "expired");
});

test("codes combine only when each one's box allows the other's class, Shopify's way", async () => {
  const ctx = store();
  await save(ctx, { code: "ORDER10" });
  await save(ctx, { code: "ORDER20", percent: "20", combinesWithOrder: true });
  await save(ctx, { code: "ORDER5", percent: "5", combinesWithOrder: true, combinesWithProduct: true, combinesWithShipping: true });
  await save(ctx, { code: "BOOTS", discount: "order", dollars: "30", appliesTo: "products", ids: ["boots"], combinesWithOrder: true });
  await save(ctx, { code: "BOOTS2", percent: "50", appliesTo: "products", ids: ["boots"], combinesWithOrder: true, combinesWithProduct: true });
  await save(ctx, { code: "SHIP", discount: "none", freeShipping: true, combinesWithOrder: true });
  await save(ctx, { code: "SHIP2", discount: "none", freeShipping: true, combinesWithOrder: true });

  // Off by default: the second order code is refused.
  const plain = await ask(ctx, { codes: ["ORDER10", "ORDER20"] });
  assert.deepEqual(plain.codes.map(code => code.reason ?? "ok"), ["ok", "not_combinable"]);
  assert.equal(plain.codes[1].message, "This code can't be used with your other codes.");

  // Two order discounts each on the subtotal left after product discounts, added up: 20% + 5% of $140 = $35.
  const both = await ask(ctx, { codes: ["ORDER20", "ORDER5"] });
  assert.deepEqual(both.codes.map(code => code.off), ["2800", "700"]);

  // A product discount first, then an order discount on what is left: $30 off boots, then 5% of $110.
  const mixed = await ask(ctx, { codes: ["BOOTS", "ORDER5"] });
  assert.deepEqual(mixed.codes.map(code => code.off), ["3000", "550"]);
  assert.deepEqual(offs(mixed.answer), ["3250", "150", "150"]);

  const best = await ask(ctx, { codes: ["BOOTS2", "BOOTS"] });
  // BOOTS does not combine with product discounts, so it is refused next to BOOTS2.
  assert.deepEqual(best.codes.map(code => code.reason ?? "ok"), ["ok", "not_combinable"]);

  // Free shipping rides along; a second shipping code is refused.
  const ship = await ask(ctx, { codes: ["ORDER5", "SHIP", "SHIP2"] });
  assert.deepEqual(ship.codes.map(code => code.reason ?? "ok"), ["ok", "ok", "not_combinable"]);
  assert.equal(ship.answer.ship, "free");
  assert.deepEqual(ship.answer.codes, ["ORDER5", "SHIP"]);
});

test("only the best product discount applies to one line", async () => {
  const ctx = store();
  await save(ctx, { code: "HALF", percent: "50", appliesTo: "products", ids: ["boots"], combinesWithProduct: true });
  await save(ctx, { code: "TENBOOTS", discount: "order", dollars: "10", appliesTo: "products", ids: ["boots", "mug"], combinesWithProduct: true });
  const both = await ask(ctx, { codes: ["TENBOOTS", "HALF"] });
  // TENBOOTS spreads $10 as $7.27 on boots and $2.73 on mugs; HALF's $40 wins on boots, so TENBOOTS keeps only the mugs.
  assert.deepEqual(offs(both.answer), ["4000", "273", "0"]);
  assert.deepEqual(both.codes.map(code => code.off), ["273", "4000"]);
});

test("at most 5 money codes and 1 shipping code", async () => {
  const ctx = store();
  for (let n = 1; n <= 6; n++) await save(ctx, { code: `P${n}`, percent: "1", combinesWithOrder: true });
  const six = await ask(ctx, { codes: ["P1", "P2", "P3", "P4", "P5", "P6"] });
  assert.deepEqual(six.codes.map(code => code.ok), [true, true, true, true, true, false]);
});

test("no line goes below $0, whatever the codes add up to", async () => {
  const ctx = store();
  await save(ctx, { code: "ALL", percent: "100", combinesWithOrder: true });
  await save(ctx, { code: "MORE", discount: "order", dollars: "500", combinesWithOrder: true });
  const answer = (await ask(ctx, { codes: ["ALL", "MORE"] })).answer;
  assert.deepEqual(offs(answer), ["8000", "3000", "3000"]);
});

test("a hold keeps a use for one cart; the same codes again keep its ref, and release gives it back", async () => {
  const ctx = store();
  const coupon = await save(ctx, { code: "ONE", limit: "1" });
  const first = await ask(ctx, { codes: ["ONE"], hold: true });
  assert.match(first.answer.ref, new RegExp(`^h_[0-9a-f]{20}\\.${coupon.id}$`));
  assert.equal((await ask(ctx, { codes: ["ONE"], hold: true })).answer.ref, first.answer.ref);
  // Another cart finds the last use held.
  const other = await ask(ctx, { codes: ["ONE"], cart: "cart-2" });
  assert.equal(other.codes[0].reason, "used_up");
  assert.equal((await routes["tools/get"].handler(owner({ id: coupon.id }), ctx)).coupon.held, 1);
  assert.deepEqual(await routes["checkout/release"].handler(storeCode({ cart: "cart-1" }), ctx), { released: 1 });
  assert.equal((await ask(ctx, { codes: ["ONE"], cart: "cart-2" })).codes[0].ok, true);
  // A hold lapses after 60 minutes.
  await ask(ctx, { codes: ["ONE"], hold: true });
  const [row] = ctx.storage.holds.rows.values();
  assert.ok(Date.parse(row.data.until) - Date.now() <= 60 * 60_000 && Date.parse(row.data.until) - Date.now() > 59 * 60_000);
  row.data.until = new Date(Date.now() - 1000).toISOString();
  assert.equal((await ask(ctx, { codes: ["ONE"], cart: "cart-2" })).codes[0].ok, true);
  // No accepted code at checkout start lets go of the cart's hold.
  await ask(ctx, { codes: ["ONE"], hold: true });
  await ask(ctx, { codes: [], hold: true });
  assert.equal(ctx.storage.holds.rows.size, 0);
});

test("a refused Pay leaves one-use codes available and does not disturb an existing hold", async () => {
  const ctx = store();
  await save(ctx, { code: "LAST", limit: "1" });
  const mixed = { codes: ["LAST", "MISSPELLED"] };
  const preview = await ask(ctx, mixed);
  assert.deepEqual(preview.answer.codes, ["LAST"]);
  assert.equal(preview.answer.ref, undefined);
  const refused = await ask(ctx, { ...mixed, hold: true });
  assert.deepEqual(refused, { codes: preview.codes, answer: null });
  assert.equal(ctx.storage.holds.rows.size, 0);

  const payingCart = { cart: "cart-2", hold: true };
  const held = await ask(ctx, { ...payingCart, codes: ["LAST", "last"] });
  assert.ok(held.answer.ref);
  assert.equal(ctx.storage.holds.rows.size, 1);
  assert.equal((await ask(ctx, { ...payingCart, ...mixed })).answer, null);
  assert.equal((await ask(ctx, { ...payingCart, codes: ["MISSPELLED"] })).answer, null);
  assert.equal((await ask(ctx, { ...payingCart, codes: ["LAST"] })).answer.ref, held.answer.ref);
  assert.equal((await ask(ctx, { codes: ["LAST"] })).codes[0].reason, "used_up");
});

test("one use per shopper, by order email", async () => {
  const ctx = store();
  const coupon = await save(ctx, { code: "WELCOME", oncePerShopper: true });
  await ask(ctx, { codes: ["WELCOME"], email: "Sam@Example.test", hold: true });
  const again = await ask(ctx, { codes: ["WELCOME"], email: "sam@example.test ".trim(), cart: "cart-2" });
  assert.deepEqual(again.codes[0], { code: "WELCOME", ok: false, reason: "used_by_you", message: "You've already used this code." });
  // The email is kept only as a one-way hash.
  assert.doesNotMatch(JSON.stringify([...ctx.storage.holds.rows.values()]), /example\.test/i);
  assert.equal((await ask(ctx, { codes: ["WELCOME"], email: "lee@example.test", cart: "cart-3" })).codes[0].ok, true);
  // Without the order's email the code can be shown on Apply, but checkout cannot hold it, so no discount goes to Commerce.
  assert.equal((await ask(ctx, { codes: ["WELCOME"], cart: "cart-4" })).codes[0].ok, true);
  const unnamed = await ask(ctx, { codes: ["WELCOME"], cart: "cart-4", hold: true });
  assert.deepEqual(unnamed.codes[0], { code: "WELCOME", ok: false, reason: "needs_email", message: "Enter your email to use this code." });
  assert.equal(unnamed.answer, null);
  assert.equal([...ctx.storage.holds.rows.values()].some(row => row.data.cart === "cart-4"), false);
  void coupon;
});

test("10 wrong codes on one cart, or 50 from one connection, then an hour's wait", async () => {
  const ctx = store();
  await save(ctx, { code: "REAL" });
  for (let n = 0; n < 9; n++) assert.equal((await ask(ctx, { codes: [`WRONG${n}`], connection: "203.0.113.9" })).codes[0].reason, "not_found");
  const tenth = await ask(ctx, { codes: ["WRONG9", "REAL"], connection: "203.0.113.9" });
  assert.deepEqual(tenth.codes.map(code => code.reason), ["not_found", "try_later"]);
  assert.equal((await ask(ctx, { codes: ["REAL"] })).codes[0].message, "Too many codes were tried. Try again in an hour.");
  // The connection is kept only as a hash.
  assert.doesNotMatch(JSON.stringify([...ctx.storage.guesses.rows.keys()]), /203\.0\.113/);
  // Another cart on the same connection still has tries until the connection reaches 50.
  for (let cart = 2; cart <= 5; cart++) {
    for (let n = 0; n < 10; n++) await ask(ctx, { codes: [`W${n}`], cart: `cart-${cart}`, connection: "203.0.113.9" });
  }
  const fresh = await ask(ctx, { codes: ["REAL"], cart: "cart-9", connection: "203.0.113.9" });
  assert.equal(fresh.codes[0].reason, "try_later");
  assert.equal((await ask(ctx, { codes: ["REAL"], cart: "cart-9", connection: "198.51.100.1" })).codes[0].ok, true);
  // After the hour the timer clears them.
  for (const row of ctx.storage.guesses.rows.values()) row.data.until = new Date(Date.now() - 1).toISOString();
  await plugin.hooks.cron({ name: "sweep" }, ctx);
  assert.equal(ctx.storage.guesses.rows.size, 0);
  assert.equal((await ask(ctx, { codes: ["REAL"] })).codes[0].ok, true);
});
