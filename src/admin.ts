import type { BlockResponse } from "@emdash-cms/blocks/server";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { validZone } from "./dates.js";
import { courierState } from "./inbox.js";
import { couponScreen, formScreen, goneScreen, listScreen, type Toast } from "./screens.js";
import { ZONE_KEY, countsOf, listCoupons, readCoupon, saveCoupon, storeZone, turnCoupon, type Saved } from "./store.js";
import { blankDraft, draftFrom, draftOf, termsFrom } from "./terms.js";

/** EmDash's Administrator role. */
const ADMINISTRATOR = 50;

type Interaction = { type: "page_load" } | { type: "block_action"; action_id: string; value?: unknown } | { type: "form_submit"; action_id: string; values: Record<string, unknown> };

function interaction(input: unknown): Interaction | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  if (value.type === "page_load") return { type: "page_load" };
  if (value.type === "block_action" && typeof value.action_id === "string") return { type: "block_action", action_id: value.action_id, value: value.value };
  if (value.type === "form_submit" && typeof value.action_id === "string" && typeof value.values === "object" && value.values !== null) {
    return { type: "form_submit", action_id: value.action_id, values: value.values as Record<string, unknown> };
  }
  return null;
}

export const PROBLEM: Record<Exclude<Saved, { saved: unknown }>["problem"], string> = {
  taken: "Another coupon already uses that code. Codes are not case-sensitive, so SAVE10 and save10 are the same code.",
  changed: "Someone changed this coupon while you were editing. Open it again and make your change once more.",
  gone: "That coupon is no longer here.",
};

export async function list(ctx: PluginContext, cursor?: string, toast?: Toast): Promise<BlockResponse> {
  const [page, zone, courier] = await Promise.all([listCoupons(ctx, cursor), storeZone(ctx), courierState(ctx)]);
  const items = await Promise.all(page.items.map(async ({ id, data }) => ({ id, coupon: data, counts: await countsOf(ctx, id) })));
  return listScreen({ items, ...(page.cursor ? { cursor: page.cursor } : {}), zone, courier }, toast);
}

async function open(ctx: PluginContext, id: string, toast?: Toast, problem?: string): Promise<BlockResponse> {
  const coupon = await readCoupon(ctx, id);
  if (!coupon) return goneScreen();
  return couponScreen(id, coupon, await countsOf(ctx, id), await storeZone(ctx), toast, problem);
}

const cursorOf = (value: unknown) => {
  const cursor = typeof value === "object" && value !== null ? (value as { cursor?: unknown }).cursor : undefined;
  return typeof cursor === "string" && cursor.length <= 2000 ? cursor : undefined;
};
const idOf = (value: unknown) => (typeof value === "string" && value.length <= 64 ? value : "");

/**
 * The Coupons page's one private route. EmDash lets only those who manage plugins in (plugins:manage); the
 * Administrator check here is the belt to that permission's braces.
 */
export async function couponsAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  const user = route.user;
  if (route.ui?.surface !== "admin-page" || typeof user?.role !== "number" || user.role < ADMINISTRATOR) {
    return { blocks: [{ type: "banner", variant: "error", title: "Coupons is for Administrators", description: "Ask an Administrator of this site to manage coupons." }] };
  }
  const input = interaction(route.input);
  if (!input) return { blocks: [] };
  if (input.type === "page_load") return list(ctx);
  const zone = await storeZone(ctx);

  if (input.type === "form_submit") {
    if (input.action_id === "save_zone") {
      const picked = input.values.timeZone;
      if (typeof picked !== "string" || !validZone(picked)) return list(ctx, undefined, { message: "Pick a time zone from the list.", type: "error" });
      await ctx.kv.set(ZONE_KEY, picked);
      return list(ctx, undefined, { message: "Saved. Coupon days now follow this time zone.", type: "success" });
    }
    if (input.action_id === "create") {
      const draft = draftFrom(input.values);
      const checked = termsFrom(draft, zone);
      if ("problems" in checked) return formScreen({ kind: "create" }, draft, zone, checked.problems);
      const saved = await saveCoupon(ctx, checked.terms);
      if ("problem" in saved) return formScreen({ kind: "create" }, draft, zone, [PROBLEM[saved.problem]]);
      return open(ctx, saved.saved.id, { message: `Coupon ${saved.saved.coupon.code} created.`, type: "success" });
    }
    const save = /^save:(\d{1,9}):(.+)$/.exec(input.action_id);
    if (save) {
      const id = save[2]!, version = Number(save[1]);
      const current = await readCoupon(ctx, id);
      if (!current) return goneScreen();
      const mode = { kind: "edit" as const, id, coupon: { ...current, version } };
      // An edit keeps whether the coupon is on; Turn on and Turn off change that.
      const draft = draftFrom({ ...input.values, on: current.on }, draftOf(current, zone));
      const checked = termsFrom(draft, zone, current);
      if ("problems" in checked) return formScreen(mode, draft, zone, checked.problems);
      const saved = await saveCoupon(ctx, checked.terms, { id, version });
      if ("problem" in saved) return formScreen(mode, draft, zone, [PROBLEM[saved.problem]]);
      return open(ctx, id, { message: "Saved. Checkouts already started keep the terms they began with.", type: "success" });
    }
    return { blocks: [] };
  }

  const action = input.action_id;
  if (action === "list") return list(ctx);
  if (action === "more") return list(ctx, cursorOf(input.value));
  if (action === "new") return formScreen({ kind: "create" }, blankDraft(), zone);
  if (action === "open") return open(ctx, idOf(input.value));
  if (action === "edit") {
    const id = idOf(input.value), coupon = await readCoupon(ctx, id);
    return coupon ? formScreen({ kind: "edit", id, coupon }, draftOf(coupon, zone), zone) : goneScreen();
  }
  if (action === "turn_on" || action === "turn_off") {
    const id = idOf(input.value), on = action === "turn_on";
    const turned = await turnCoupon(ctx, id, on);
    if ("problem" in turned) return turned.problem === "gone" ? goneScreen() : open(ctx, id, undefined, PROBLEM[turned.problem]);
    return open(ctx, id, { message: on ? "Turned on. Shoppers can use it." : "Turned off. Shoppers who type it are told it isn't valid.", type: "success" });
  }
  return { blocks: [] };
}
