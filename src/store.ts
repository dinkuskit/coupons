import { DurableObject } from "cloudflare:workers";
import { COUPON_TABLES, createSqlCouponCollection } from "./collection.js";
import {
  CouponAdminError,
  CouponRedemptionError,
  createCheckoutCouponPort,
  createCouponAdmin,
  createCouponAttemptOwner,
  normalizeCouponCode,
  normalizeCouponRule,
  type CouponAttempt,
  type CouponCollection,
  type CouponRecord,
  type CouponRule,
} from "./core.js";
import { ok, ServiceError, toOutcome, type Outcome } from "./errors.js";
import { parsePricedLines, pricedLineStorage } from "./priced-lines.js";

/** How long an issued quote can still be reserved. */
export const QUOTE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long an admin preview's confirmation value can be committed. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
/** How long a committed admin command's result answers exact retries. */
export const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Ids that also fit a path segment, so a command can be looked up later. */
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** Commit refusals that are final for a command; anything else may be retried. */
const FINAL_ADMIN_REFUSALS = new Set(["INVALID_INPUT", "NOT_FOUND", "REVISION_CONFLICT", "CODE_IN_USE"]);

type Body = Record<string, unknown>;

/** What a preview froze: exactly the write its confirmation may commit. */
type AdminAction =
  | { action: "create"; coupon: { code: string; globalCap: number; disabled: boolean; rule: CouponRule } }
  | { action: "disable" | "enable"; couponId: string; expectedRevision: number }
  | { action: "edit"; couponId: string; expectedRevision: number; changes: { code?: string; globalCap?: number; rule?: CouponRule } };

/** Rule fields an edit may replace; each one replaces the current value whole. The rule id stays. */
const EDITABLE_RULE_FIELDS = ["discount", "appliesTo", "selectedProductIds", "includeSaleItems",
  "minimumEligibleMerchandise", "startsAt", "endsAt", "timeZone"] as const;

/** A coupon as an operator sees it. Redemption attempts stay out of every admin answer; counts cover them. */
function couponSummary(coupon: CouponRecord) {
  const { attempts: _attempts, ...summary } = coupon;
  return summary;
}

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
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_previews (
      confirmation TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      action TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      command_id TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_commands (
      command_id TEXT PRIMARY KEY,
      confirmation TEXT NOT NULL,
      request TEXT NOT NULL,
      status INTEGER NOT NULL,
      body TEXT NOT NULL,
      committed_at INTEGER NOT NULL
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
    return this.run(async () => ok({ coupons: (await this.admin().list()).map(couponSummary) }));
  }

  async createCoupon(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      await this.requireFreeCode(fields(body, ["code", "globalCap", "rule"], ["disabled"]).code);
      return ok({ coupon: couponSummary(await this.admin().create(body)) }, 201);
    });
  }

  async getCoupon(couponId: string): Promise<Outcome> {
    return this.run(async () => {
      const coupon = await this.admin().get(couponId);
      if (!coupon) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      return ok({ coupon: couponSummary(coupon) });
    });
  }

  async editCoupon(couponId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const { expectedRevision, ...changes } = fields(body, ["expectedRevision"], ["code", "globalCap", "disabled", "rule"]);
      await this.requireFreeCode(changes.code, couponId);
      return ok({ coupon: couponSummary(await this.admin().edit(couponId, expectedRevision as number, changes)) });
    });
  }

  async disableCoupon(couponId: string, body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const { expectedRevision } = fields(body, ["expectedRevision"]);
      return ok({ coupon: couponSummary(await this.admin().disable(couponId, expectedRevision as number)) });
    });
  }

  async couponCounts(couponId: string): Promise<Outcome> {
    return this.run(async () => {
      const counts = await this.owner().getCounts(couponId);
      if (!counts) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      return ok({ counts });
    });
  }

  // Admin preview and confirm (coupons:admin). An operator tool previews a
  // change, shows it, and commits only that frozen change with the preview's
  // confirmation value and its own command ID. Retrying the same command ID
  // returns the first result instead of writing twice.

  private async adminAction(body: unknown): Promise<{ action: AdminAction; before: unknown; after: unknown }> {
    const input = fields(body, ["action"], ["coupon", "couponId", "changes"]);
    if (input.action === "create") {
      const coupon = fields(fields(body, ["action", "coupon"]).coupon, ["code", "globalCap", "rule"], ["disabled"]);
      const rule = fields(coupon.rule, ["discount", "appliesTo", "minimumEligibleMerchandise", "endsAt", "timeZone"],
        ["ruleId", "selectedProductIds", "includeSaleItems", "startsAt"]);
      if (!Number.isSafeInteger(coupon.globalCap) || (coupon.globalCap as number) < 0) {
        throw new ServiceError(400, "INVALID_INPUT", "globalCap must be a safe integer >= 0");
      }
      if (coupon.disabled !== undefined && typeof coupon.disabled !== "boolean") {
        throw new ServiceError(400, "INVALID_INPUT", "disabled must be a boolean");
      }
      normalizeCouponCode(coupon.code);
      await this.requireFreeCode(coupon.code);
      // The preview fixes the rule id and, when the caller leaves it out, the
      // start time, so the commit writes exactly what was shown.
      const normalized = normalizeCouponRule({
        ...rule, ruleId: rule.ruleId ?? crypto.randomUUID(), startsAt: rule.startsAt ?? new Date().toISOString(),
      }, 1);
      const frozen = { code: text(coupon.code, "code", 100), globalCap: coupon.globalCap as number, disabled: coupon.disabled === true, rule: normalized };
      return { action: { action: "create", coupon: frozen }, before: null, after: { ...frozen, normalizedCode: normalizeCouponCode(frozen.code) } };
    }
    if (input.action === "disable" || input.action === "enable") {
      const couponId = text(fields(body, ["action", "couponId"]).couponId, "couponId");
      const current = await this.admin().get(couponId);
      if (!current) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      const disabled = input.action === "disable";
      if (current.disabled === disabled) {
        throw new ServiceError(409, "NO_CHANGE", `coupon is already ${disabled ? "disabled" : "enabled"}`);
      }
      const before = couponSummary(current);
      return { action: { action: input.action, couponId, expectedRevision: current.revision }, before, after: { ...before, disabled } };
    }
    if (input.action === "edit") {
      const edit = fields(body, ["action", "couponId", "changes"]);
      const couponId = text(edit.couponId, "couponId");
      const changes = fields(edit.changes, [], ["code", "globalCap", "rule"]);
      if (Object.keys(changes).length === 0) throw new ServiceError(400, "INVALID_INPUT", "changes must name code, globalCap or rule");
      if (changes.globalCap !== undefined && (!Number.isSafeInteger(changes.globalCap) || (changes.globalCap as number) < 0)) {
        throw new ServiceError(400, "INVALID_INPUT", "globalCap must be a safe integer >= 0");
      }
      const current = await this.admin().get(couponId);
      if (!current) throw new ServiceError(404, "NOT_FOUND", "coupon was not found");
      const frozen: { code?: string; globalCap?: number; rule?: CouponRule } = {};
      if (changes.code !== undefined) {
        normalizeCouponCode(changes.code);
        frozen.code = text(changes.code, "code", 100);
        await this.requireFreeCode(frozen.code, couponId);
      }
      if (changes.globalCap !== undefined) frozen.globalCap = changes.globalCap as number;
      if (changes.rule !== undefined) {
        // The preview fixes the whole next rule, so the commit writes exactly what was shown.
        const { version: _version, ...currentRule } = current.rule;
        frozen.rule = normalizeCouponRule({ ...currentRule, ...fields(changes.rule, [], EDITABLE_RULE_FIELDS) }, current.rule.version + 1);
      }
      const before = couponSummary(current);
      const after = {
        ...before,
        ...(frozen.code === undefined ? {} : { code: frozen.code, normalizedCode: normalizeCouponCode(frozen.code) }),
        ...(frozen.globalCap === undefined ? {} : { globalCap: frozen.globalCap }),
        ...(frozen.rule === undefined ? {} : { rule: frozen.rule }),
        revision: current.revision + 1,
      };
      const terms = (coupon: typeof before) => {
        const { version: _version, ...rule } = coupon.rule;
        return canonicalJson({ code: coupon.code, globalCap: coupon.globalCap, rule });
      };
      if (terms(after) === terms(before)) throw new ServiceError(409, "NO_CHANGE", "the edit changes nothing");
      return { action: { action: "edit", couponId, expectedRevision: current.revision, changes: frozen }, before, after };
    }
    throw new ServiceError(400, "INVALID_INPUT", "action must be create, edit, disable or enable");
  }

  private async applyAdminAction(action: AdminAction): Promise<CouponRecord> {
    if (action.action === "create") {
      await this.requireFreeCode(action.coupon.code);
      return this.admin().create(action.coupon);
    }
    if (action.action === "edit") {
      await this.requireFreeCode(action.changes.code, action.couponId);
      return this.admin().edit(action.couponId, action.expectedRevision, action.changes);
    }
    return this.admin().edit(action.couponId, action.expectedRevision, { disabled: action.action === "disable" });
  }

  async previewAdmin(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const { action, before, after } = await this.adminAction(body);
      const now = Date.now();
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM admin_previews WHERE expires_at < ?", now - QUOTE_RETENTION_MS);
      sql.exec("DELETE FROM admin_commands WHERE committed_at < ?", now - COMMAND_RETENTION_MS);
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const value = `cfm-${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
      const expiresAt = now + CONFIRMATION_TTL_MS;
      sql.exec(
        "INSERT INTO admin_previews (confirmation, request, action, expires_at) VALUES (?, ?, ?, ?)",
        value, canonicalJson(body), JSON.stringify(action), expiresAt,
      );
      return ok({
        preview: { action: action.action, couponId: action.action === "create" ? null : action.couponId, before, after },
        confirmation: { value, expiresAt: new Date(expiresAt).toISOString() },
      });
    });
  }

  async commitAdmin(body: unknown): Promise<Outcome> {
    return this.run(async () => {
      const input = fields(body, ["commandId", "confirmation", "request"]);
      const commandId = text(input.commandId, "commandId");
      if (!COMMAND_ID.test(commandId)) throw new ServiceError(400, "INVALID_INPUT", "commandId must use letters, digits, '.', '_', ':' or '-'");
      const confirmation = text(input.confirmation, "confirmation");
      const request = canonicalJson(input.request);
      const sql = this.ctx.storage.sql;
      const done = sql.exec<{ confirmation: string; request: string; status: number; body: string }>(
        "SELECT confirmation, request, status, body FROM admin_commands WHERE command_id = ?", commandId,
      ).toArray()[0];
      if (done) {
        if (done.confirmation !== confirmation || done.request !== request) {
          throw new ServiceError(409, "CONFLICTING_COMMAND", "this command ID was already used for a different change");
        }
        return ok(JSON.parse(done.body), done.status);
      }
      const preview = sql.exec<{ request: string; action: string; expires_at: number; command_id: string | null }>(
        "SELECT request, action, expires_at, command_id FROM admin_previews WHERE confirmation = ?", confirmation,
      ).toArray()[0];
      if (!preview) throw new ServiceError(409, "CONFIRMATION_NOT_FOUND", "no preview has this confirmation value");
      if (preview.command_id) throw new ServiceError(409, "CONFIRMATION_ALREADY_USED", "this confirmation was already committed by another command");
      if (preview.request !== request) throw new ServiceError(409, "CONFIRMATION_MISMATCH", "the change differs from the one this confirmation previewed");
      if (Date.now() > preview.expires_at) throw new ServiceError(409, "CONFIRMATION_EXPIRED", "the preview expired; preview the change again");
      let result: { status: number; body: unknown };
      try {
        const coupon = await this.applyAdminAction(JSON.parse(preview.action) as AdminAction);
        result = { status: 200, body: { outcome: "committed", commandId, coupon: couponSummary(coupon) } };
      } catch (error) {
        const refusal = toOutcome(error);
        // Storage trouble leaves the confirmation unused, so the same command can retry.
        if (refusal.ok || !FINAL_ADMIN_REFUSALS.has(refusal.code)) return refusal;
        result = { status: 409, body: { outcome: "rejected", commandId, rejection: { code: refusal.code, message: refusal.message } } };
      }
      sql.exec("UPDATE admin_previews SET command_id = ? WHERE confirmation = ?", commandId, confirmation);
      sql.exec(
        "INSERT INTO admin_commands (command_id, confirmation, request, status, body, committed_at) VALUES (?, ?, ?, ?, ?, ?)",
        commandId, confirmation, request, result.status, JSON.stringify(result.body), Date.now(),
      );
      return ok(result.body, result.status);
    });
  }

  async adminCommand(commandId: string): Promise<Outcome> {
    return this.run(async () => {
      const done = this.ctx.storage.sql.exec<{ status: number; body: string }>(
        "SELECT status, body FROM admin_commands WHERE command_id = ?", commandId,
      ).toArray()[0];
      if (!done) throw new ServiceError(404, "NOT_FOUND", "no command with this ID was committed");
      return ok(JSON.parse(done.body), done.status);
    });
  }
}
