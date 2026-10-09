import { createAuthenticator, type CouponScope } from "./auth.js";
import { ServiceError, toOutcome, type Outcome } from "./errors.js";
import type { StoreCoupons } from "./store.js";

export { StoreCoupons } from "./store.js";

export const SERVICE_LINE = "DinkusKit coupon service";
export const MAX_BODY_BYTES = 64 * 1024;

const SITE = "[A-Za-z0-9._:-]{1,200}";
const ID = "[A-Za-z0-9._:-]{1,200}";

type Handler = (store: DurableObjectStub<StoreCoupons>, ctx: { params: string[]; body: unknown; url: URL }) => Promise<Outcome>;
interface Route { method: string; pattern: RegExp; scope: CouponScope; handle: Handler }

const route = (method: string, path: string, scope: CouponScope, handle: Handler): Route => ({
  method, scope, handle, pattern: new RegExp(`^/v1/stores/(${SITE})${path.replaceAll(":id", `(${ID})`)}$`),
});

const ROUTES: Route[] = [
  route("POST", "/quotes", "coupons:checkout", (s, { body }) => s.quote(body)),
  route("POST", "/redemptions", "coupons:checkout", (s, { body }) => s.reserve(body)),
  route("POST", "/redemptions/:id/release-unstarted", "coupons:checkout", (s, { params, body }) => s.releaseUnstarted(params[0]!, body)),
  route("POST", "/redemptions/:id/provider-session", "coupons:checkout", (s, { params, body }) => s.attachProviderSession(params[0]!, body)),
  route("POST", "/redemptions/:id/reconcile", "coupons:checkout", (s, { params, body }) => s.reconcile(params[0]!, body)),
  route("POST", "/redemptions/:id/free-order", "coupons:checkout", (s, { params, body }) => s.reconcileFreeOrder(params[0]!, body)),
  route("GET", "/redemptions/:id", "coupons:checkout", (s, { params, url }) => s.getAttempt(params[0]!, url.searchParams.get("couponId"))),
  route("GET", "/coupons", "coupons:admin", s => s.listCoupons()),
  route("POST", "/coupons", "coupons:admin", (s, { body }) => s.createCoupon(body)),
  route("GET", "/coupons/:id", "coupons:admin", (s, { params }) => s.getCoupon(params[0]!)),
  route("PUT", "/coupons/:id", "coupons:admin", (s, { params, body }) => s.editCoupon(params[0]!, body)),
  route("POST", "/coupons/:id/disable", "coupons:admin", (s, { params, body }) => s.disableCoupon(params[0]!, body)),
  route("GET", "/coupons/:id/counts", "coupons:admin", (s, { params }) => s.couponCounts(params[0]!)),
];

const NO_STORE = { "cache-control": "no-store" };

function respond(outcome: Outcome): Response {
  return outcome.ok
    ? Response.json(outcome.body, { status: outcome.status, headers: NO_STORE })
    : Response.json({ error: { code: outcome.code, message: outcome.message } }, { status: outcome.status, headers: NO_STORE });
}

const tooLarge = () => new ServiceError(413, "BODY_TOO_LARGE", `request bodies are limited to ${MAX_BODY_BYTES} bytes`);

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET") return undefined;
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) throw tooLarge();
  // Stop reading at the limit, whatever Content-Length said (or if it is absent).
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    bytes.set(value, length);
    length += value.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
  } catch {
    throw new ServiceError(400, "INVALID_INPUT", "body must be UTF-8 JSON");
  }
}

// One authenticator per configuration, so the issuer's JWKS is fetched once
// per isolate and cached by jose rather than on every request.
let cached: { key: string; authenticate: ReturnType<typeof createAuthenticator> } | undefined;
function authenticator(env: Env) {
  const key = `${env.ACCOUNT_ISSUER}\n${env.ACCOUNT_AUDIENCE}\n${env.ACCOUNT_JWKS_URL}`;
  if (cached?.key !== key) {
    let authenticate;
    try {
      authenticate = createAuthenticator({ issuer: env.ACCOUNT_ISSUER, audience: env.ACCOUNT_AUDIENCE, jwksUrl: env.ACCOUNT_JWKS_URL });
    } catch {
      throw new ServiceError(503, "NOT_CONFIGURED", "the coupon service is not configured");
    }
    cached = { key, authenticate };
  }
  return cached.authenticate;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(`${SERVICE_LINE}\n`, { headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } });
  }
  try {
    const match = ROUTES.map(candidate => ({ candidate, found: candidate.pattern.exec(url.pathname) })).filter(item => item.found);
    if (match.length === 0) throw new ServiceError(404, "NOT_FOUND", "not found");
    const chosen = match.find(item => item.candidate.method === request.method);
    if (!chosen) throw new ServiceError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    if (!env.ACCOUNT_ISSUER || !env.ACCOUNT_AUDIENCE || !env.ACCOUNT_JWKS_URL) {
      throw new ServiceError(503, "NOT_CONFIGURED", "the coupon service is not configured");
    }
    const [, siteId, ...params] = chosen.found!;
    await authenticator(env)(request, siteId!, chosen.candidate.scope);
    const body = await readBody(request);
    const store = env.STORE_COUPONS.get(env.STORE_COUPONS.idFromName(siteId!));
    return respond(await chosen.candidate.handle(store, { params: params as string[], body, url }));
  } catch (error) {
    return respond(toOutcome(error));
  }
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
