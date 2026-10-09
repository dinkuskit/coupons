import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../../src/worker";

const audience = "dinkus-coupons";
const usd = (minor: string) => ({ currency: "USD", minor });
const hour = 60 * 60 * 1000;
let site: string;
let issuer: string;
let sign: (claims: { site?: string; scope?: string }) => Promise<string>;
const configured = () => ({ ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: `${issuer}/jwks` }) as unknown as Env;

beforeEach(async () => {
  site = `site-${crypto.randomUUID()}`;
  // A fresh issuer per test, since the Worker caches each issuer's keys.
  issuer = `https://accounts-${crypto.randomUUID()}.example.invalid`;
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic", alg: "ES256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (new URL(String(input)).href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  sign = ({ site: claimSite = site, scope = "coupons:checkout coupons:admin" }) => new SignJWT({ site_id: claimSite, scope })
    .setProtectedHeader({ alg: "ES256", kid: "synthetic" }).setIssuer(issuer).setAudience(audience)
    .setSubject("synthetic-store").setIssuedAt().setExpirationTime("5m").sign(privateKey);
});
afterEach(() => vi.restoreAllMocks());

async function call(method: string, path: string, body?: unknown, options: { token?: string | null; scope?: string } = {}) {
  const token = options.token === undefined ? await sign({ scope: options.scope }) : options.token;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await worker.fetch(new Request(`https://coupons.example.invalid/v1/stores/${site}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), configured());
  return { status: response.status, json: await response.json() as any };
}

const rule = (overrides: Record<string, unknown> = {}) => ({
  ruleId: `rule-${crypto.randomUUID()}`, discount: { kind: "percentage", basisPoints: 2500 },
  appliesTo: "all-merchandise", selectedProductIds: [], includeSaleItems: false,
  minimumEligibleMerchandise: usd("0"),
  startsAt: new Date(Date.now() - hour).toISOString(), endsAt: new Date(Date.now() + hour).toISOString(),
  timeZone: "UTC", ...overrides,
});

async function coupon(code: string, globalCap = 10, overrides: Record<string, unknown> = {}) {
  const created = await call("POST", "/coupons", { code, globalCap, rule: rule(overrides) }, { scope: "coupons:admin" });
  expect(created.status).toBe(201);
  return created.json.coupon;
}

const cart = [
  { productId: "tee", quantity: 2, regular: usd("2000") },
  { productId: "mug", quantity: 1, regular: usd("1500"), sale: usd("1000") },
];

test("the bare origin names the service and nothing else", async () => {
  const response = await worker.fetch(new Request("https://coupons.example.invalid/"), configured());
  expect(await response.text()).toBe("DinkusKit coupon service\n");
  const unknown = await worker.fetch(new Request("https://coupons.example.invalid/v1/test"), configured());
  expect(unknown.status).toBe(404);
  expect((await unknown.json() as any).error.code).toBe("NOT_FOUND");
});

test("every store route needs a token for that store and scope", async () => {
  expect((await call("GET", "/coupons", undefined, { token: null })).status).toBe(401);
  expect((await call("GET", "/coupons", undefined, { token: "not-a-jwt" })).status).toBe(401);
  expect((await call("GET", "/coupons", undefined, { token: await sign({ site: "another-store" }) })).status).toBe(403);
  expect((await call("GET", "/coupons", undefined, { scope: "coupons:checkout" })).status).toBe(403);
  expect((await call("POST", "/quotes", { quoteId: "q", code: "X", lines: cart }, { scope: "coupons:admin" })).status).toBe(403);
});

test("a missing or non-https identity configuration answers NOT_CONFIGURED", async () => {
  const request = () => new Request(`https://coupons.example.invalid/v1/stores/${site}/coupons`);
  for (const override of [{ ACCOUNT_ISSUER: "" }, { ACCOUNT_ISSUER: "http://accounts.example.invalid" }, { ACCOUNT_JWKS_URL: "not a url" }]) {
    const response = await worker.fetch(request(), { ...configured(), ...override } as Env);
    expect(response.status).toBe(503);
    expect((await response.json() as any).error.code).toBe("NOT_CONFIGURED");
  }
});

test("bodies over 64 KiB are refused, with or without a Content-Length", async () => {
  const headers = { authorization: `Bearer ${await sign({})}`, "content-type": "application/json" };
  const url = `https://coupons.example.invalid/v1/stores/${site}/quotes`;
  const oversized = JSON.stringify({ quoteId: "q", code: "X", lines: cart, padding: "x".repeat(64 * 1024) });
  const declared = await worker.fetch(new Request(url, { method: "POST", headers, body: oversized }), configured());
  expect(declared.status).toBe(413);
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  let sent = 0;
  const streamed = await worker.fetch(new Request(url, {
    method: "POST", headers,
    body: new ReadableStream({ pull(controller) { sent++ < 8 ? controller.enqueue(chunk) : controller.close(); } }),
  }), configured());
  expect(streamed.status).toBe(413);
  expect((await streamed.json() as any).error.code).toBe("BODY_TOO_LARGE");
  expect(sent).toBeLessThan(8); // reading stopped at the limit, not at the end
  const garbled = await worker.fetch(new Request(url, { method: "POST", headers, body: "{" }), configured());
  expect((await garbled.json() as any).error.code).toBe("INVALID_INPUT");
});

test("a quote uses Commerce's evaluator on Commerce's prices, and sale items stay excluded by default", async () => {
  const created = await coupon("SAVE25");
  const quoted = await call("POST", "/quotes", { quoteId: "quote-1", code: " save25 ", lines: cart });
  expect(quoted.status).toBe(200);
  expect(quoted.json.couponId).toBe(created.couponId);
  expect(quoted.json.quote.eligibleSubtotal).toEqual(usd("4000"));
  expect(quoted.json.quote.discount).toEqual(usd("1000"));
  expect(quoted.json.quote.payableMerchandiseTotal).toEqual(usd("4000"));
  expect(quoted.json.quote.lines[1]).toMatchObject({ productId: "mug", unitPrice: usd("1000"), eligible: false });
});

test("unknown, inactive and malformed requests get distinct answers", async () => {
  expect((await call("POST", "/quotes", { quoteId: "q", code: "NOPE", lines: cart })).status).toBe(404);
  await coupon("LATER", 10, { startsAt: new Date(Date.now() + hour).toISOString(), endsAt: new Date(Date.now() + 2 * hour).toISOString() });
  const inactive = await call("POST", "/quotes", { quoteId: "q", code: "LATER", lines: cart });
  expect(inactive.status).toBe(422);
  expect(inactive.json.error.code).toBe("NOT_APPLICABLE");
  const browserTotal = await call("POST", "/quotes", { quoteId: "q", code: "LATER", lines: cart, total: usd("1") });
  expect(browserTotal.status).toBe(400);
  const badSale = await call("POST", "/quotes", { quoteId: "q", code: "LATER", lines: [{ productId: "x", quantity: 1, regular: usd("100"), sale: usd("100") }] });
  expect(badSale.status).toBe(400);
});

test("a full paid checkout reserves, attaches the payment session and consumes one use", async () => {
  const { couponId } = await coupon("FLOW");
  const { json: { quote } } = await call("POST", "/quotes", { quoteId: "quote-flow", code: "FLOW", lines: cart });
  const total = usd(quote.payableMerchandiseTotal.minor);
  const reserved = await call("POST", "/redemptions", { couponId, attemptId: "attempt-1", quote, overallPayableTotal: total });
  expect(reserved.status).toBe(200);
  expect(reserved.json.attempt.state).toBe("pending");
  const retried = await call("POST", "/redemptions", { couponId, attemptId: "attempt-1", quote, overallPayableTotal: total });
  expect(retried.json.attempt).toEqual(reserved.json.attempt);
  expect((await call("POST", "/redemptions/attempt-1/provider-session", { couponId, providerSessionId: "cs_test_1" })).status).toBe(200);
  const consumed = await call("POST", "/redemptions/attempt-1/reconcile", { couponId, reconciliation: { kind: "verified-success", providerSessionId: "cs_test_1" } });
  expect(consumed.json.attempt.state).toBe("consumed");
  expect((await call("GET", `/redemptions/attempt-1?couponId=${couponId}`)).json.attempt.state).toBe("consumed");
  const counts = await call("GET", `/coupons/${couponId}/counts`, undefined, { scope: "coupons:admin" });
  expect(counts.json.counts).toMatchObject({ cap: 10, consumed: 1, pending: 0, remaining: 9 });
});

test("reserve accepts only an unchanged quote this service issued", async () => {
  const { couponId } = await coupon("TAMPER");
  const { json: { quote } } = await call("POST", "/quotes", { quoteId: "quote-t", code: "TAMPER", lines: cart });
  const edited = { ...quote, discount: usd("3999") };
  const tampered = await call("POST", "/redemptions", { couponId, attemptId: "a", quote: edited, overallPayableTotal: usd("1") });
  expect(tampered.status).toBe(409);
  expect(tampered.json.error.code).toBe("QUOTE_NOT_ISSUED");
  const reordered = Object.fromEntries(Object.entries(quote).reverse());
  expect((await call("POST", "/redemptions", { couponId, attemptId: "a", quote: reordered, overallPayableTotal: usd(quote.payableMerchandiseTotal.minor) })).status).toBe(200);
});

test("the global cap holds when checkouts race", async () => {
  const { couponId } = await coupon("RACE", 2);
  const quotes = await Promise.all([0, 1, 2, 3, 4].map(i => call("POST", "/quotes", { quoteId: `quote-${i}`, code: "RACE", lines: cart })));
  const results = await Promise.all(quotes.map(({ json: { quote } }, i) =>
    call("POST", "/redemptions", { couponId, attemptId: `attempt-${i}`, quote, overallPayableTotal: usd(quote.payableMerchandiseTotal.minor) })));
  expect(results.filter(r => r.status === 200)).toHaveLength(2);
  expect(results.filter(r => r.status === 409).every(r => r.json.error.code === "CAPACITY_EXHAUSTED")).toBe(true);
  const counts = await call("GET", `/coupons/${couponId}/counts`, undefined, { scope: "coupons:admin" });
  expect(counts.json.counts).toMatchObject({ cap: 2, pending: 2, remaining: 0 });
  const winner = results.findIndex(r => r.status === 200);
  const released = await call("POST", `/redemptions/attempt-${winner}/reconcile`, { couponId, reconciliation: { kind: "verified-not-created" } });
  expect(released.json.attempt.state).toBe("released");
  expect((await call("GET", `/coupons/${couponId}/counts`, undefined, { scope: "coupons:admin" })).json.counts.remaining).toBe(1);
});

test("admin keeps codes unique, edits by revision and disables", async () => {
  const created = await coupon("ONCE");
  expect((await call("POST", "/coupons", { code: " once ", globalCap: 1, rule: rule() }, { scope: "coupons:admin" })).json.error.code).toBe("CODE_IN_USE");
  const edited = await call("PUT", `/coupons/${created.couponId}`, { expectedRevision: 1, globalCap: 5 }, { scope: "coupons:admin" });
  expect(edited.json.coupon).toMatchObject({ revision: 2, globalCap: 5 });
  expect((await call("PUT", `/coupons/${created.couponId}`, { expectedRevision: 1, globalCap: 6 }, { scope: "coupons:admin" })).status).toBe(409);
  const disabled = await call("POST", `/coupons/${created.couponId}/disable`, { expectedRevision: 2 }, { scope: "coupons:admin" });
  expect(disabled.json.coupon.disabled).toBe(true);
  expect((await call("POST", "/quotes", { quoteId: "q", code: "ONCE", lines: cart })).json.error.code).toBe("NOT_APPLICABLE");
  const listed = await call("GET", "/coupons", undefined, { scope: "coupons:admin" });
  expect(listed.json.coupons.map((c: any) => c.code)).toEqual(["ONCE"]);
});
