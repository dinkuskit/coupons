import type { PluginContext, SandboxedPlugin, SandboxedRouteContext } from "emdash/plugin";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import {
  PASS_SETTING, PassRefused, Unreachable, couponService, errorCode, readPass, safeId,
  type Answer, type Call,
} from "./service.js";
import {
  banner, detailScreen, formScreen, listScreen, messageScreen, passScreen, previewScreen,
  unknownOutcomeScreen, unreachableScreen, type Counts, type PendingChange,
} from "./screens.js";
import {
  draftFromCoupon, draftFromValues, editChanges, newDraft, termsFromDraft,
  type Coupon,
} from "./terms.js";

// A previewed change waits in this plugin's KV under its confirmation value
// until the owner confirms or cancels it. The service's confirmation lasts five
// minutes; a record is kept a day so a lost answer can still be checked again.
const PENDING = "pending:";
const PENDING_KEEP_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION = /^cfm-[0-9a-f]{32}$/;
const ADMIN_ROLE = 50;

type Interaction =
  | { type: "page_load" }
  | { type: "block_action"; action_id: string; value?: unknown }
  | { type: "form_submit"; action_id: string; block_id?: string; values: Record<string, unknown> };

interface Session { ctx: PluginContext; call: Call; adminId: string }

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInteraction(input: unknown): Interaction | null {
  if (!object(input)) return null;
  if (input.type === "page_load") return { type: "page_load" };
  if (typeof input.action_id !== "string") return null;
  if (input.type === "block_action") return { type: "block_action", action_id: input.action_id, value: input.value };
  if (input.type === "form_submit" && object(input.values)) {
    return {
      type: "form_submit", action_id: input.action_id, values: input.values,
      ...(typeof input.block_id === "string" ? { block_id: input.block_id } : {}),
    };
  }
  return null;
}

/** Only a signed-in administrator on an admin page reaches the coupon screens. */
function administrator(route: SandboxedRouteContext): string | null {
  if (route.ui?.surface !== "admin-page" || route.user?.role !== ADMIN_ROLE) return null;
  const id = route.user.id;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}

function isMoney(value: unknown): boolean {
  return object(value) && value.currency === "USD" && typeof value.minor === "string";
}

// The service is this plugin's own backend, but a malformed answer must show
// a message rather than break the page, so each coupon is checked before use.
function isCoupon(value: unknown): value is Coupon {
  if (!object(value) || !safeId(value.couponId) || typeof value.code !== "string" || typeof value.disabled !== "boolean" ||
      !Number.isSafeInteger(value.globalCap) || !Number.isSafeInteger(value.revision) || !object(value.rule)) return false;
  const rule = value.rule, discount = rule.discount;
  return object(discount) &&
    (discount.kind === "fixed" ? isMoney(discount.amount)
      : discount.kind === "percentage" && Number.isSafeInteger(discount.basisPoints) && (discount.maximum === undefined || isMoney(discount.maximum))) &&
    (rule.appliesTo === "all-merchandise" || rule.appliesTo === "selected-products") &&
    Array.isArray(rule.selectedProductIds) && rule.selectedProductIds.every(id => typeof id === "string") &&
    typeof rule.includeSaleItems === "boolean" && isMoney(rule.minimumEligibleMerchandise) &&
    typeof rule.startsAt === "string" && typeof rule.endsAt === "string" && typeof rule.timeZone === "string";
}

function malformed(): never {
  throw new Unreachable("the coupon service answer did not have the expected shape");
}

function offsetOf(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

// --- Reads ----------------------------------------------------------------

async function readCoupons(session: Session): Promise<Coupon[]> {
  const answer = await session.call("GET", "/coupons");
  const coupons = answer.body.coupons;
  if (answer.status !== 200 || !Array.isArray(coupons) || !coupons.every(isCoupon)) malformed();
  return coupons;
}

async function readCoupon(session: Session, couponId: string): Promise<Coupon | null> {
  const answer = await session.call("GET", `/coupons/${couponId}`);
  if (answer.status === 404) return null;
  if (answer.status !== 200 || !isCoupon(answer.body.coupon)) malformed();
  return answer.body.coupon;
}

async function readCounts(session: Session, couponId: string): Promise<Counts | null> {
  try {
    const answer = await session.call("GET", `/coupons/${couponId}/counts`);
    const counts = answer.body.counts;
    if (answer.status !== 200 || !object(counts) ||
        !["cap", "pending", "consumed", "remaining"].every(key => Number.isSafeInteger(counts[key]))) return null;
    return counts as unknown as Counts;
  } catch (error) {
    if (error instanceof Unreachable) return null;
    throw error;
  }
}

async function showList(session: Session, offset = 0, notice?: Block, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
  return listScreen(await readCoupons(session), offset, notice, toast);
}

async function showCoupon(session: Session, couponId: unknown, notice?: Block, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
  const coupon = safeId(couponId) ? await readCoupon(session, couponId) : null;
  if (!coupon) return showList(session, 0, banner("That coupon wasn't found", "It may have been removed. Here are the coupons you have."));
  return detailScreen(coupon, await readCounts(session, coupon.couponId), notice, toast);
}

// --- Preview and confirm ----------------------------------------------------

const PREVIEW_REFUSALS: Record<string, string> = {
  CODE_IN_USE: "Another coupon already uses this code. Pick a different code.",
  NO_CHANGE: "That doesn't change anything.",
  NOT_FOUND: "That coupon wasn't found. It may have been removed.",
  INVALID_INPUT: "The coupon service couldn't accept these terms.",
};

function refusal(answer: Answer): string {
  const code = errorCode(answer);
  const error = answer.body.error;
  const detail = code === "INVALID_INPUT" && object(error) && typeof error.message === "string" ? ` (${error.message.slice(0, 200)})` : "";
  return `${(code && PREVIEW_REFUSALS[code]) ?? "The coupon service refused this change."}${detail}`;
}

/** Asks the service to preview a change and keeps it for the confirm click, or says why the service refused it. */
async function preview(session: Session, request: Record<string, unknown>): Promise<PendingChange | string> {
  const answer = await session.call("POST", "/coupons/previews", request);
  if (answer.status !== 200) return refusal(answer);
  const { preview: shown, confirmation } = answer.body;
  // A create's "after" has no coupon ID or revision yet; everything else must be a whole coupon.
  if (!object(shown) || !object(confirmation) || typeof confirmation.value !== "string" || !CONFIRMATION.test(confirmation.value) ||
      typeof confirmation.expiresAt !== "string" || !object(shown.after) ||
      !isCoupon({ couponId: "new", revision: 0, ...shown.after }) || (shown.before !== null && !isCoupon(shown.before))) malformed();
  const change: PendingChange = {
    adminId: session.adminId,
    commandId: `cmd-${crypto.randomUUID()}`,
    confirmation: confirmation.value,
    expiresAt: confirmation.expiresAt,
    request,
    preview: {
      action: request.action as PendingChange["preview"]["action"],
      couponId: typeof shown.couponId === "string" ? shown.couponId : null,
      before: shown.before as Coupon | null,
      after: shown.after as unknown as Coupon,
    },
    createdAt: Date.now(),
  };
  await session.ctx.kv.set(`${PENDING}${change.confirmation}`, change);
  return change;
}

async function pendingChange(session: Session, value: unknown): Promise<PendingChange | BlockResponse> {
  const change = typeof value === "string" && CONFIRMATION.test(value)
    ? await session.ctx.kv.get<PendingChange>(`${PENDING}${value}`) : null;
  if (!object(change)) {
    return showList(session, 0, banner("This change isn't waiting any more", "It was already finished or cancelled. Nothing was changed by this click.", "alert"));
  }
  if (change.adminId !== session.adminId) {
    return messageScreen("Only the person who previewed this change can confirm it", "Nothing was changed. Preview the change yourself to make it.");
  }
  return change;
}

const COMMIT_REFUSALS: Record<string, string> = {
  REVISION_CONFLICT: "Someone changed this coupon after you previewed. Nothing was changed. Check the coupon and try again.",
  CODE_IN_USE: "Another coupon started using that code after you previewed. Nothing was changed.",
  NOT_FOUND: "That coupon no longer exists. Nothing was changed.",
  CONFIRMATION_EXPIRED: "The preview expired after 5 minutes. Nothing was changed. Start the change again.",
};

const DONE: Record<PendingChange["preview"]["action"], string> = {
  create: "created", edit: "saved", disable: "turned off", enable: "turned on",
};

async function confirm(session: Session, value: unknown): Promise<BlockResponse> {
  const change = await pendingChange(session, value);
  if (!("commandId" in change)) return change;
  const key = `${PENDING}${change.confirmation}`;
  let answer: Answer;
  try {
    // The same command ID every time, so checking again after a lost answer
    // returns the first result instead of making the change twice.
    answer = await session.call("POST", "/coupons/commands", {
      commandId: change.commandId, confirmation: change.confirmation, request: change.request,
    });
  } catch (error) {
    if (error instanceof Unreachable) return unknownOutcomeScreen(change);
    throw error;
  }
  const back = (notice: Block) => change.preview.couponId
    ? showCoupon(session, change.preview.couponId, notice) : showList(session, 0, notice);
  if (answer.status === 200 && answer.body.outcome === "committed") {
    await session.ctx.kv.delete(key);
    const coupon = answer.body.coupon;
    const toast = { type: "success" as const, message: `Coupon ${change.preview.after.code} ${DONE[change.preview.action]}.` };
    return isCoupon(coupon) ? detailScreen(coupon, await readCounts(session, coupon.couponId), undefined, toast)
      : showList(session, 0, undefined, toast);
  }
  const rejection = answer.body.rejection;
  const code = answer.body.outcome === "rejected" && object(rejection) && typeof rejection.code === "string"
    ? rejection.code : errorCode(answer);
  await session.ctx.kv.delete(key);
  return back(banner("That change didn't go through",
    (code && COMMIT_REFUSALS[code]) ?? "This preview can't be confirmed any more. Nothing was changed by this click."));
}

async function cancel(session: Session, value: unknown): Promise<BlockResponse> {
  const change = await pendingChange(session, value);
  if (!("commandId" in change)) return change;
  await session.ctx.kv.delete(`${PENDING}${change.confirmation}`);
  const toast = { type: "info" as const, message: "Cancelled. Nothing was changed." };
  return change.preview.couponId ? showCoupon(session, change.preview.couponId, undefined, toast) : showList(session, 0, undefined, toast);
}

async function forgetOldChanges(ctx: PluginContext): Promise<void> {
  const cutoff = Date.now() - PENDING_KEEP_MS;
  for (const entry of await ctx.kv.list(PENDING)) {
    const createdAt = object(entry.value) ? entry.value.createdAt : undefined;
    if (typeof createdAt !== "number" || createdAt < cutoff) await ctx.kv.delete(entry.key);
  }
}

// --- Forms ----------------------------------------------------------------

async function previewCreate(session: Session, values: Record<string, unknown>): Promise<BlockResponse> {
  const draft = draftFromValues(values);
  const read = termsFromDraft(draft);
  if ("problems" in read) return formScreen({ kind: "create" }, draft, read.problems);
  const change = await preview(session, { action: "create", coupon: read.terms });
  return typeof change === "string" ? formScreen({ kind: "create" }, draft, [change]) : previewScreen(change);
}

async function previewEdit(session: Session, blockId: string | undefined, values: Record<string, unknown>): Promise<BlockResponse> {
  const [, couponId, revision] = /^edit:([A-Za-z0-9._:-]{1,200}):(\d{1,15})$/.exec(blockId ?? "") ?? [];
  const current = couponId ? await readCoupon(session, couponId) : null;
  if (!current) return showList(session, 0, banner("That coupon wasn't found", "It may have been removed. Nothing was changed."));
  if (current.revision !== Number(revision)) {
    return formScreen({ kind: "edit", coupon: current }, draftFromCoupon(current), [],
      banner("This coupon changed while you were editing it", "Here is the current version. Make your changes again.", "alert"));
  }
  const draft = draftFromValues(values);
  const read = termsFromDraft(draft, current);
  if ("problems" in read) return formScreen({ kind: "edit", coupon: current }, draft, read.problems);
  const changes = editChanges(read.terms, current);
  if (!changes) return formScreen({ kind: "edit", coupon: current }, draft, ["You haven't changed anything yet."]);
  const change = await preview(session, { action: "edit", couponId: current.couponId, changes });
  return typeof change === "string" ? formScreen({ kind: "edit", coupon: current }, draft, [change]) : previewScreen(change);
}

async function previewSwitch(session: Session, action: "disable" | "enable", couponId: unknown): Promise<BlockResponse> {
  if (!safeId(couponId)) return showList(session);
  const change = await preview(session, { action, couponId });
  return typeof change === "string" ? showCoupon(session, couponId, banner("That change can't be made", change)) : previewScreen(change);
}

async function editForm(session: Session, couponId: unknown): Promise<BlockResponse> {
  const coupon = safeId(couponId) ? await readCoupon(session, couponId) : null;
  if (!coupon) return showList(session, 0, banner("That coupon wasn't found", "It may have been removed."));
  return formScreen({ kind: "edit", coupon }, draftFromCoupon(coupon));
}

// --- Routing --------------------------------------------------------------

async function respond(session: Session, interaction: Interaction): Promise<BlockResponse> {
  if (interaction.type === "page_load") {
    await forgetOldChanges(session.ctx);
    return showList(session);
  }
  if (interaction.type === "form_submit") {
    if (interaction.action_id === "preview_create") return previewCreate(session, interaction.values);
    if (interaction.action_id === "preview_edit") return previewEdit(session, interaction.block_id, interaction.values);
    return showList(session);
  }
  const { action_id: action, value } = interaction;
  switch (action) {
    case "list": return showList(session, offsetOf(value));
    case "new": return formScreen({ kind: "create" }, newDraft());
    case "open": return showCoupon(session, value);
    case "edit": return editForm(session, value);
    case "turn_off": return previewSwitch(session, "disable", value);
    case "turn_on": return previewSwitch(session, "enable", value);
    case "confirm": return confirm(session, value);
    case "cancel": return cancel(session, value);
    default: return showList(session);
  }
}

export async function handleAdmin(route: SandboxedRouteContext, ctx: PluginContext): Promise<BlockResponse> {
  const adminId = administrator(route);
  if (!adminId) return messageScreen("Only site administrators can manage coupons", "Sign in as an administrator to use this page.");
  const interaction = readInteraction(route.input);
  if (!interaction) return messageScreen("That action wasn't understood", "Reload this page and try again.");
  let saved: unknown;
  try {
    saved = await ctx.settings.get(PASS_SETTING);
  } catch (error) {
    // A secret the site can no longer decrypt reads as a pass to paste again.
    ctx.log.warn("Coupon pass could not be read", { reason: error instanceof Error ? error.message : "unknown" });
    return passScreen("unreadable");
  }
  const pass = readPass(saved);
  if (typeof pass === "string") return passScreen(pass);
  try {
    return await respond({ ctx, call: couponService(ctx, pass), adminId }, interaction);
  } catch (error) {
    if (error instanceof PassRefused) return passScreen("refused");
    if (error instanceof Unreachable) {
      ctx.log.warn("Coupon service unavailable", { reason: error.message });
      return unreachableScreen();
    }
    throw error;
  }
}

const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      permission: "plugins:manage",
      handler: async (route, ctx) => handleAdmin(route, ctx),
    },
  },
};

export default plugin;
