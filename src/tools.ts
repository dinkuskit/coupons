// EmDash agent (MCP) tools: list, read, create, edit and turn coupons on and off, on private routes with the
// Coupons page's own permission (coupons-agent-tools-20261124). An agent sends the same fields the page's form has.
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";
import { PROBLEM } from "./admin.js";
import { PluginRouteError } from "./checkout.js";
import { countsOf, findCode, listCoupons, readCoupon, saveCoupon, storeZone, turnCoupon } from "./store.js";
import { draftFrom, draftOf, factsOf, termsFrom, type Coupon } from "./terms.js";

const ADMINISTRATOR = 50;

function input(route: SandboxedRouteContext): Record<string, unknown> {
  if (typeof route.user?.role !== "number" || route.user.role < ADMINISTRATOR) throw new PluginRouteError("ADMINISTRATORS_ONLY", "Coupons is for Administrators.", 403);
  const value = route.input ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PluginRouteError("BAD_REQUEST", "Send a JSON object.", 400);
  return value as Record<string, unknown>;
}

async function view(ctx: PluginContext, id: string, coupon: Coupon) {
  const [counts, zone] = await Promise.all([countsOf(ctx, id), storeZone(ctx)]);
  return { id, version: coupon.version, on: coupon.on, code: coupon.code, used: counts.used, held: counts.held,
    terms: Object.fromEntries(factsOf(coupon, zone)), fields: draftOf(coupon, zone), timeZone: zone };
}

/** `tools/list`: the coupons, newest first, 25 at a time. */
export async function listTool(route: SandboxedRouteContext, ctx: PluginContext) {
  const { cursor } = input(route);
  const page = await listCoupons(ctx, typeof cursor === "string" ? cursor : undefined);
  return { coupons: await Promise.all(page.items.map(({ id, data }) => view(ctx, id, data))), ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/** `tools/get`: one coupon by its id or its code. */
export async function getTool(route: SandboxedRouteContext, ctx: PluginContext) {
  const { id, code } = input(route);
  const found = typeof id === "string" ? await readCoupon(ctx, id).then(coupon => (coupon ? { id, coupon } : null))
    : typeof code === "string" && code.length <= 64 ? await findCode(ctx, code) : null;
  if (!found) throw new PluginRouteError("NOT_FOUND", "No coupon has that id or code.", 404);
  return { coupon: await view(ctx, found.id, found.coupon) };
}

/** `tools/save`: creates a coupon, or with `id` and the `version` read changes one; a turned-off coupon stays off. */
export async function saveTool(route: SandboxedRouteContext, ctx: PluginContext) {
  const values = input(route);
  const zone = await storeZone(ctx);
  const { id, version } = values;
  if (id !== undefined) {
    if (typeof id !== "string" || !Number.isSafeInteger(version)) throw new PluginRouteError("BAD_REQUEST", "An edit sends the coupon's id and the version it read.", 400);
    const current = await readCoupon(ctx, id);
    if (!current) throw new PluginRouteError("NOT_FOUND", PROBLEM.gone, 404);
    const checked = termsFrom(draftFrom({ ...values, on: current.on }, draftOf(current, zone)), zone, current);
    if ("problems" in checked) return { saved: false, problems: checked.problems };
    const saved = await saveCoupon(ctx, checked.terms, { id, version: version as number });
    return "problem" in saved ? { saved: false, problems: [PROBLEM[saved.problem]] } : { saved: true, coupon: await view(ctx, id, saved.saved.coupon) };
  }
  const checked = termsFrom(draftFrom(values), zone);
  if ("problems" in checked) return { saved: false, problems: checked.problems };
  const saved = await saveCoupon(ctx, checked.terms);
  return "problem" in saved ? { saved: false, problems: [PROBLEM[saved.problem]] } : { saved: true, coupon: await view(ctx, saved.saved.id, saved.saved.coupon) };
}

/** `tools/turn`: turns a coupon on or off. */
export async function turnTool(route: SandboxedRouteContext, ctx: PluginContext) {
  const { id, on } = input(route);
  if (typeof id !== "string" || typeof on !== "boolean") throw new PluginRouteError("BAD_REQUEST", "Send { id, on }.", 400);
  const turned = await turnCoupon(ctx, id, on);
  if ("problem" in turned) return { saved: false, problems: [PROBLEM[turned.problem]] };
  return { saved: true, coupon: await view(ctx, id, turned.saved.coupon) };
}

const FIELDS = {
  code: { type: "string", description: "The code shoppers type, 1 to 64 letters, numbers, dashes or underscores. Not case-sensitive." },
  discount: { type: "string", enum: ["percent", "order", "each", "none"], description: "percent off; dollars off the order; dollars off each item; or none (free shipping only)." },
  percent: { type: "string", description: "Percent off, such as \"15\" or \"12.5\", when discount is percent." },
  dollars: { type: "string", description: "Dollars off, such as \"10\" or \"12.50\", when discount is order or each." },
  freeShipping: { type: "boolean" },
  appliesTo: { type: "string", enum: ["all", "products", "categories"] },
  ids: { type: "array", items: { type: "string" }, maxItems: 100, description: "Catalog product ids or category slugs, when appliesTo is not all." },
  excludeSale: { type: "boolean", description: "Leave items already on sale undiscounted. Off by default." },
  minimum: { type: "string", enum: ["none", "amount", "items"] },
  minimumDollars: { type: "string" },
  minimumItems: { type: "string" },
  startsOn: { type: "string", description: "First day as YYYY-MM-DD in the store's time zone; blank starts now." },
  endsOn: { type: "string", description: "Last day as YYYY-MM-DD; blank never ends." },
  limit: { type: "string", description: "Total uses across all shoppers; blank for no limit." },
  oncePerShopper: { type: "boolean", description: "One use per order email." },
  combinesWithProduct: { type: "boolean" },
  combinesWithOrder: { type: "boolean" },
  combinesWithShipping: { type: "boolean" },
  on: { type: "boolean", description: "New coupons only: whether shoppers can use it now. Defaults to true." },
};

/** Build-only: the manifest's MCP tools. The Registry build strips this from the runtime. */
export const mcp = {
  tools: {
    list_coupons: { description: "List the store's coupons, newest first, with uses so far.", route: "tools/list",
      input: { type: "object", properties: { cursor: { type: "string" } }, additionalProperties: false } },
    get_coupon: { description: "Read one coupon by id or by code.", route: "tools/get",
      input: { type: "object", properties: { id: { type: "string" }, code: { type: "string" } }, additionalProperties: false } },
    save_coupon: { description: "Create a coupon, or edit one by sending its id and the version you read. Answers with problems to fix when a field is wrong.", route: "tools/save",
      input: { type: "object", properties: { id: { type: "string" }, version: { type: "integer" }, ...FIELDS }, additionalProperties: false } },
    turn_coupon: { description: "Turn a coupon on or off. A turned-off code is refused at checkout like a code that does not exist.", route: "tools/turn",
      input: { type: "object", properties: { id: { type: "string" }, on: { type: "boolean" } }, required: ["id", "on"], additionalProperties: false } },
  },
};
