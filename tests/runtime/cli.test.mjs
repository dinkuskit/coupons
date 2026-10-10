// dinkus-coupons commands against the real Worker and Durable Object, in the
// Workers runtime. workerd has no node:util parseArgs, so these tests build the
// command context the kernel would build from argv; tests/cli covers parsing
// and output. Everything else is the CLI's own client, commands and pending
// store, with only fetch pointed at the Worker instead of the network.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../../src/worker";
import { CliError } from "../../cli/kernel.mjs";
import { commandsResolve, commandsShow, couponsCreate, couponsDisable, couponsList, couponsShow } from "../../cli/commands.mjs";

const audience = "dinkus-coupons";
const endpoint = "https://coupons.example.invalid";
const usd = (minor) => ({ currency: "USD", minor });
let site;
let issuer;
let sign;
const configured = () => ({ ...env, ACCOUNT_ISSUER: issuer, ACCOUNT_AUDIENCE: audience, ACCOUNT_JWKS_URL: `${issuer}/jwks` });

beforeEach(async () => {
  site = `store-${crypto.randomUUID()}`;
  issuer = `https://accounts-${crypto.randomUUID()}.example.invalid`;
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic", alg: "ES256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (new URL(String(input)).href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  sign = scope => new SignJWT({ site_id: site, scope })
    .setProtectedHeader({ alg: "ES256", kid: "synthetic" }).setIssuer(issuer).setAudience(audience)
    .setSubject("synthetic-merchant").setIssuedAt().setExpirationTime("5m").sign(privateKey);
});
afterEach(() => vi.restoreAllMocks());

const toWorker = (url, init) => worker.fetch(new Request(url, init), configured());

// The context runCli hands a command after parsing `--endpoint ... --site ... <flags>`.
async function context({ args = {}, flags = {}, fetchImpl = toWorker } = {}) {
  const all = { endpoint, site, "no-input": true, ...flags };
  return {
    args,
    flags: all,
    env: { DINKUS_COUPONS_TOKEN: await sign("coupons:admin"), XDG_STATE_HOME: `/tmp/state-${site}` },
    config: { resolve: key => all[key], source: key => (all[key] === undefined ? undefined : "flag") },
    timeoutMs: 15_000,
    fetchImpl,
    io: { stdout: { write() {} }, stderr: { write() {} } },
    lifecycle: { sending: false },
    prompt: async () => { throw new Error("no prompts in this test"); },
  };
}

async function quote(code) {
  const response = await toWorker(`${endpoint}/v1/stores/${site}/quotes`, {
    method: "POST",
    headers: { authorization: `Bearer ${await sign("coupons:checkout")}`, "content-type": "application/json" },
    body: JSON.stringify({ quoteId: `q-${crypto.randomUUID()}`, code, lines: [{ productId: "tee", quantity: 2, regular: usd("2000") }] }),
  });
  return { status: response.status, json: await response.json() };
}

const fall10 = () => ({ code: "fall10", percent: "10", "max-discount": "3", cap: "2", ends: new Date(Date.now() + 86_400_000).toISOString() });

test("a merchant creates a coupon checkout can redeem, then turns it off", async () => {
  const flags = fall10();
  const preview = await couponsCreate(await context({ flags: { ...flags, "dry-run": true } }));
  expect(preview).toMatchObject({ outcome: "preview", context: { siteId: site, endpoint }, data: { after: { code: "fall10", normalizedCode: "FALL10", globalCap: 2 } } });
  expect((await couponsList(await context())).data.coupons).toEqual([]);

  const created = await couponsCreate(await context({ flags: { ...flags, confirm: preview.confirmation.value } }));
  expect(created).toMatchObject({ outcome: "committed", commandId: expect.stringMatching(/^cmd-[0-9a-f]{32}$/), data: { code: "fall10", revision: 1 } });
  const couponId = created.data.couponId;

  // Checkout sees the new coupon: 10% of 40.00, capped at 3.00.
  const quoted = await quote("FALL10");
  expect(quoted.status).toBe(200);
  expect(quoted.json.quote.discount).toEqual(usd("300"));
  expect((await couponsShow(await context({ args: { "coupon-id": couponId } }))).data.counts).toMatchObject({ cap: 2, remaining: 2 });

  const off = await couponsDisable(await context({ args: { "coupon-id": couponId }, flags: { "dry-run": true } }));
  expect(off.data).toMatchObject({ action: "disable", before: { disabled: false }, after: { disabled: true } });
  const disabled = await couponsDisable(await context({ args: { "coupon-id": couponId }, flags: { confirm: off.confirmation.value } }));
  expect(disabled).toMatchObject({ outcome: "committed", data: { disabled: true, revision: 2 } });
  expect((await quote("FALL10")).json.error.code).toBe("NOT_APPLICABLE");

  // A confirmation value is good for one change only.
  await expect(couponsDisable(await context({ args: { "coupon-id": couponId }, flags: { confirm: off.confirmation.value } })))
    .rejects.toMatchObject({ code: "CONFIRMATION_ALREADY_USED", exit: 4 });
});

test("a change whose answer is lost is recovered without making it twice", async () => {
  const flags = fall10();
  const preview = await couponsCreate(await context({ flags: { ...flags, "dry-run": true } }));
  const lost = await couponsCreate(await context({
    flags: { ...flags, confirm: preview.confirmation.value },
    async fetchImpl(url, init) {
      const response = await toWorker(url, init);
      if (new URL(url).pathname.endsWith("/coupons/commands")) throw new TypeError("connection reset");
      return response;
    },
  }));
  expect(lost).toMatchObject({ outcome: "unknown", exit: 3, commandId: expect.stringMatching(/^cmd-/) });
  const { commandId } = lost;

  const shown = await commandsShow(await context({ args: { "command-id": commandId } }));
  expect(shown.data).toMatchObject({ local: { state: "pending" }, service: { outcome: "committed" } });
  const resolved = await commandsResolve(await context({ args: { "command-id": commandId } }));
  expect(resolved).toMatchObject({ outcome: "committed", commandId, data: { code: "fall10", revision: 1 } });
  expect((await couponsList(await context())).data.coupons).toHaveLength(1);
  expect((await commandsResolve(await context({ args: { "command-id": commandId } }))).data.state).toBe("closed");
  await expect(commandsResolve(await context({ args: { "command-id": "cmd-0000000000000000" } }))).rejects.toBeInstanceOf(CliError);
});
