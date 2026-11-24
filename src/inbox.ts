import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { ADDON, PluginRouteError } from "./checkout.js";
import { db, emailKey, findCode, readCoupon } from "./store.js";

/**
 * Coupons' courier inbox (dinkuskit/courier docs/doors.md). Commerce's `order.paid` news, carried by the store's
 * courier about once a minute, turns a checkout's held use into a counted use, once per order and coupon
 * (coupons-hold-20261124). A payment that arrives after its hold lapsed still counts, even over a coupon's limit.
 */
export const COURIER = 1;
export const SENDER = "dinkus-commerce";
export const TOPIC = "order.paid";
const BATCH = 50;
const MAX_ITEMS = 100;
const LAST_VISIT = "courier:last-visit";
const BOOKMARK = `courier:after:${encodeURIComponent(SENDER)}:${encodeURIComponent(TOPIC)}`;
const LATE_AFTER_MS = 5 * 60_000;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** The coupon part of one paid order, or null when Coupons priced nothing on it. */
export function paidUse(item: unknown): { order: string; email?: string; test: boolean; ref?: string; codes: string[] } | null {
  if (!record(item) || !record(item.data)) return null;
  const data = item.data;
  if (!text(data.orderId, 200) || !Array.isArray(data.addons)) return null;
  const mine = data.addons.find(addon => record(addon) && addon.from === ADDON) as Record<string, unknown> | undefined;
  if (!mine || !Array.isArray(mine.codes)) return null;
  const codes = mine.codes.filter((code): code is string => text(code, 64)).slice(0, 6);
  if (!codes.length) return null;
  return {
    order: data.orderId,
    ...(text(data.email, 254) ? { email: data.email } : {}),
    // An order is a test order unless Commerce says otherwise.
    test: data.test !== false,
    ...(text(mine.ref, 200) ? { ref: mine.ref } : {}),
    codes,
  };
}

function request(route: SandboxedRouteContext): Record<string, unknown> {
  // Over HTTP a private route always carries a signed-in person; the courier calls from the store's own code with none.
  if (route.user) throw new PluginRouteError("COURIER_ONLY", "Only the store's courier may use this door.", 403);
  const input = route.input;
  if (!record(input) || input.courier !== COURIER || typeof input.op !== "string") throw new PluginRouteError("BAD_COURIER_REQUEST", "This is not a courier request.", 400);
  return input;
}

/** Records one paid order's uses and drops its holds; a repeated delivery changes nothing. */
async function count(ctx: PluginContext, use: NonNullable<ReturnType<typeof paidUse>>, at: string): Promise<number> {
  const email = use.email ? await emailKey(use.email) : undefined;
  let saved = 0;
  // The coupons the hold named, so an edit, rename or turn-off since checkout never loses the use; else the codes.
  const named = (use.ref?.split(".").slice(1) ?? []).filter(id => /^c_[0-9a-f]{20}$/.test(id));
  const ids = named.length ? named : (await Promise.all(use.codes.map(code => findCode(ctx, code)))).flatMap(found => (found ? [found.id] : []));
  for (const id of new Set(ids)) {
    if (!await readCoupon(ctx, id)) continue;
    const row = { coupon: id, order: use.order, ...(email ? { email } : {}), test: use.test, at };
    if ((await db(ctx).uses.compareAndSet(`${use.order}:${id}`, null, row)).applied) saved++;
  }
  if (use.ref) {
    const holds = await db(ctx).holds.query({ where: { ref: use.ref }, limit: 20 });
    if (holds.items.length) await db(ctx).holds.deleteMany(holds.items.map(item => item.id));
  }
  return saved;
}

/** `POST courier/inbox`: says what Coupons listens to, then takes each batch of paid orders. */
export async function courierInbox(route: SandboxedRouteContext, ctx: PluginContext): Promise<unknown> {
  const input = request(route);
  if (input.op === "wants") {
    await ctx.kv.set(LAST_VISIT, new Date().toISOString());
    const after = await ctx.kv.get<unknown>(BOOKMARK);
    return { courier: COURIER, wants: [{ from: SENDER, topic: TOPIC, after: typeof after === "string" ? after : null, limit: BATCH }] };
  }
  if (input.op !== "deliver") throw new PluginRouteError("BAD_COURIER_REQUEST", "An inbox answers \"wants\" and \"deliver\".", 400);
  const { from, topic, items } = input;
  if (from !== SENDER || topic !== TOPIC) throw new PluginRouteError("UNWANTED_TOPIC", "Coupons only takes paid orders from Commerce.", 400);
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new PluginRouteError("BAD_COURIER_REQUEST", "A delivery needs at most 100 items.", 400);
  const after = typeof input.after === "string" ? input.after : null, next = typeof input.next === "string" ? input.next : null;
  const before = await ctx.kv.getVersioned<unknown>(BOOKMARK);
  const now = new Date().toISOString();
  let saved = 0;
  for (const item of items) {
    const use = paidUse(item);
    if (use) saved += await count(ctx, use, now);
  }
  // The bookmark moves only after the uses are saved, and only from the bookmark this batch was asked from.
  const current = typeof before?.value === "string" ? before.value : null;
  let moved = false;
  if (current === after && next !== null && next !== after) moved = (await ctx.kv.compareAndSet(BOOKMARK, before?.revision ?? null, next)).applied;
  return { courier: COURIER, saved, moved };
}

export interface CourierState { state: "visiting" | "late" | "missing"; lastVisit: string | null }

/** Whether the store's courier is coming by, for the owner's page: without it, paid uses are not counted. */
export async function courierState(ctx: PluginContext, now = Date.now()): Promise<CourierState> {
  const lastVisit = await ctx.kv.get<unknown>(LAST_VISIT);
  if (typeof lastVisit !== "string" || Number.isNaN(Date.parse(lastVisit))) return { state: "missing", lastVisit: null };
  return { state: now - Date.parse(lastVisit) > LATE_AFTER_MS ? "late" : "visiting", lastVisit };
}
