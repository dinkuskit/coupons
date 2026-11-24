import type { SandboxedPlugin } from "emdash/plugin";
import { couponsAdmin } from "./admin.js";
import { answerCheckout, releaseCheckout } from "./checkout.js";
import { courierInbox } from "./inbox.js";
import { sweep } from "./store.js";
import { getTool, listTool, mcp, saveTool, turnTool } from "./tools.js";

export const SWEEP_TASK = "sweep";
export const SWEEP_SCHEDULE = "*/15 * * * *";

/**
 * DinkusKit Coupons: discount codes shoppers type at checkout, kept in the store's own database.
 * The store's own checkout code asks `checkout/answer` and hands the answer to Commerce's add-ons door;
 * Commerce's paid news, carried by the store's courier, counts each use. Owners use the Coupons page, and
 * agents the same routes through EmDash's MCP tools.
 */
const plugin = {
  hooks: {
    "plugin:activate": async (_event, ctx) => {
      await ctx.cron?.schedule(SWEEP_TASK, { schedule: SWEEP_SCHEDULE });
    },
    // Every 15 minutes: ended holds and finished guess counts are deleted, so history stays bounded.
    cron: async (event, ctx) => {
      if (event.name === SWEEP_TASK) await sweep(ctx);
    },
  },
  routes: {
    admin: { public: false, permission: "plugins:manage", methods: ["POST"], handler: couponsAdmin },
    // The store's own code only (commerce-addons-door-20261124): private, and each refuses any signed-in caller.
    "checkout/answer": { public: false, permission: "plugins:manage", methods: ["POST"], handler: answerCheckout },
    "checkout/release": { public: false, permission: "plugins:manage", methods: ["POST"], handler: releaseCheckout },
    "courier/inbox": { public: false, permission: "plugins:manage", methods: ["POST"], handler: courierInbox },
    // EmDash's agent tools, for Administrators (coupons-agent-tools-20261124).
    "tools/list": { public: false, permission: "plugins:manage", methods: ["POST"], handler: listTool },
    "tools/get": { public: false, permission: "plugins:manage", methods: ["POST"], handler: getTool },
    "tools/save": { public: false, permission: "plugins:manage", methods: ["POST"], handler: saveTool },
    "tools/turn": { public: false, permission: "plugins:manage", methods: ["POST"], handler: turnTool },
  },
  // Plain JSON Schema, which EmDash's build accepts as well as Zod.
  mcp: mcp as unknown as SandboxedPlugin["mcp"],
} satisfies SandboxedPlugin;

export default plugin;
