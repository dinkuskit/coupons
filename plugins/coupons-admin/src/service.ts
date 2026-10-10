import type { PluginContext } from "emdash/plugin";

// The hosted coupon service this plugin manages. The manifest allows this
// host and no other, so the address is fixed rather than configurable.
export const SERVICE_ORIGIN = "https://coupons.dinkuskit.com";
export const PASS_SETTING = "couponsAdminPass";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// The service refuses a pass issued more than an hour ago.
const PASS_MAX_AGE_SECONDS = 3600;

export type Pass = { token: string; siteId: string };
export type PassProblem = "missing" | "unreadable" | "not-admin" | "expired";

export function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function claims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const binary = atob(parts[1]!.replaceAll("-", "+").replaceAll("_", "/"));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads the pass the store owner saved in settings. The coupon service checks
 * its signature on every call; this only names the store and explains, before
 * calling, a pass the service would refuse.
 */
export function readPass(value: unknown, nowMs = Date.now()): Pass | PassProblem {
  if (typeof value !== "string" || value.trim() === "") return "missing";
  const token = value.trim();
  const payload = token.length <= 16384 ? claims(token) : null;
  if (!payload || !safeId(payload.site_id) || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)) {
    return "unreadable";
  }
  if (typeof payload.scope !== "string" || !payload.scope.split(" ").includes("coupons:admin")) return "not-admin";
  const now = Math.floor(nowMs / 1000);
  if ((payload.exp as number) <= now || now - (payload.iat as number) > PASS_MAX_AGE_SECONDS) return "expired";
  return { token, siteId: payload.site_id };
}

/** The service could not be reached or gave no readable answer, so a change's outcome is unknown. */
export class Unreachable extends Error {}
/** The service refused the pass itself (401 or 403). */
export class PassRefused extends Error {}

export type Answer = { status: number; body: Record<string, unknown> };
export type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<Answer>;

export function errorCode(answer: Answer): string | null {
  const error = answer.body.error;
  return object(error) && typeof error.code === "string" ? error.code : null;
}

export function couponService(ctx: PluginContext, pass: Pass): Call {
  const base = `${SERVICE_ORIGIN}/v1/stores/${pass.siteId}`;
  return async (method, path, body) => {
    if (!ctx.http) throw new Unreachable("network access was not granted");
    let response: Response;
    try {
      response = await ctx.http.fetch(`${base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${pass.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Unreachable("the coupon service could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new PassRefused("the coupon service refused the pass");
    if (response.status < 200 || response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      throw new Unreachable(`the coupon service answered ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw new Unreachable("the coupon service answer was not JSON");
    }
    if (!object(parsed)) throw new Unreachable("the coupon service answer was not an object");
    return { status: response.status, body: parsed };
  };
}
