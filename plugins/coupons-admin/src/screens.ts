import type { Block, BlockResponse, ButtonElement, FormField } from "@emdash-cms/blocks/server";
import type { PassProblem } from "./service.js";
import {
  TIME_ZONES, couponFacts, couponState, discountText, when,
  type Coupon, type Draft,
} from "./terms.js";

export const PAGE_SIZE = 25;

export interface Counts { cap: number; pending: number; consumed: number; remaining: number }

/** A previewed change waiting for the owner's confirm click, as the plugin keeps it. */
export interface PendingChange {
  adminId: string;
  commandId: string;
  confirmation: string;
  expiresAt: string;
  request: Record<string, unknown>;
  preview: { action: "create" | "edit" | "disable" | "enable"; couponId: string | null; before: Coupon | null; after: Coupon };
  createdAt: number;
}

type Toast = BlockResponse["toast"];

function page(blocks: Block[], toast?: Toast): BlockResponse {
  return toast ? { blocks, toast } : { blocks };
}

function button(label: string, action_id: string, value?: unknown, style?: ButtonElement["style"]): ButtonElement {
  return { type: "button", label, action_id, ...(value === undefined ? {} : { value }), ...(style ? { style } : {}) };
}

export function banner(title: string, description: string, variant: "default" | "alert" | "error" = "error"): Block {
  return { type: "banner", variant, title, description };
}

const backToList = () => button("Back to coupons", "list", 0);

export function messageScreen(title: string, description: string): BlockResponse {
  return page([{ type: "header", text: "Coupons" }, banner(title, description), { type: "actions", elements: [backToList()] }]);
}

const PASS_TEXT: Record<PassProblem | "refused", [string, string]> = {
  missing: ["Add your coupon pass",
    "This page needs a coupon pass from your DinkusKit account. Paste it in this plugin's settings, then come back."],
  unreadable: ["This doesn't look like a coupon pass",
    "The pass in this plugin's settings couldn't be read. Paste the coupon pass from your DinkusKit account again."],
  "not-admin": ["This pass can't manage coupons",
    "The pass in settings is for checkout only. Paste a coupon pass that can manage coupons."],
  expired: ["Your coupon pass has expired",
    "Coupon passes stop working an hour after they are issued. Paste a fresh one in this plugin's settings."],
  refused: ["The coupon service didn't accept your pass",
    "Paste a fresh coupon pass from your DinkusKit account in this plugin's settings."],
};

export function passScreen(problem: PassProblem | "refused"): BlockResponse {
  const [title, description] = PASS_TEXT[problem];
  return page([
    { type: "header", text: "Coupons" },
    banner(title, description, "alert"),
    { type: "actions", elements: [
      { type: "link", label: "Open settings", target: { kind: "plugin-settings" }, appearance: "primary" },
      button("Check again", "list", 0),
    ] },
  ]);
}

export function unreachableScreen(): BlockResponse {
  return page([
    { type: "header", text: "Coupons" },
    banner("The coupon service isn't answering", "Nothing was changed. Try again in a moment."),
    { type: "actions", elements: [button("Try again", "list", 0)] },
  ]);
}

function newest(left: Coupon, right: Coupon): number {
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.code.localeCompare(right.code);
}

export function listScreen(coupons: Coupon[], offset: number, notice?: Block, toast?: Toast): BlockResponse {
  const sorted = [...coupons].sort(newest);
  const start = Math.min(Math.max(0, offset), Math.max(0, Math.floor((sorted.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const shown = sorted.slice(start, start + PAGE_SIZE);
  const now = Date.now();
  const blocks: Block[] = [
    { type: "header", text: "Coupons" },
    ...(notice ? [notice] : []),
    { type: "section", text: "Discount codes shoppers can enter at checkout.", accessory: button("New coupon", "new", undefined, "primary") },
    {
      type: "table",
      block_id: "coupons",
      columns: [
        { key: "code", label: "Code", format: "code" },
        { key: "status", label: "Status", format: "badge" },
        { key: "discount", label: "Discount" },
        { key: "ends", label: "Ends" },
        { key: "uses", label: "Uses allowed", format: "number" },
        { key: "open", label: "", format: "element" },
      ],
      rows: shown.map(coupon => ({
        code: coupon.code,
        status: couponState(coupon, now),
        discount: discountText(coupon.rule),
        ends: when(coupon.rule.endsAt, coupon.rule.timeZone),
        uses: coupon.globalCap,
        open: button("Open", "open", coupon.couponId),
      })),
      page_action_id: "list",
      empty_text: "No coupons yet. Create one with New coupon.",
    },
  ];
  if (sorted.length > PAGE_SIZE) {
    blocks.push({ type: "context", text: `Showing ${start + 1} to ${start + shown.length} of ${sorted.length} coupons, newest first.` });
    const nav: ButtonElement[] = [];
    if (start > 0) nav.push(button("Previous", "list", start - PAGE_SIZE));
    if (start + PAGE_SIZE < sorted.length) nav.push(button("Next", "list", start + PAGE_SIZE));
    blocks.push({ type: "actions", elements: nav });
  }
  return page(blocks, toast);
}

const STATE_NOTICE: Record<string, [string, string] | undefined> = {
  Off: ["This coupon is turned off", "Shoppers can't use it until you turn it back on."],
  Ended: ["This coupon has ended", "Its last day has passed. Edit it to pick a later last day."],
  Scheduled: ["This coupon hasn't started yet", "Shoppers can use it from its first day."],
};

export function detailScreen(coupon: Coupon, counts: Counts | null, notice?: Block, toast?: Toast): BlockResponse {
  const state = STATE_NOTICE[couponState(coupon)];
  const blocks: Block[] = [
    { type: "header", text: `Coupon ${coupon.code}` },
    ...(notice ? [notice] : []),
    ...(state ? [banner(state[0], state[1], "default")] : []),
    counts
      ? { type: "stats", items: [
        { label: "Uses allowed", value: counts.cap },
        { label: "Used", value: counts.consumed },
        { label: "In checkouts now", value: counts.pending, description: "Held while a shopper pays" },
        { label: "Left", value: counts.remaining },
      ] }
      : { type: "context", text: "Uses left couldn't be loaded. Reload to try again." },
    { type: "fields", fields: couponFacts(coupon).map(([label, value]) => ({ label, value })) },
    { type: "actions", elements: [
      button("Edit", "edit", coupon.couponId),
      coupon.disabled
        ? button("Turn on", "turn_on", coupon.couponId, "primary")
        : button("Turn off", "turn_off", coupon.couponId, "danger"),
      backToList(),
    ] },
    { type: "context", text: `Coupon ID ${coupon.couponId}` },
  ];
  return page(blocks, toast);
}

export type FormMode = { kind: "create" } | { kind: "edit"; coupon: Coupon };

export function formScreen(mode: FormMode, draft: Draft, problems: string[] = [], notice?: Block): BlockResponse {
  const create = mode.kind === "create";
  const percent = { field: "discount_kind", eq: "percentage" };
  const zones = !draft.timeZone || TIME_ZONES.some(zone => zone.value === draft.timeZone)
    ? TIME_ZONES : [...TIME_ZONES, { label: draft.timeZone, value: draft.timeZone }];
  const uses = /^\d{1,9}$/.test(draft.uses) ? Number(draft.uses) : undefined;
  const fields: FormField[] = [
    { type: "text_input", action_id: "code", label: "Code shoppers type", placeholder: "SPRING25", initial_value: draft.code },
    { type: "select", action_id: "discount_kind", label: "Discount", initial_value: draft.kind, options: [
      { label: "Percent off", value: "percentage" },
      { label: "Dollar amount off", value: "fixed" },
    ] },
    { type: "text_input", action_id: "percent", label: "Percent off", placeholder: "15", initial_value: draft.percent, condition: percent },
    { type: "text_input", action_id: "max_discount", label: "Most it can take off, in dollars (optional)", initial_value: draft.maxDiscount, condition: percent },
    { type: "text_input", action_id: "amount", label: "Dollars off", placeholder: "10", initial_value: draft.amount, condition: { field: "discount_kind", eq: "fixed" } },
    { type: "text_input", action_id: "min_spend", label: "Minimum spend on the discounted items, in dollars", initial_value: draft.minSpend },
    { type: "text_input", action_id: "products", label: "Only these product IDs, separated by commas (leave blank for every product)", initial_value: draft.products },
    { type: "toggle", action_id: "include_sale_items", label: "Also discount items already on sale", initial_value: draft.includeSale },
    { type: "date_input", action_id: "starts_on", label: create ? "First day (leave blank to start now)" : "First day", initial_value: draft.startsOn },
    { type: "date_input", action_id: "ends_on", label: "Last day", initial_value: draft.endsOn },
    { type: "select", action_id: "time_zone", label: "Time zone for these days", options: zones, initial_value: draft.timeZone },
    { type: "number_input", action_id: "uses", label: "Total uses allowed, across all shoppers", min: 1, ...(uses === undefined ? {} : { initial_value: uses }) },
    ...(create ? [{ type: "toggle" as const, action_id: "start_off", label: "Create it turned off", initial_value: draft.startOff }] : []),
  ];
  const blocks: Block[] = [
    { type: "header", text: create ? "New coupon" : `Edit coupon ${mode.coupon.code}` },
    ...(notice ? [notice] : []),
    ...(problems.length ? [banner("Check these and try again", problems.join(" "))] : []),
    { type: "context", text: "A coupon runs from 12:00 AM on its first day to 11:59 PM on its last day, in the time zone you pick." },
    {
      type: "form",
      block_id: create ? "create" : `edit:${mode.coupon.couponId}:${mode.coupon.revision}`,
      fields,
      submit: { label: "Preview", action_id: create ? "preview_create" : "preview_edit" },
    },
    { type: "actions", elements: [create ? button("Cancel", "list", 0) : button("Cancel", "open", mode.coupon.couponId)] },
  ];
  return page(blocks);
}

const CONFIRM_LABEL = { create: "Create coupon", edit: "Save changes", disable: "Turn off", enable: "Turn on" };

export function previewScreen(change: PendingChange): BlockResponse {
  const { action, before, after } = change.preview;
  const blocks: Block[] = [
    { type: "header", text: action === "create" ? `Create coupon ${after.code}?` : `Change coupon ${before?.code ?? after.code}?` },
    { type: "section", text: "Nothing has changed yet. Confirm within 5 minutes to make this change." },
  ];
  if (!before) {
    blocks.push({ type: "fields", fields: couponFacts(after).map(([label, value]) => ({ label, value })) });
  } else {
    const now = new Map(couponFacts(before));
    blocks.push({
      type: "table",
      block_id: "changes",
      columns: [{ key: "what", label: "What" }, { key: "now", label: "Now" }, { key: "after", label: "After" }],
      rows: couponFacts(after).filter(([label, value]) => now.get(label) !== value)
        .map(([label, value]) => ({ what: label, now: now.get(label) ?? "-", after: value })),
      page_action_id: "list",
    });
  }
  if (action === "disable") {
    blocks.push({ type: "context", text: "Checkouts that already applied this coupon keep their discount. New checkouts can't use it." });
  }
  blocks.push({ type: "actions", elements: [
    button(CONFIRM_LABEL[action], "confirm", change.confirmation, action === "disable" ? "danger" : "primary"),
    button("Cancel", "cancel", change.confirmation),
  ] });
  return page(blocks);
}

export function unknownOutcomeScreen(change: PendingChange): BlockResponse {
  return page([
    { type: "header", text: "Coupons" },
    banner("We couldn't tell whether this change went through",
      "The coupon service didn't answer. Check again to finish it; checking again never makes the change twice.", "alert"),
    { type: "actions", elements: [button("Check again", "confirm", change.confirmation, "primary"), backToList()] },
  ]);
}
