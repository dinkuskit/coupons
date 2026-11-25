// The store's own coupon records, in the plugin's storage (coupons-plugin-home-20261124).
import type { PluginContext } from "emdash/plugin";
import { DEFAULT_ZONE, validZone } from "./dates.js";
import { isCoupon, keyOf, type Coupon, type Terms } from "./terms.js";

/** A use held for one cart's checkout until it is paid, or at most 60 minutes (coupons-hold-20261124). */
export interface Hold { coupon: string; cart: string; ref: string; email?: string; until: string }
/** One paid order's use of one coupon. Test orders are kept but never count toward a limit. */
export interface Use { coupon: string; order: string; email?: string; test: boolean; at: string }
/** Wrong codes from one cart or one connection, counted for an hour (coupons-guessing-20261124). */
export interface Guess { wrong: number; until: string; blocked: boolean }

interface Collection<T> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteMany(ids: string[]): Promise<number>;
  count(where?: Record<string, unknown>): Promise<number>;
  getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
  compareAndSet(id: string, expectedRevision: string | null, data: T): Promise<{ applied: boolean }>;
  compareAndDelete(id: string, expectedRevision: string): Promise<{ applied: boolean }>;
  query(options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string }):
    Promise<{ items: { id: string; data: T }[]; cursor?: string; hasMore: boolean }>;
}
interface Collections { coupons: Collection<Coupon>; holds: Collection<Hold>; uses: Collection<Use>; guesses: Collection<Guess> }
export const db = (ctx: PluginContext) => ctx.storage as unknown as Collections;

export const ZONE_KEY = "settings:timeZone";

/** The store's time zone, which every coupon's days are in; Eastern until the owner picks one. */
export async function storeZone(ctx: PluginContext): Promise<string> {
  const zone = await ctx.kv.get<unknown>(ZONE_KEY);
  return typeof zone === "string" && validZone(zone) ? zone : DEFAULT_ZONE;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
/** An order email as a one-way hash, so one use per shopper is checked without keeping the address. */
export const emailKey = (email: string) => sha256(`email:${email.trim().toLowerCase()}`);

const newId = (prefix: string) => `${prefix}_${[...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, "0")).join("")}`;
export const newRef = () => newId("h");

export async function readCoupon(ctx: PluginContext, id: string): Promise<Coupon | null> {
  const found = id.length <= 64 ? await db(ctx).coupons.get(id) : null;
  return isCoupon(found) ? found : null;
}

/** The coupon a typed code names, whatever its case. */
export async function findCode(ctx: PluginContext, code: string): Promise<{ id: string; coupon: Coupon } | null> {
  const page = await db(ctx).coupons.query({ where: { key: keyOf(code) }, limit: 1 });
  const hit = page.items[0];
  return hit && isCoupon(hit.data) ? { id: hit.id, coupon: hit.data } : null;
}

export async function listCoupons(ctx: PluginContext, cursor?: string, limit = 25) {
  const page = await db(ctx).coupons.query({ orderBy: { createdAt: "desc" }, limit, ...(cursor ? { cursor } : {}) });
  return { items: page.items.filter(item => isCoupon(item.data)), ...(page.hasMore && page.cursor ? { cursor: page.cursor } : {}) };
}

export type Saved = { saved: { id: string; coupon: Coupon } } | { problem: "taken" | "changed" | "gone" };

/**
 * Creates a coupon, or changes one when `id` and the version the owner saw are given. An edit keeps the id and only
 * bumps the version; checkouts already started keep the terms they were priced with (coupons-audit-requirements-20261124).
 */
export async function saveCoupon(ctx: PluginContext, terms: Terms, edit?: { id: string; version: number }): Promise<Saved> {
  const other = await findCode(ctx, terms.code);
  if (other && other.id !== edit?.id) return { problem: "taken" };
  const now = new Date().toISOString();
  if (!edit) {
    const id = newId("c");
    const coupon: Coupon = { ...terms, version: 1, createdAt: now, updatedAt: now };
    return (await db(ctx).coupons.compareAndSet(id, null, coupon)).applied ? { saved: { id, coupon } } : { problem: "changed" };
  }
  const current = await db(ctx).coupons.getVersioned(edit.id);
  if (!current || !isCoupon(current.value)) return { problem: "gone" };
  if (current.value.version !== edit.version) return { problem: "changed" };
  const coupon: Coupon = { ...terms, version: edit.version + 1, createdAt: current.value.createdAt, updatedAt: now };
  return (await db(ctx).coupons.compareAndSet(edit.id, current.revision, coupon)).applied ? { saved: { id: edit.id, coupon } } : { problem: "changed" };
}

/** Turns a coupon on or off; a turned-off code answers shoppers exactly like a code that does not exist. */
export async function turnCoupon(ctx: PluginContext, id: string, on: boolean): Promise<Saved> {
  const current = await db(ctx).coupons.getVersioned(id);
  if (!current || !isCoupon(current.value)) return { problem: "gone" };
  if (current.value.on === on) return { saved: { id, coupon: current.value } };
  const coupon: Coupon = { ...current.value, on, version: current.value.version + 1, updatedAt: new Date().toISOString() };
  return (await db(ctx).coupons.compareAndSet(id, current.revision, coupon)).applied ? { saved: { id, coupon } } : { problem: "changed" };
}

export interface Counts { used: number; held: number }

/** Paid uses (test orders left out) and uses held by checkouts still open. */
export async function countsOf(ctx: PluginContext, id: string, now = new Date().toISOString()): Promise<Counts> {
  const [used, held] = await Promise.all([
    db(ctx).uses.count({ coupon: id, test: false }),
    db(ctx).holds.count({ coupon: id, until: { gt: now } }),
  ]);
  return { used, held };
}

/** Deletes up to `rounds` pages of rows whose time has passed: ended holds and finished guess counts. */
export async function sweep(ctx: PluginContext, rounds = 10): Promise<number> {
  const now = new Date().toISOString();
  let gone = 0;
  for (const name of ["holds", "guesses"] as const) {
    for (let round = 0; round < rounds; round++) {
      const page = await db(ctx)[name].query({ where: { until: { lte: now } }, limit: 100 });
      if (!page.items.length) break;
      gone += await db(ctx)[name].deleteMany(page.items.map(item => item.id));
      if (!page.hasMore) break;
    }
  }
  return gone;
}
