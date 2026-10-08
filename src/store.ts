import { DurableObject } from "cloudflare:workers";
import { COUPON_TABLES, createSqlCouponCollection } from "./collection.js";
import {
  CouponAdminError,
  CouponRedemptionError,
  createCheckoutCouponPort,
  createCouponAdmin,
  createCouponAttemptOwner,
  type CouponAttempt,
  type CouponCollection,
} from "./core.js";
import { ok, ServiceError, toOutcome, type Outcome } from "./errors.js";
import { parsePricedLines, pricedLineStorage } from "./priced-lines.js";

/** How long an issued quote can still be reserved. */
export const QUOTE_RETENTION_MS = 24 * 60 * 60 * 1000;

type Body = Record<string, unknown>;

function fields(body: unknown, required: readonly string[], optional: readonly string[] = []): Body {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError(400, "INVALID_INPUT", "body must be a JSON object");
  }
  const record = body as Body;
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(record).filter(key => !allowed.has(key));
  if (extra.length) throw new ServiceError(400, "INVALID_INPUT", `unexpected fields: ${extra.join(", ")}`);
  const missing = required.filter(key => record[key] === undefined);
  if (missing.length) throw new ServiceError(400, "INVALID_INPUT", `missing fields: ${missing.join(", ")}`);
  return record;
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ServiceError(400, "INVALID_INPUT", `${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

/** Key-order independent JSON, so a quote that round-trips through Commerce still compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Body)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * One store's coupons. Every coupon record and redemption attempt for a store
 * lives in this object's SQLite database, and the object handles one request
 * at a time, so global redemption caps hold under concurrent checkouts.
 */
export class StoreCoupons extends DurableObject<Env> {
  private readonly collection: CouponCollection;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    for (const statement of COUPON_TABLES) sql.exec(statement);
    sql.exec(`CREATE TABLE IF NOT EXISTS issued_quotes (
      quote_id TEXT PRIMARY KEY,
      coupon_id TEXT NOT NULL,
      value TEXT NOT NULL,
      issued_at INTEGER NOT NULL
    )`);
    this.collection = createSqlCouponCollection(sql);
  }

  private async run(fn: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await fn();
    } catch (error) {
      return toOutcome(error);
    }
  }

  private owner() {
    return createCouponAttemptOwner(this.collection);
  }

  private admin() {
    return createCouponAdmin(this.collection);
  }

  private async existingAttempt(couponId: string, attemptId: string): Promise<CouponAttempt | null> {
    try {
      return await this.owner().get(couponId, attemptId);
    } catch (error) {
      if (error instanceof CouponRedemptionError && error.code === "UNKNOWN_ATTEMPT") return null;
      throw error;
    }
  }

  /**
   * A new attempt may only freeze a quote this store issued, unchanged. Retries
   * for an attempt that already exists are left to the core's own frozen
   * identity checks.
   */
  private async requireIssuedQuote(couponId: string, attemptId: string, quote: unknown): Promise<void> {
    if (await this.existingAttempt(couponId, attemptId)) return;
    const quoteId = typeof quote === "object" && quote !== null ? (quote as Body).quoteId : undefined;
    const row = typeof quoteId === "string"
      ? this.ctx.storage.sql.exec<{ coupon_id: string; value: string; issued_at: number }>(
        "SELECT coupon_id, value, issued_at FROM issued_quotes WHERE quote_id = ?", quoteId,
      ).toArray()[0]
      : undefined;
    if (!row || row.coupon_id !== couponId || row.value !== canonicalJson(quote) || Date.now() - row.issued_at > QUOTE_RETENTION_MS) {
      throw new ServiceError(409, "QUOTE_NOT_ISSUED", "quote was not issued by this service for this coupon, or has changed or expired");
    }
  }

  // Checkout (coupons:checkout)

  async quote(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["quoteId", "code", "lines"]);
      const quoteId = text(input.quoteId, "quoteId");
      const code = text(input.code, "code", 100);
      const lines = parsePricedLines(input.lines);
      let result;
      try {
        result = await createCheckoutCouponPort(this.collection).quote(code, pricedLineStorage(lines), {
          quoteId,
          lines: lines.map(line => ({ productId: line.productId, quantity: line.quantity })),
          now: new Date().toISOString(),
        });
      } catch (error) {
        // Input was validated above, so what the evaluator still rejects is
        // the coupon not applying to this cart (inactive, disabled, minimum).
        if (error instanceof CouponAdminError && error.code === "INVALID_INPUT") {
          throw new ServiceError(422, "NOT_APPLICABLE", error.message);
        }
        throw error;
      }
      if (!result) throw new ServiceError(404, "NOT_FOUND", "no coupon has this code");
      const now = Date.now();
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM issued_quotes WHERE issued_at < ?", now - QUOTE_RETENTION_MS);
      sql.exec(
        `INSERT INTO issued_quotes (quote_id, coupon_id, value, issued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(quote_id) DO UPDATE SET coupon_id = excluded.coupon_id, value = excluded.value, issued_at = excluded.issued_at`,
        quoteId, result.couponId, canonicalJson(result.quote), now,
      );
      return ok({ couponId: result.couponId, quote: result.quote });
    });
  }

  async reserve(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["couponId", "attemptId", "quote", "overallPayableTotal"]);
      const couponId = text(input.couponId, "couponId");
      const attemptId = text(input.attemptId, "attemptId");
      await this.requireIssuedQuote(couponId, attemptId, input.quote);
      const attempt = await this.owner().reserve({
        couponId, attemptId,
        quote: input.quote as never,
        overallPayableTotal: input.overallPayableTotal as never,
        now: new Date().toISOString(),
      });
      return ok({ attempt });
    });
  }

  async releaseUnstarted(attemptId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["couponId", "quote", "overallPayableTotal"]);
      const couponId = text(input.couponId, "couponId");
      await this.requireIssuedQuote(couponId, attemptId, input.quote);
      const attempt = await this.owner().releaseUnstarted({
        couponId, attemptId, quote: input.quote as never, overallPayableTotal: input.overallPayableTotal as never,
      });
      return ok({ attempt });
    });
  }

  async attachProviderSession(attemptId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["couponId", "providerSessionId"]);
      const attempt = await this.owner().attachProviderSession(
        text(input.couponId, "couponId"), attemptId, text(input.providerSessionId, "providerSessionId"),
      );
      return ok({ attempt });
    });
  }

  async reconcile(attemptId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["couponId", "reconciliation"]);
      const attempt = await this.owner().reconcile(text(input.couponId, "couponId"), attemptId, input.reconciliation as never);
      return ok({ attempt });
    });
  }

  async reconcileFreeOrder(attemptId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["couponId", "proof"]);
      const attempt = await this.owner().reconcileFreeOrder({
        couponId: text(input.couponId, "couponId"), attemptId, proof: input.proof as never,
      });
      return ok({ attempt });
    });
  }

  async getAttempt(attemptId: string, couponId: string | null): Promise<Outcome> {
    return this.run(async () => {
      const attempt = await this.existingAttempt(text(couponId, "couponId"), attemptId);
      if (!attempt) throw new ServiceError(404, "NOT_FOUND", "coupon attempt was not found");
      return ok({ attempt });
    });
  }

  // Admin (coupons:admin)

  private async requireFreeCode(code: unknown, couponId?: string): Promise<void> {
    if (typeof code !== "string" || code.trim() === "") return;
    const existing = await this.admin().findByCode(code);
    if (existing && existing.couponId !== couponId) {
      throw new ServiceError(409, "CODE_IN_USE", "another coupon already uses this code");
    }
  }

  async listCoupons(): Promise<Outcome> {
    return this.run(async () => ok({ coupons: await this.admin().list() }));
  }

  async createCoupon(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      await this.requireFreeCode(fields(body, ["code", "globalCap", "rule"], ["disabled"]).code);
      return ok({ coupon: await this.admin().create(body) }, 201);
    });
  }

  async getCoupon(couponId: string): Promise<Outcome> {
    return this.run(async () => {
      const coupon = await this.admin().get(couponId);
      if (!coupon) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      return ok({ coupon });
    });
  }

  async editCoupon(couponId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const { expectedRevision, ...changes } = fields(body, ["expectedRevision"], ["code", "globalCap", "disabled", "rule"]);
      await this.requireFreeCode(changes.code, couponId);
      return ok({ coupon: await this.admin().edit(couponId, expectedRevision as number, changes) });
    });
  }

  async disableCoupon(couponId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const { expectedRevision } = fields(body, ["expectedRevision"]);
      return ok({ coupon: await this.admin().disable(couponId, expectedRevision as number) });
    });
  }

  async couponCounts(couponId: string): Promise<Outcome> {
    return this.run(async () => {
      const counts = await this.owner().getCounts(couponId);
      if (!counts) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      return ok({ counts });
    });
  }
}
