// A coupon's terms: what the owner types on the Coupons page or an agent sends to a tool, checked into the
// record the store keeps (coupons-v1-settings-20261124, coupons-combining-20261124). Plain data: no storage.
import { cents, dayEdge, dayIn, dollarsText, usd, when } from "./dates.js";

export const CODE_MAX = 64;
export const IDS_MAX = 100;
export const ID_MAX = 200;
export const USES_MAX = 999_999_999;

export type Amount =
  | { type: "percent"; basisPoints: number }
  | { type: "order" | "each"; cents: string }
  | { type: "none" };

/** Shopify's three classes: what a coupon takes money off decides which others it may be used with. */
export type Kind = "product" | "order" | "shipping";

export interface Coupon {
  /** As the owner typed it; shoppers may type it in any case. */
  code: string;
  /** The code in capitals, which is how it is looked up. */
  key: string;
  on: boolean;
  /** Starts at 1 and goes up on every change; the id never changes. */
  version: number;
  amount: Amount;
  freeShipping: boolean;
  appliesTo: "all" | "products" | "categories";
  /** The chosen catalog product ids or category slugs; empty for every product. */
  ids: string[];
  excludeSale: boolean;
  minimum: { type: "none" } | { type: "amount"; cents: string } | { type: "items"; count: number };
  starts: string;
  ends?: string;
  /** Total uses across all shoppers; absent for no limit. */
  limit?: number;
  oncePerShopper: boolean;
  combines: Record<Kind, boolean>;
  createdAt: string;
  updatedAt: string;
}

export const keyOf = (code: string) => code.trim().toUpperCase();

/**
 * The class a coupon counts as when codes are combined: free shipping with nothing else is a shipping discount;
 * money off chosen products or off each item is a product discount; money off the whole order is an order discount.
 */
export function kindOf(coupon: Pick<Coupon, "amount" | "appliesTo">): Kind {
  if (coupon.amount.type === "none") return "shipping";
  return coupon.appliesTo !== "all" || coupon.amount.type === "each" ? "product" : "order";
}

/** The form's text, field by field, so a refused form comes back as the owner left it. Agents send the same names. */
export interface Draft {
  code: string;
  discount: "percent" | "order" | "each" | "none";
  percent: string;
  dollars: string;
  freeShipping: boolean;
  appliesTo: "all" | "products" | "categories";
  ids: string;
  excludeSale: boolean;
  minimum: "none" | "amount" | "items";
  minimumDollars: string;
  minimumItems: string;
  startsOn: string;
  endsOn: string;
  limit: string;
  oncePerShopper: boolean;
  combinesWithProduct: boolean;
  combinesWithOrder: boolean;
  combinesWithShipping: boolean;
  on: boolean;
}

export const blankDraft = (): Draft => ({
  code: "", discount: "percent", percent: "", dollars: "", freeShipping: false, appliesTo: "all", ids: "",
  excludeSale: false, minimum: "none", minimumDollars: "", minimumItems: "", startsOn: "", endsOn: "", limit: "",
  oncePerShopper: false, combinesWithProduct: false, combinesWithOrder: false, combinesWithShipping: false, on: true,
});

export function draftOf(coupon: Coupon, zone: string): Draft {
  const amount = coupon.amount, minimum = coupon.minimum;
  return {
    code: coupon.code,
    discount: amount.type,
    percent: amount.type === "percent" ? String(amount.basisPoints / 100) : "",
    dollars: amount.type === "order" || amount.type === "each" ? dollarsText(amount.cents) : "",
    freeShipping: coupon.freeShipping,
    appliesTo: coupon.appliesTo,
    ids: coupon.ids.join(", "),
    excludeSale: coupon.excludeSale,
    minimum: minimum.type,
    minimumDollars: minimum.type === "amount" ? dollarsText(minimum.cents) : "",
    minimumItems: minimum.type === "items" ? String(minimum.count) : "",
    startsOn: dayIn(coupon.starts, zone),
    endsOn: coupon.ends ? dayIn(coupon.ends, zone) : "",
    limit: coupon.limit === undefined ? "" : String(coupon.limit),
    oncePerShopper: coupon.oncePerShopper,
    combinesWithProduct: coupon.combines.product,
    combinesWithOrder: coupon.combines.order,
    combinesWithShipping: coupon.combines.shipping,
    on: coupon.on,
  };
}

const text = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value)
  : typeof value === "string" ? value.trim().slice(0, 4000) : "";
const pick = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? value as T : fallback;

/** A submitted form or a tool's input, read field by field; a missing field takes the blank form's value. */
export function draftFrom(values: Record<string, unknown>, base: Draft = blankDraft()): Draft {
  const has = (key: string) => Object.hasOwn(values, key);
  const flag = (key: keyof Draft) => has(key) ? values[key] === true : base[key] as boolean;
  const field = (key: keyof Draft) => has(key) ? text(values[key]) : base[key] as string;
  return {
    code: field("code"),
    discount: has("discount") ? pick(values.discount, ["percent", "order", "each", "none"], "percent") : base.discount,
    percent: field("percent"),
    dollars: field("dollars"),
    freeShipping: flag("freeShipping"),
    appliesTo: has("appliesTo") ? pick(values.appliesTo, ["all", "products", "categories"], "all") : base.appliesTo,
    ids: Array.isArray(values.ids) ? values.ids.map(text).join(", ") : field("ids"),
    excludeSale: flag("excludeSale"),
    minimum: has("minimum") ? pick(values.minimum, ["none", "amount", "items"], "none") : base.minimum,
    minimumDollars: field("minimumDollars"),
    minimumItems: field("minimumItems"),
    startsOn: field("startsOn"),
    endsOn: field("endsOn"),
    limit: field("limit"),
    oncePerShopper: flag("oncePerShopper"),
    combinesWithProduct: flag("combinesWithProduct"),
    combinesWithOrder: flag("combinesWithOrder"),
    combinesWithShipping: flag("combinesWithShipping"),
    on: flag("on"),
  };
}

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/;
const CODE = /^[\p{L}\p{N}_-]+$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type Terms = Omit<Coupon, "version" | "createdAt" | "updatedAt">;

/**
 * A draft as the coupon's terms in the store's time zone, or what to fix in plain words. A blank first day starts
 * now (or keeps an edited coupon's start); a blank last day never ends. A day the owner left alone keeps its exact time.
 */
export function termsFrom(draft: Draft, zone: string, current?: Coupon, now = Date.now()): { terms: Terms } | { problems: string[] } {
  const problems: string[] = [];
  const code = draft.code.trim();
  if (!code) problems.push("Enter a code.");
  else if (code.length > CODE_MAX) problems.push(`Keep the code to ${CODE_MAX} characters or fewer.`);
  else if (!CODE.test(code)) problems.push("A code is letters, numbers, dashes and underscores, with no spaces.");

  let amount: Amount | null = null;
  if (draft.discount === "percent") {
    const match = PERCENT.exec(draft.percent);
    const basisPoints = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : 0;
    if (basisPoints > 0 && basisPoints <= 10_000) amount = { type: "percent", basisPoints };
    else problems.push("Enter a percent off from 0.01 to 100, such as 15 or 12.5.");
  } else if (draft.discount === "none") {
    if (!draft.freeShipping) problems.push("Pick a discount, free shipping, or both.");
    else amount = { type: "none" };
  } else {
    const value = cents(draft.dollars);
    if (value && value > 0n) amount = { type: draft.discount, cents: String(value) };
    else problems.push("Enter the dollars off, such as 5 or 12.50.");
  }

  const ids = draft.appliesTo === "all" ? [] : [...new Set(draft.ids.split(",").map(id => id.trim()).filter(Boolean))];
  if (draft.appliesTo !== "all") {
    const what = draft.appliesTo === "products" ? "product" : "category";
    if (!ids.length) problems.push(`List at least one ${what}, or pick every product.`);
    if (ids.length > IDS_MAX) problems.push(`List at most ${IDS_MAX} ${what === "product" ? "products" : "categories"}.`);
    if (ids.some(id => id.length > ID_MAX || CONTROL.test(id))) problems.push(`A ${what} id is too long; copy it from its page.`);
  }

  let minimum: Coupon["minimum"] | null = { type: "none" };
  if (draft.minimum === "amount") {
    const value = cents(draft.minimumDollars);
    minimum = value && value > 0n ? { type: "amount", cents: String(value) } : null;
    if (!minimum) problems.push("Enter the minimum order amount in dollars, such as 50.");
  } else if (draft.minimum === "items") {
    const count = /^\d{1,4}$/.test(draft.minimumItems) ? Number(draft.minimumItems) : 0;
    minimum = count >= 1 ? { type: "items", count } : null;
    if (!minimum) problems.push("Enter the minimum number of items, 1 or more.");
  }

  const kept = (day: string, instant: string | undefined) => current && instant && day === dayIn(instant, zone) ? instant : null;
  let starts: string | null = new Date(now).toISOString();
  if (draft.startsOn) {
    starts = kept(draft.startsOn, current?.starts) ?? dayEdge(draft.startsOn, "start", zone);
    if (!starts) problems.push("Pick a real first day, or leave it blank to start now.");
  } else if (current) starts = current.starts;
  let ends: string | null | undefined;
  if (draft.endsOn) {
    ends = kept(draft.endsOn, current?.ends) ?? dayEdge(draft.endsOn, "end", zone);
    if (!ends) problems.push("Pick a real last day, or leave it blank for no end.");
    else if (starts && Date.parse(ends) <= Date.parse(starts)) problems.push("The last day must come after the first day.");
    else if (ends !== current?.ends && Date.parse(ends) <= now) problems.push("The last day has already passed; pick a later one.");
  }

  let limit: number | undefined;
  if (draft.limit) {
    limit = /^\d{1,9}$/.test(draft.limit) ? Number(draft.limit) : 0;
    if (!(limit >= 1 && limit <= USES_MAX)) problems.push("Enter the total uses as a whole number, 1 or more, or leave it blank for no limit.");
  }

  if (problems.length || !amount || !minimum || !starts || ends === null) return { problems };
  return { terms: {
    code, key: keyOf(code), on: draft.on, amount, freeShipping: draft.freeShipping || amount.type === "none",
    appliesTo: amount.type === "none" ? "all" : draft.appliesTo, ids: amount.type === "none" ? [] : ids,
    excludeSale: draft.excludeSale, minimum, starts, ...(ends ? { ends } : {}), ...(limit ? { limit } : {}),
    oncePerShopper: draft.oncePerShopper,
    combines: { product: draft.combinesWithProduct, order: draft.combinesWithOrder, shipping: draft.combinesWithShipping },
  } };
}

/** A saved coupon read back: anything that is not exactly what termsFrom writes is not a coupon. */
export function isCoupon(value: unknown): value is Coupon {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Coupon;
  return typeof c.code === "string" && c.key === keyOf(c.code) && typeof c.on === "boolean" && Number.isSafeInteger(c.version) &&
    typeof c.amount === "object" && Array.isArray(c.ids) && typeof c.starts === "string" && typeof c.combines === "object";
}

const PLAIN: Record<Kind, string> = { product: "product discounts", order: "order discounts", shipping: "shipping discounts" };

export function discountText(coupon: Pick<Coupon, "amount" | "freeShipping" | "appliesTo">): string {
  const amount = coupon.amount;
  const off = amount.type === "percent" ? `${amount.basisPoints / 100}% off` : amount.type === "order" ? `${usd(amount.cents)} off the order`
    : amount.type === "each" ? `${usd(amount.cents)} off each item` : "";
  const scope = amount.type === "percent" && coupon.appliesTo === "all" ? " the order" : "";
  return [off && off + scope, coupon.freeShipping ? "free shipping" : ""].filter(Boolean).join(" and ").replace(/^./, c => c.toUpperCase());
}

/** Whether shoppers can use the coupon right now, and if not, why. */
export function stateOf(coupon: Pick<Coupon, "on" | "starts" | "ends">, now = Date.now()): "On" | "Off" | "Scheduled" | "Ended" {
  if (!coupon.on) return "Off";
  if (coupon.ends && Date.parse(coupon.ends) <= now) return "Ended";
  return Date.parse(coupon.starts) > now ? "Scheduled" : "On";
}

/** The facts an owner reads on a coupon's page, in reading order. */
export function factsOf(coupon: Coupon, zone: string): Array<[string, string]> {
  const min = coupon.minimum;
  const combines = (Object.keys(PLAIN) as Kind[]).filter(kind => coupon.combines[kind]).map(kind => PLAIN[kind]);
  return [
    ["Code", coupon.code],
    ["Discount", discountText(coupon)],
    ["Applies to", coupon.appliesTo === "all" ? "Every product" : `${coupon.appliesTo === "products" ? "Products" : "Categories"}: ${coupon.ids.join(", ")}`],
    ["Sale items", coupon.excludeSale ? "Not discounted" : "Discounted too"],
    ["Minimum", min.type === "amount" ? `${usd(min.cents)} order` : min.type === "items" ? `${min.count} ${min.count === 1 ? "item" : "items"}` : "None"],
    ["Starts", when(coupon.starts, zone)],
    ["Ends", coupon.ends ? when(coupon.ends, zone) : "Never"],
    ["Total uses", coupon.limit === undefined ? "No limit" : coupon.limit.toLocaleString("en-US")],
    ["One use per shopper", coupon.oncePerShopper ? "Yes, by order email" : "No"],
    ["Combines with", combines.length ? combines.join(", ") : "No other codes"],
  ];
}

