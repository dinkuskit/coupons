import { isRecord as isObject } from "../../shared/record.js";
import type { PluginContext } from "emdash";
import type { CronEvent } from "emdash/plugin";
import { loadCheckoutContactRequirements } from "../store-settings/kernel/index.js";

import { GuestCheckoutError } from "./errors.js";
import {
  guestCheckoutFailure,
  prepareGuestCheckout,
  reconcileGuestPaymentWakes,
  startGuestCheckout,
  statusGuestCheckout,
} from "./guest.js";
import { admitGuestCheckoutWrite } from "./origin-admission.js";
import { resolveTrustedSiteOrigin } from "./site-scope.js";
import {
  SANDBOX_GUEST_CHECKOUT_STORAGE,
  bindGuestCheckoutRuntime,
} from "./runtime.js";
import type { GuestCheckoutHostOptions, GuestCheckoutResult } from "./types.js";
import type { CommercePaymentWakePort, WakeReconciliationResult } from "./wake.js";
import type { CheckoutCouponPort } from "../coupons/index.js";
import type { PaidOrderReceiver } from "../../handoffs/paid-order.js";

export const COMMERCE_CHECKOUT_WAKES_TASK = "commerce-checkout-wakes";
export const INSTALLED_COMMERCE_PLUGIN_ID = "dinkus-commerce";
/** EmDash 1.2.0 runtime ID for the manifest publisher DID and slug. */
export const COMMERCE_REGISTRY_RUNTIME_ID = "r_gshdrqaldna3r7sn";

export interface InstalledGuestCheckoutRequest {
  input: unknown;
  request: { url: string; headers?: Headers | Record<string, string> };
}

type InstalledStorage = Record<string, unknown>;
type InstalledContext = Pick<PluginContext, "plugin" | "storage" | "site" | "settings">;

export interface InstalledCheckoutServices {
  host: GuestCheckoutHostOptions;
  wakes?: CommercePaymentWakePort;
  /** Bound by the entry's own resolver; the host options cannot carry it. */
  coupons?: CheckoutCouponPort;
}

export type InstalledCheckoutServiceResolver = (
  ctx: PluginContext,
) => InstalledCheckoutServices | Promise<InstalledCheckoutServices>;

export interface InstalledCheckoutHandlers {
  prepare(route: InstalledGuestCheckoutRequest, ctx: PluginContext): Promise<GuestCheckoutResult>;
  start(route: InstalledGuestCheckoutRequest, ctx: PluginContext): Promise<GuestCheckoutResult>;
  status(route: InstalledGuestCheckoutRequest, ctx: PluginContext): Promise<GuestCheckoutResult>;
  reconcileWakes(ctx: PluginContext): Promise<InstalledWakeResult>;
  cron(event: CronEvent, ctx: PluginContext): Promise<void>;
}

export type InstalledWakeResult =
  | { executed: false; reason: "not-configured" | "unavailable" }
  | { executed: true; results: WakeReconciliationResult[] };

/** Binds Orders' receiving side from the installation's own storage. */
export type InstalledPaidOrders = (ctx: PluginContext) => PaidOrderReceiver | undefined;

type CronHandler = (event: CronEvent, ctx: PluginContext) => Promise<void>;

const collectionMethods = {
  carts: ["getVersioned", "compareAndSet"],
  capabilities: ["compareAndSet", "get", "getVersioned"],
  catalogItems: ["get"],
  prices: ["get"],
  backorderPolicies: ["get"],
  manualAvailability: ["get"],
  configurations: ["query"],
  settings: ["get"],
  listing: ["get"],
  paymentAssociations: ["get", "compareAndSet"],
} as const;


function installedStorage(ctx: InstalledContext): InstalledStorage {
  if (!isObject(ctx.plugin) ||
      (ctx.plugin.id !== INSTALLED_COMMERCE_PLUGIN_ID &&
       ctx.plugin.id !== COMMERCE_REGISTRY_RUNTIME_ID) ||
      typeof ctx.plugin.version !== "string" || !ctx.plugin.version.trim() ||
      !isObject(ctx.storage) ||
      !isObject(ctx.site) ||
      typeof ctx.site.url !== "string") {
    throw new GuestCheckoutError("UNAVAILABLE");
  }

  const storage = ctx.storage as InstalledStorage;
  for (const [name, methods] of Object.entries(collectionMethods)) {
    const collection = storage[SANDBOX_GUEST_CHECKOUT_STORAGE[name as keyof typeof collectionMethods]];
    if (!isObject(collection) ||
        methods.some(method => typeof collection[method] !== "function")) {
      throw new GuestCheckoutError("UNAVAILABLE");
    }
  }
  return storage;
}

function siteOrigin(ctx: InstalledContext) {
  const resolved = resolveTrustedSiteOrigin({ runtimeSiteUrl: ctx.site.url });
  if (!resolved.ok) throw new GuestCheckoutError("UNAVAILABLE");
  return resolved.origin;
}

function runtimeFor(ctx: PluginContext, services: InstalledCheckoutServices, paidOrders?: InstalledPaidOrders) {
  const storage = installedStorage(ctx);
  const origin = siteOrigin(ctx);
  const host = Object.freeze({
    ...services.host,
    loadCheckoutContactRequirements: () =>
      loadCheckoutContactRequirements(ctx.settings),
  });
  const resolved = resolveTrustedSiteOrigin({
    constructorSiteUrl: host.siteUrl,
    runtimeSiteUrl: origin,
    topLevelSiteUrl: host.topLevelSiteUrl,
    checkoutSiteUrl: host.checkoutSiteUrl,
  });
  if (!resolved.ok || resolved.origin !== origin) throw new GuestCheckoutError("UNAVAILABLE");
  return bindGuestCheckoutRuntime(storage, SANDBOX_GUEST_CHECKOUT_STORAGE, {
    runtimeSiteUrl: origin,
    host,
    coupons: services.coupons,
    paidOrders: paidOrders?.(ctx),
  });
}

/**
 * Call only from runtime-owned plugin routes/hooks. These checks reject
 * obvious misbinding; they do not attest that a context is installed.
 */
export function createInstalledCheckoutHandlers(
  resolveServices: InstalledCheckoutServiceResolver = async () => ({ host: {} }),
  paidOrders?: InstalledPaidOrders,
): InstalledCheckoutHandlers {
  async function guest(
    route: InstalledGuestCheckoutRequest,
    ctx: PluginContext,
    action: (runtime: ReturnType<typeof runtimeFor>) => Promise<GuestCheckoutResult>,
  ): Promise<GuestCheckoutResult> {
    try {
      installedStorage(ctx);
      admitGuestCheckoutWrite({
        requestUrl: route.request.url,
        headers: route.request.headers,
        siteOrigin: siteOrigin(ctx),
      });
      // Resolve against the original owner context, separately from browser input.
      const services = await resolveServices(ctx);
      return await action(runtimeFor(ctx, services, paidOrders));
    } catch (error) {
      return guestCheckoutFailure(error instanceof GuestCheckoutError ? error.code : "UNAVAILABLE");
    }
  }

  async function reconcileWakes(ctx: PluginContext): Promise<InstalledWakeResult> {
    try {
      installedStorage(ctx);
      siteOrigin(ctx);
      const services = await resolveServices(ctx);
      if (!services.wakes) return { executed: false, reason: "not-configured" };
      const results = await reconcileGuestPaymentWakes(runtimeFor(ctx, services, paidOrders), services.wakes);
      return { executed: true, results };
    } catch {
      return { executed: false, reason: "unavailable" };
    }
  }

  return {
    prepare: (route, ctx) => guest(route, ctx, runtime => prepareGuestCheckout(runtime, route.input)),
    start: (route, ctx) => guest(route, ctx, runtime => startGuestCheckout(runtime, route.input, route.request.headers)),
    status: (route, ctx) => guest(route, ctx, runtime => statusGuestCheckout(runtime, route.input, route.request.headers)),
    reconcileWakes,
    cron: async (event, ctx) => {
      if (event.name === COMMERCE_CHECKOUT_WAKES_TASK) await reconcileWakes(ctx);
    },
  };
}

export function createInstalledCheckoutWakeHook(
  resolveServices?: InstalledCheckoutServiceResolver,
  paidOrders?: InstalledPaidOrders,
): CronHandler {
  return createInstalledCheckoutHandlers(resolveServices, paidOrders).cron;
}
