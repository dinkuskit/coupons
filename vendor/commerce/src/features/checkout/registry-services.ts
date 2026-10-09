import type { PluginContext } from "emdash";
import { normalizeMoney } from "../catalog/kernel/index.js";
import { createTrustedTestPaymentsCheckoutHost, readBoundedPaymentsJson } from "./test-payments.js";
import type { CommercePaymentWake, CommercePaymentWakePort } from "./wake.js";
import type { TrustedShippingConfiguration } from "./types.js";
import { CHECKOUT_PRICING_SCHEMA } from "./types.js";
import { GuestCheckoutError } from "./errors.js";
import { resolveTrustedSiteOrigin } from "./site-scope.js";
import { INSTALLED_COMMERCE_PLUGIN_ID, COMMERCE_REGISTRY_RUNTIME_ID } from "./installed.js";
import type { InstalledCheckoutServices } from "./installed.js";

export const REGISTRY_CHECKOUT_SETTINGS_KEY = "installedCheckout";
export const REGISTRY_CHECKOUT_CREDENTIAL_KEY = "installedCheckoutCredential";
export const REGISTRY_CHECKOUT_CONFIG_SCHEMA = "dinkuskit.commerce.registry-checkout/v1" as const;

export interface RegistryCheckoutConfig {
  schema: typeof REGISTRY_CHECKOUT_CONFIG_SCHEMA;
  enabled: true;
  commerceOrigin: string;
  siteId: string;
  paymentsOrigin: string;
  bindingRef: string;
  providerId: "stripe";
  mode?: "test";
  stripeAccountId: string;
  pricingSchema: typeof CHECKOUT_PRICING_SCHEMA;
  issuer: string;
  audience: string;
  shipping: TrustedShippingConfiguration;
}

function unavailable(): never { throw new GuestCheckoutError("UNAVAILABLE"); }
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, limit = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value;
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(",") === expected;
}
function https(value: unknown, bare = true): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
      (!bare || url.pathname === "/");
  } catch { return false; }
}

function configFrom(value: unknown, site: string): RegistryCheckoutConfig | null {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > 16384) unavailable();
    try { value = JSON.parse(value); } catch { unavailable(); }
  }
  if (!object(value)) unavailable();
  // The explicit disabled snapshot carries no service authority.
  if (keys(value, "enabled,schema") && value.schema === REGISTRY_CHECKOUT_CONFIG_SCHEMA && value.enabled === false) return null;
  const enabledKeys =
    "audience,bindingRef,commerceOrigin,enabled,issuer,paymentsOrigin,pricingSchema,providerId,schema,shipping,siteId,stripeAccountId";
  const enabledKeysWithMode =
    "audience,bindingRef,commerceOrigin,enabled,issuer,mode,paymentsOrigin,pricingSchema,providerId,schema,shipping,siteId,stripeAccountId";
  const hasMode = keys(value, enabledKeysWithMode);
  if ((!hasMode && !keys(value, enabledKeys)) ||
      value.schema !== REGISTRY_CHECKOUT_CONFIG_SCHEMA || value.enabled !== true ||
      value.commerceOrigin !== site || !text(value.siteId) || !https(value.paymentsOrigin) ||
      !text(value.bindingRef) || value.providerId !== "stripe" ||
      (hasMode && value.mode !== "test") ||
      !text(value.stripeAccountId) ||
      value.pricingSchema !== CHECKOUT_PRICING_SCHEMA ||
      !https(value.issuer, false) || !text(value.audience) || !object(value.shipping)) unavailable();
  const shipping = value.shipping;
  const hasAmount = shipping.amount !== undefined;
  if (!keys(shipping, hasAmount ? "amount,configurationId,mode,revision" : "configurationId,mode,revision") ||
      !text(shipping.configurationId) || !Number.isSafeInteger(shipping.revision) ||
      (shipping.revision as number) < 1 || (shipping.mode !== "free" && shipping.mode !== "flat") ||
      (shipping.mode === "flat" && !hasAmount)) unavailable();
  if (hasAmount) {
    let amount;
    try { amount = normalizeMoney(shipping.amount); } catch { unavailable(); }
    if (amount.currency !== "USD" || (shipping.mode === "free" && amount.minor !== "0")) unavailable();
  }
  return structuredClone(value) as unknown as RegistryCheckoutConfig;
}

function jwtPart(encoded: string): unknown {
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
}

/** Admission filtering only. The Payments issuer/audience verifier owns authentication. */
function admitCredential(token: unknown, config: RegistryCheckoutConfig): string {
  if (!text(token, 16384)) unavailable();
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) unavailable();
    const header = jwtPart(parts[0]), payload = jwtPart(parts[1]);
    if (!object(header) || !["RS256", "ES256"].includes(header.alg as string) || !object(payload) ||
        payload.iss !== config.issuer ||
        !(payload.aud === config.audience || Array.isArray(payload.aud) && payload.aud.includes(config.audience)) ||
        !text(payload.sub) || payload.site_id !== config.siteId || typeof payload.scope !== "string" ||
        !payload.scope.split(" ").includes("payments:checkout") ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) unavailable();
    const now = Math.floor(Date.now() / 1000), issued = payload.iat as number, expires = payload.exp as number;
    if (issued < 0 || issued > now || expires <= now || expires <= issued || now - issued > 3600 ||
        payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || (payload.nbf as number) > now)) unavailable();
    return token;
  } catch { return unavailable(); }
}

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
  const config = configFrom(snapshot?.value ?? null, site.origin);
  if (!config || !ctx.http) return { host: {} };
  if (!snapshot || !text(snapshot.revision)) unavailable();
  const token = admitCredential(await ctx.settings.get(REGISTRY_CHECKOUT_CREDENTIAL_KEY), config);
  // A snapshot is invocation-local; recheck its expiry before every authenticated call.
  const credential = async () => admitCredential(token, config);
  const fetch = ctx.http.fetch.bind(ctx.http);
  const host = createTrustedTestPaymentsCheckoutHost({
    paymentsOrigin: config.paymentsOrigin, siteId: config.siteId, commerceOrigin: site.origin,
    bindingRef: config.bindingRef, providerId: config.providerId, stripeAccountId: config.stripeAccountId,
    credentialResolver: credential, fetch, pricingSchema: CHECKOUT_PRICING_SCHEMA,
  });
  return {
    host: { ...host, pricing: { paymentPricingSchema: CHECKOUT_PRICING_SCHEMA,
      resolveShippingConfiguration: async () => structuredClone(config.shipping) } },
    wakes: wakePort(config, fetch, credential),
  };
}
