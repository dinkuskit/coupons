// The Coupons page's screens, in EmDash's Block Kit. Plain data in, blocks out.
import type { Block, BlockResponse, ButtonElement, FormField } from "@emdash-cms/blocks/server";
import { TIME_ZONES, when } from "./dates.js";
import type { CourierState } from "./inbox.js";
import type { Counts } from "./store.js";
import { discountText, factsOf, stateOf, type Coupon, type Draft } from "./terms.js";

export type Toast = NonNullable<BlockResponse["toast"]>;

const page = (blocks: Block[], toast?: Toast): BlockResponse => (toast ? { blocks, toast } : { blocks });
const button = (label: string, action_id: string, value?: unknown, style?: ButtonElement["style"]): ButtonElement =>
  ({ type: "button", label, action_id, ...(value === undefined ? {} : { value }), ...(style ? { style } : {}) });
const banner = (title: string, description: string, variant: "default" | "alert" | "error" = "error"): Block =>
  ({ type: "banner", variant, title, description });

const BADGE: Record<ReturnType<typeof stateOf>, string> = { On: "🟢 On", Off: "⚪ Off", Scheduled: "🟡 Scheduled", Ended: "⚪ Ended" };

export function usedText(coupon: Coupon, counts: Counts): string {
  return coupon.limit === undefined ? counts.used.toLocaleString("en-US") : `${counts.used.toLocaleString("en-US")} of ${coupon.limit.toLocaleString("en-US")}`;
}

export interface ListView {
  items: { id: string; coupon: Coupon; counts: Counts }[];
  cursor?: string;
  zone: string;
  courier: CourierState;
}

const COURIER_NOTICE: Record<Exclude<CourierState["state"], "visiting">, [string, string]> = {
  missing: ["Paid uses aren't being counted yet",
    "Coupons counts a use when the store's courier brings news of a paid order, and it hasn't come by yet. Shoppers can still use codes; limits count once it does."],
  late: ["The store's courier is late",
    "It hasn't come by for over five minutes, so the newest paid orders aren't counted yet. They will be when it returns."],
};

export function listScreen(view: ListView, toast?: Toast): BlockResponse {
  const now = Date.now();
  const notice = view.courier.state === "visiting" ? null : COURIER_NOTICE[view.courier.state];
  const zone = TIME_ZONES.find(option => option.value === view.zone) ? TIME_ZONES : [...TIME_ZONES, { label: view.zone, value: view.zone }];
  return page([
    { type: "header", text: "Coupons" },
    ...(notice ? [banner(notice[0], notice[1], "alert")] : []),
    { type: "section", text: "Discount codes shoppers type at checkout.", accessory: button("New coupon", "new", undefined, "primary") },
    {
      type: "table",
      block_id: "coupons",
      columns: [
        { key: "code", label: "Code", format: "code" },
        { key: "status", label: "Status", format: "badge" },
        { key: "discount", label: "Discount" },
        { key: "used", label: "Used" },
        { key: "ends", label: "Ends" },
        { key: "open", label: "", format: "element" },
      ],
      rows: view.items.map(({ id, coupon, counts }) => ({
        code: coupon.code,
        status: BADGE[stateOf(coupon, now)],
        discount: discountText(coupon),
        used: usedText(coupon, counts),
        ends: coupon.ends ? when(coupon.ends, view.zone) : "Never",
        open: button("Open", "open", id),
      })),
      ...(view.cursor ? { next_cursor: view.cursor } : {}),
      page_action_id: "more",
      empty_text: "No coupons yet. Create one with New coupon.",
    },
    { type: "divider" },
    {
      type: "form",
      block_id: "settings",
      fields: [{ type: "select", action_id: "timeZone", label: "Store time zone", options: zone, initial_value: view.zone }],
      submit: { label: "Save time zone", action_id: "save_zone" },
    },
    { type: "context", text: "Every coupon starts at 12:00 AM on its first day and ends at 11:59 PM on its last day, in this time zone." },
  ], toast);
}

const STATE_NOTICE: Partial<Record<ReturnType<typeof stateOf>, [string, string]>> = {
  Off: ["This coupon is turned off", "Shoppers who type it are told it isn't a valid code. Checkouts that already used it keep their discount."],
  Ended: ["This coupon has ended", "Edit it to pick a later last day."],
  Scheduled: ["This coupon hasn't started yet", "Shoppers can use it from its first day."],
};

export function couponScreen(id: string, coupon: Coupon, counts: Counts, zone: string, toast?: Toast, problem?: string): BlockResponse {
  const state = STATE_NOTICE[stateOf(coupon)];
  return page([
    { type: "header", text: `Coupon ${coupon.code}` },
    ...(problem ? [banner("Not changed", problem)] : []),
    ...(state ? [banner(state[0], state[1], "default")] : []),
    { type: "stats", items: [
      { label: "Used", value: counts.used, description: "Paid orders; test orders aren't counted" },
      { label: "In checkouts now", value: counts.held, description: "Held while a shopper pays, at most an hour" },
      ...(coupon.limit === undefined ? [] : [{ label: "Left", value: Math.max(0, coupon.limit - counts.used - counts.held) }]),
    ] },
    { type: "fields", fields: factsOf(coupon, zone).map(([label, value]) => ({ label, value })) },
    { type: "actions", elements: [
      button("Edit", "edit", id),
      coupon.on ? button("Turn off", "turn_off", id, "danger") : button("Turn on", "turn_on", id, "primary"),
      button("Back to coupons", "list"),
    ] },
    { type: "context", text: `Coupon ID ${id} · version ${coupon.version}` },
  ], toast);
}

export type FormMode = { kind: "create" } | { kind: "edit"; id: string; coupon: Coupon };

export function formScreen(mode: FormMode, draft: Draft, zone: string, problems: string[] = []): BlockResponse {
  const create = mode.kind === "create";
  const money = { field: "discount", neq: "none" };
  const fields: FormField[] = [
    { type: "text_input", action_id: "code", label: "Code shoppers type", placeholder: "SPRING25", initial_value: draft.code },
    { type: "select", action_id: "discount", label: "Discount", initial_value: draft.discount, options: [
      { label: "Percent off", value: "percent" },
      { label: "Dollars off the order", value: "order" },
      { label: "Dollars off each item", value: "each" },
      { label: "No money off (free shipping only)", value: "none" },
    ] },
    { type: "text_input", action_id: "percent", label: "Percent off", placeholder: "15", initial_value: draft.percent, condition: { field: "discount", eq: "percent" } },
    { type: "text_input", action_id: "dollars", label: "Dollars off (the order, or each item)", placeholder: "10", initial_value: draft.dollars, condition: { field: "discount", neq: "percent" } },
    { type: "toggle", action_id: "freeShipping", label: "Free shipping", initial_value: draft.freeShipping },
    { type: "select", action_id: "appliesTo", label: "Applies to", initial_value: draft.appliesTo, condition: money, options: [
      { label: "Every product", value: "all" },
      { label: "Chosen products", value: "products" },
      { label: "Chosen categories", value: "categories" },
    ] },
    { type: "text_input", action_id: "ids", label: "Product IDs or category slugs, separated by commas", initial_value: draft.ids, condition: { field: "appliesTo", neq: "all" } },
    { type: "toggle", action_id: "excludeSale", label: "Don't discount items already on sale", initial_value: draft.excludeSale, condition: money },
    { type: "select", action_id: "minimum", label: "Minimum", initial_value: draft.minimum, options: [
      { label: "None", value: "none" },
      { label: "Order amount", value: "amount" },
      { label: "Number of items", value: "items" },
    ] },
    { type: "text_input", action_id: "minimumDollars", label: "Minimum order, in dollars", initial_value: draft.minimumDollars, condition: { field: "minimum", eq: "amount" } },
    { type: "text_input", action_id: "minimumItems", label: "Minimum number of items", initial_value: draft.minimumItems, condition: { field: "minimum", eq: "items" } },
    { type: "date_input", action_id: "startsOn", label: create ? "First day (blank starts now)" : "First day", initial_value: draft.startsOn },
    { type: "date_input", action_id: "endsOn", label: "Last day (blank never ends)", initial_value: draft.endsOn },
    { type: "text_input", action_id: "limit", label: "Total uses, across all shoppers (blank for no limit)", initial_value: draft.limit },
    { type: "toggle", action_id: "oncePerShopper", label: "One use per shopper, by order email", initial_value: draft.oncePerShopper },
    { type: "toggle", action_id: "combinesWithProduct", label: "Combines with product discounts", initial_value: draft.combinesWithProduct },
    { type: "toggle", action_id: "combinesWithOrder", label: "Combines with order discounts", initial_value: draft.combinesWithOrder },
    { type: "toggle", action_id: "combinesWithShipping", label: "Combines with shipping discounts", initial_value: draft.combinesWithShipping },
    ...(create ? [{ type: "toggle" as const, action_id: "on", label: "On, so shoppers can use it", initial_value: draft.on }] : []),
  ];
  return page([
    { type: "header", text: create ? "New coupon" : `Edit coupon ${mode.coupon.code}` },
    ...(problems.length ? [banner("Check these and save again", problems.join(" "))] : []),
    { type: "context", text: `Days are in the store's time zone (${zone}). A shopper can use up to 5 codes and 1 free shipping code on one order, when each one combines with the others.` },
    {
      type: "form",
      block_id: create ? "create" : `edit:${mode.id}`,
      fields,
      submit: { label: create ? "Create coupon" : "Save changes", action_id: create ? "create" : `save:${mode.coupon.version}:${mode.id}` },
    },
    { type: "actions", elements: [create ? button("Cancel", "list") : button("Cancel", "open", mode.id)] },
  ]);
}

export function goneScreen(): BlockResponse {
  return page([{ type: "header", text: "Coupons" }, banner("That coupon is no longer here", "Go back to the list and open it again."), { type: "actions", elements: [button("Back to coupons", "list")] }]);
}

