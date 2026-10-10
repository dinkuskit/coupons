import { isRecord as object } from "../../shared/record.js";
import type { PluginContext } from "emdash";
import { createTrustedTestPaymentsCheckoutHost, readBoundedPaymentsJson } from "./test-payments.js";
import type { CommercePaymentWake, CommercePaymentWakePort } from "./wake.js";
import { CHECKOUT_PRICING_SCHEMA } from "./types.js";
import { registryUnavailable as unavailable, registryText as text, exactKeys as keys } from "./registry-guards.js";
import { resolveTrustedSiteOrigin } from "./site-scope.js";
import { INSTALLED_COMMERCE_PLUGIN_ID, COMMERCE_REGISTRY_RUNTIME_ID } from "./installed.js";
import type { InstalledCheckoutServices } from "./installed.js";
import {
  REGISTRY_CHECKOUT_CONFIG_SCHEMA,
  admitRegistryCheckoutConfig,
  trustedPaymentsHostConfig,
  type RegistryCheckoutConfig,
} from "./registry-provider-admission.js";
import { admitCredential } from "./registry-credential.js";
import { createHostedCouponPort } from "./registry-coupons.js";
import { validateCouponQuoteSnapshot } from "../coupons/index.js";

export { REGISTRY_CHECKOUT_CONFIG_SCHEMA };
export type { RegistryCheckoutConfig };
export const REGISTRY_CHECKOUT_SETTINGS_KEY = "installedCheckout";
export const REGISTRY_CHECKOUT_CREDENTIAL_KEY = "installedCheckoutCredential";
export const REGISTRY_CHECKOUT_COUPONS_CREDENTIAL_KEY = "installedCheckoutCouponsCredential";



function isWake(value: unknown, bindingRef: string): value is CommercePaymentWake {
  return object(value) && keys(value, "attemptId,bindingRef,deliveryGeneration,eventId,wokeAt") &&
    text(value.eventId) && /^evt_[A-Za-z0-9]+$/.test(value.eventId) && text(value.attemptId) &&
    value.bindingRef === bindingRef && Number.isSafeInteger(value.deliveryGeneration) &&
    (value.deliveryGeneration as number) > 0 && typeof value.wokeAt === "number" &&
    Number.isFinite(value.wokeAt) && value.wokeAt >= 0;
}

function wakePort(
  config: RegistryCheckoutConfig,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  credential: () => Promise<string>,
): CommercePaymentWakePort {
  async function call(path: string, body?: CommercePaymentWake): Promise<unknown> {
    const token = await credential();
    const response = await fetch(`${new URL(config.paymentsOrigin).origin}${path}`, {
      method: body ? "POST" : "GET", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${token}`,
        "x-dinkus-site": config.siteId, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("Payments wake transport unavailable");
    return readBoundedPaymentsJson(response);
  }
  return {
    async list() {
      const values = await call(`/v1/checkout/wakes?bindingRef=${encodeURIComponent(config.bindingRef)}&limit=100`);
      if (!Array.isArray(values) || values.length > 100 || !values.every(value => isWake(value, config.bindingRef))) unavailable();
      return values;
    },
    async acknowledge(event) {
      if (!isWake(event, config.bindingRef)) unavailable();
      const result = await call("/v1/checkout/wakes/ack", structuredClone(event));
      if (!object(result) || !keys(result, "acknowledged") || typeof result.acknowledged !== "boolean") unavailable();
      return result.acknowledged;
    },
  };
}

export async function resolveRegistryCheckoutServices(ctx: PluginContext): Promise<InstalledCheckoutServices> {
  if (!object(ctx.plugin) ||
      (ctx.plugin.id !== INSTALLED_COMMERCE_PLUGIN_ID && ctx.plugin.id !== COMMERCE_REGISTRY_RUNTIME_ID)) unavailable();
  const site = resolveTrustedSiteOrigin({ runtimeSiteUrl: ctx.site?.url });
  if (!site.ok) unavailable();
  // Keep the existing unconfigured prepare/capability behavior; start still has no Payments port.
  if (!ctx.settings) return { host: {} };
  const snapshot = await ctx.settings.getVersioned(REGISTRY_CHECKOUT_SETTINGS_KEY);
  const config = admitRegistryCheckoutConfig(snapshot?.value ?? null, site.origin);
  if (!config || !ctx.http) return { host: {} };
  if (!snapshot || !text(snapshot.revision)) unavailable();
  const token = admitCredential(await ctx.settings.get(REGISTRY_CHECKOUT_CREDENTIAL_KEY), config);
  // A snapshot is invocation-local; recheck its expiry before every authenticated call.
  const credential = async () => admitCredential(token, config);
  const fetch = ctx.http.fetch.bind(ctx.http);
  const coupons = config.coupons;
  const host = createTrustedTestPaymentsCheckoutHost({
    ...trustedPaymentsHostConfig(config, site.origin),
    credentialResolver: credential, fetch,
    ...(coupons ? { validateCouponQuoteSnapshot } : {}),
  });
  const settings = ctx.settings;
  return {
    host: { ...host, pricing: { paymentPricingSchema: CHECKOUT_PRICING_SCHEMA,
      resolveShippingConfiguration: async () => structuredClone(config.shipping) } },
    wakes: wakePort(config, fetch, credential),
    // The coupon pass is read only when a checkout uses a coupon, so a
    // missing or stale one never blocks checkout without a coupon.
    ...(coupons ? { coupons: createHostedCouponPort({
      origin: coupons.origin, siteId: config.siteId, fetch,
      credential: async () => admitCredential(await settings.get(REGISTRY_CHECKOUT_COUPONS_CREDENTIAL_KEY), config,
        "coupons:checkout", coupons.audience),
    }) } : {}),
  };
}
