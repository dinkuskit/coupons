// The store's checkout asks Coupons here, from its own server code with nobody signed in, then hands the answer
// to Commerce's add-ons door, `checkout/addons/start` (commerce-addons-door-20261124). EmDash plugins cannot call
// each other, so the store carries the answer; Commerce checks every price again and does the totals itself.
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { usd } from "./dates.js";
import { price, unmet, type Line } from "./pricing.js";
import { db, emailKey, findCode, newRef, sha256, type Guess } from "./store.js";
import { CODE_MAX, keyOf, kindOf, type Coupon } from "./terms.js";

/** The name the add-ons door, the order and Commerce's paid news know this plugin's answers by. */
export const ADDON = "dinkus-coupons";
/** Up to 5 product or order codes and 1 shipping code on one order (coupons-combining-20261124). */
export const MONEY_CODES = 5;
const CODES_MAX = 6;
const LINES_MAX = 100;
/** A hold lasts until the order is paid or the payment page closes, at most 60 minutes (coupons-hold-20261124). */
export const HOLD_MS = 60 * 60_000;
/** 10 wrong codes on one cart, or 50 from one connection, then a one-hour wait (coupons-guessing-20261124). */
export const CART_TRIES = 10;
export const CONNECTION_TRIES = 50;
const WAIT_MS = 60 * 60_000;

export type Reason = "not_found" | "not_started" | "expired" | "minimum" | "no_items" | "used_up" | "used_by_you" | "not_combinable" | "needs_email" | "try_later";

/**
 * A refusal, in the shape of EmDash's own route error. EmDash's sandbox passes only the words of a thrown error back
 * to the caller (as ROUTE_ERROR, status 400), so the code leads the words as well.
 */
export class PluginRouteError extends Error {
  override name = "PluginRouteError";
  constructor(readonly code: string, message: string, readonly status: number) { super(`${code}: ${message}`); }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const cents = (value: unknown): value is string => typeof value === "string" && /^\d{1,10}$/.test(value) && Number(value) <= 1e9;
const keysAre = (value: Record<string, unknown>, allowed: string[], needed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key)) && needed.every(key => Object.hasOwn(value, key));

interface Ask { cart: string; connection?: string; email?: string; codes: string[]; lines: Line[]; hold: boolean }

function bad(words: string): never {
  throw new PluginRouteError("BAD_REQUEST", words, 400);
}

/** Only the store's own code: over HTTP a private route always carries a signed-in person. */
export function storeOnly(route: SandboxedRouteContext): Record<string, unknown> {
  if (route.user) throw new PluginRouteError("STORE_ONLY", "Only the store's own code may use this door.", 403);
  if (!record(route.input)) bad("Send a JSON object.");
  return route.input;
}

function ask(input: Record<string, unknown>): Ask {
  if (!keysAre(input, ["cart", "connection", "email", "codes", "lines", "hold"], ["cart", "codes", "lines"])) bad("Unknown or missing fields.");
  const { cart, connection, email, codes, lines, hold } = input;
  if (!text(cart, 200)) bad("cart is the cart's key, 1 to 200 characters.");
  if (connection !== undefined && !text(connection, 200)) bad("connection is 1 to 200 characters.");
  if (email !== undefined && !(text(email, 254) && /^[^\s@]+@[^\s@]+$/.test(email))) bad("email is the order's email address.");
  if (!Array.isArray(codes) || codes.length > CODES_MAX || !codes.every(code => typeof code === "string" && code.trim().length > 0 && code.trim().length <= CODE_MAX)) {
    bad(`codes holds up to ${CODES_MAX} codes of 1 to ${CODE_MAX} characters.`);
  }
  if (!Array.isArray(lines) || !lines.length || lines.length > LINES_MAX) bad(`lines holds 1 to ${LINES_MAX} checkout lines.`);
  const seen = new Set<string>();
  const checked = lines.map((line: unknown): Line => {
    if (!record(line) || !keysAre(line, ["item", "product", "price", "quantity", "sale", "categories"], ["item", "price", "quantity"])) bad("A line is { item, product, price, quantity, sale, categories }.");
    const { item, product, price: unit, quantity, sale, categories } = line;
    if (!text(item, 200) || seen.has(item)) bad("Each line names a different item, 1 to 200 characters.");
    seen.add(item);
    if (product !== undefined && !text(product, 200)) bad("A line's product is 1 to 200 characters.");
    if (!cents(unit)) bad("A line's price is whole cents as a string, at most 1000000000.");
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 10_000) bad("A line's quantity is 1 to 10000.");
    if (sale !== undefined && typeof sale !== "boolean") bad("A line's sale is true or false.");
    if (categories !== undefined && !(Array.isArray(categories) && categories.length <= 50 && categories.every(slug => text(slug, 200)))) bad("A line's categories are up to 50 slugs.");
    return { item, product: (product as string | undefined) ?? item, price: unit, quantity: quantity as number, sale: sale === true, categories: (categories as string[] | undefined) ?? [] };
  });
  if (hold !== undefined && typeof hold !== "boolean") bad("hold is true or false.");
  return { cart, ...(connection ? { connection } : {}), ...(email ? { email } : {}), codes: codes.map(code => code.trim()), lines: checked, hold: hold === true };
}

const MESSAGES: Record<Reason, (coupon?: Coupon) => string> = {
  not_found: () => "This code isn't valid.",
  not_started: () => "This code can't be used yet.",
  expired: () => "This code has expired.",
  minimum: coupon => coupon?.minimum.type === "amount" ? `This code needs an order of ${usd(coupon.minimum.cents)} or more.`
    : coupon?.minimum.type === "items" ? `This code needs ${coupon.minimum.count} or more items.` : "Your order doesn't meet this code's minimum.",
  no_items: () => "This code doesn't apply to anything in your cart.",
  used_up: () => "This code has been used up.",
  used_by_you: () => "You've already used this code.",
  not_combinable: () => "This code can't be used with your other codes.",
  needs_email: () => "Enter your email to use this code.",
  try_later: () => "Too many codes were tried. Try again in an hour.",
};

export type CodeResult = { code: string; ok: true; off: string; freeShipping: boolean } | { code: string; ok: false; reason: Reason; message: string };
export interface AddonAnswer { from: string; ref?: string; codes: string[]; ship?: "free"; lines: { item: string; price: string; off: string }[] }

const blocked = (guess: Guess | null, now: number) => Boolean(guess?.blocked && Date.parse(guess.until) > now);

/** Counts one wrong code; true when that was the last one allowed before the wait. */
async function wrong(ctx: PluginContext, id: string, allowed: number, now: number): Promise<boolean> {
  for (let tries = 0; tries < 4; tries++) {
    const current = await db(ctx).guesses.getVersioned(id);
    const live = current && Date.parse(current.value.until) > now ? current.value : null;
    const count = (live?.wrong ?? 0) + 1;
    const next: Guess = count >= allowed
      ? { wrong: count, until: new Date(now + WAIT_MS).toISOString(), blocked: true }
      : { wrong: count, until: live?.until ?? new Date(now + WAIT_MS).toISOString(), blocked: false };
    if ((await db(ctx).guesses.compareAndSet(id, current?.revision ?? null, next)).applied) return next.blocked;
  }
  return false;
}

/**
 * Whether another checkout's hold, or a paid order, has taken the coupon's last use, or this shopper's one use. A code
 * that is one use per shopper is held only with the order's email; without one, Apply may still show it.
 */
async function taken(ctx: PluginContext, id: string, coupon: Coupon, cart: string, email: string | undefined, at: string, hold: boolean): Promise<Reason | null> {
  if (coupon.limit !== undefined) {
    const [used, held, mine] = await Promise.all([
      db(ctx).uses.count({ coupon: id, test: false }),
      db(ctx).holds.count({ coupon: id, until: { gt: at } }),
      db(ctx).holds.count({ coupon: id, cart, until: { gt: at } }),
    ]);
    if (used + held - mine >= coupon.limit) return "used_up";
  }
  if (coupon.oncePerShopper && hold && !email) return "needs_email";
  if (coupon.oncePerShopper && email) {
    const [used, held, mine] = await Promise.all([
      db(ctx).uses.count({ coupon: id, email, test: false }),
      db(ctx).holds.count({ coupon: id, email, until: { gt: at } }),
      db(ctx).holds.count({ coupon: id, email, cart, until: { gt: at } }),
    ]);
    if (used + held - mine > 0) return "used_by_you";
  }
  return null;
}

/**
 * `POST checkout/answer`: checks the typed codes against the cart's lines and prices them. With `hold`, which the
 * store sends as checkout starts, it also holds a use of each accepted code for this cart and names the hold in
 * `ref`. The answer goes to Commerce exactly as given; null when no code applies.
 */
export async function answerCheckout(route: SandboxedRouteContext, ctx: PluginContext): Promise<{ codes: CodeResult[]; answer: AddonAnswer | null }> {
  const input = ask(storeOnly(route));
  const now = Date.now(), at = new Date(now).toISOString();
  const cart = await sha256(`cart:${input.cart}`);
  const email = input.email ? await emailKey(input.email) : undefined;
  const cartGuess = `cart:${cart}`, connectionGuess = input.connection ? `connection:${await sha256(`connection:${input.connection}`)}` : null;
  let waiting = blocked(await db(ctx).guesses.get(cartGuess), now) || (connectionGuess ? blocked(await db(ctx).guesses.get(connectionGuess), now) : false);

  const results: (CodeResult | null)[] = [];
  const accepted: { id: string; coupon: Coupon; at: number }[] = [];
  const typed = new Set<string>();
  for (const code of input.codes) {
    // The same code typed twice is one code.
    if (typed.has(keyOf(code))) continue;
    typed.add(keyOf(code));
    const refuse = (reason: Reason, coupon?: Coupon) => results.push({ code, ok: false, reason, message: MESSAGES[reason](coupon) });
    if (waiting) { refuse("try_later"); continue; }
    const found = await findCode(ctx, code);
    // A turned-off code answers exactly like a code that does not exist, and counts as a wrong guess.
    if (!found || !found.coupon.on) {
      const cartDone = await wrong(ctx, cartGuess, CART_TRIES, now);
      const connectionDone = connectionGuess ? await wrong(ctx, connectionGuess, CONNECTION_TRIES, now) : false;
      waiting = cartDone || connectionDone;
      refuse("not_found");
      continue;
    }
    const { id, coupon } = found;
    if (Date.parse(coupon.starts) > now) { refuse("not_started"); continue; }
    if (coupon.ends && Date.parse(coupon.ends) <= now) { refuse("expired"); continue; }
    const short = unmet(coupon, input.lines);
    if (short) { refuse(short, coupon); continue; }
    const gone = await taken(ctx, id, coupon, cart, email, at, input.hold);
    if (gone) { refuse(gone); continue; }
    const kind = kindOf(coupon);
    const sameKind = accepted.filter(other => (kindOf(other.coupon) === "shipping") === (kind === "shipping")).length;
    const fits = sameKind < (kind === "shipping" ? 1 : MONEY_CODES) &&
      accepted.every(other => other.coupon.combines[kind] && coupon.combines[kindOf(other.coupon)]);
    if (!fits) { refuse("not_combinable"); continue; }
    accepted.push({ id, coupon, at: results.length });
    results.push(null);
  }

  const priced = price(accepted.map(entry => entry.coupon), input.lines);
  accepted.forEach((entry, index) => {
    results[entry.at] = { code: entry.coupon.code, ok: true, off: String(priced.byCoupon[index]), freeShipping: entry.coupon.freeShipping };
  });
  const codes = results as CodeResult[];
  if (!accepted.length) {
    if (input.hold) await releaseCart(ctx, cart);
    return { codes, answer: null };
  }
  const answer: AddonAnswer = {
    from: ADDON,
    codes: accepted.map(entry => entry.coupon.code),
    ...(priced.freeShipping ? { ship: "free" as const } : {}),
    lines: input.lines.map((line, index) => ({ item: line.item, price: line.price, off: String(priced.lines[index]) })),
  };
  if (input.hold) answer.ref = await hold(ctx, cart, accepted.map(entry => entry.id), email, now);
  return { codes, answer };
}

/** Holds one use of each coupon for this cart. The same codes again keep the hold, its ref and its end time. */
async function hold(ctx: PluginContext, cart: string, coupons: string[], email: string | undefined, now: number): Promise<string> {
  const page = await db(ctx).holds.query({ where: { cart }, limit: 20 });
  const live = page.items.filter(item => Date.parse(item.data.until) > now);
  const same = live.length === coupons.length && live.every(item => coupons.includes(item.data.coupon)) &&
    new Set(live.map(item => item.data.ref)).size === 1 && live.every(item => item.data.email === email);
  if (same) return live[0]!.data.ref;
  if (page.items.length) await db(ctx).holds.deleteMany(page.items.map(item => item.id));
  // The ref names the coupons too, so the paid order is counted against them even after a rename.
  const ref = [newRef(), ...coupons].join("."), until = new Date(now + HOLD_MS).toISOString();
  for (const coupon of coupons) await db(ctx).holds.put(`${cart}:${coupon}`, { coupon, cart, ref, ...(email ? { email } : {}), until });
  return ref;
}

async function releaseCart(ctx: PluginContext, cart: string): Promise<number> {
  const page = await db(ctx).holds.query({ where: { cart }, limit: 20 });
  return page.items.length ? db(ctx).holds.deleteMany(page.items.map(item => item.id)) : 0;
}

/** `POST checkout/release`: the payment page closed without a payment, so the cart's held uses go back. */
export async function releaseCheckout(route: SandboxedRouteContext, ctx: PluginContext): Promise<{ released: number }> {
  const input = storeOnly(route);
  if (!keysAre(input, ["cart"], ["cart"]) || !text(input.cart, 200)) bad("Send { cart }.");
  return { released: await releaseCart(ctx, await sha256(`cart:${input.cart}`)) };
}

