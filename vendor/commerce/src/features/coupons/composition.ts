import { recordObject } from "./record-object.js";
import { normalizeCouponInstant, deepFreeze } from "./admin.js";
import {
  CouponRedemptionError,
  type CouponAttempt,
  type CouponCollection,
  type CouponFreeOrderProof,
  type CouponProviderReconciliation,
  type CouponQuote,
  type CouponQuoteSnapshot,
  type CouponRecord,
} from "./types.js";
import { CouponRecordValidationError, validateCouponRecord, validateCouponQuoteSnapshot } from "./validation.js";
import { normalizeMoney, parseMinorUnits } from "../catalog/kernel/index.js";

const MAX_RETRIES = 32;
function detached<T>(value: T): T { return deepFreeze(structuredClone(value)); }
const fail = (message: string): never => { throw new CouponRedemptionError("INVALID_INPUT", message); };
function conflictingAttempt(): never {
  throw new CouponRedemptionError("CONFLICTING_ATTEMPT", "checkout attempt identity is frozen");
}
function terminalConflict(message: string): never {
  throw new CouponRedemptionError("TERMINAL_CONFLICT", message);
}

const required = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be non-empty`);
  return (value as string).trim();
};

function attemptIdentity(couponId: unknown, attemptId: unknown): [string, string] {
  return [required(couponId, "couponId"), required(attemptId, "attemptId")];
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

function sameQuote(a: CouponQuoteSnapshot, b: CouponQuoteSnapshot): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function snapshot(quote: CouponQuote, overall: unknown): CouponQuoteSnapshot {
  let total;
  try { total = normalizeMoney(overall, "overallPayableTotal"); }
  catch (error) { fail(error instanceof Error ? error.message : "overallPayableTotal is invalid"); }

  let sumLines = 0n;
  if (Array.isArray(quote.lines)) {
    for (const l of quote.lines) {
      if (l && l.lineSubtotal && typeof l.lineSubtotal.minor === "string") {
        sumLines += BigInt(l.lineSubtotal.minor);
      }
    }
  }

  const merchandiseTotal = {
    currency: "USD" as const,
    minor: sumLines.toString(),
  };

  const copy = structuredClone({
    ...quote,
    merchandiseTotal,
    overallPayableTotal: total,
    lines: quote.lines.map((line) => ({
      ...line,
      unitPrice: { ...line.unitPrice },
      lineSubtotal: { ...line.lineSubtotal },
      discount: { ...line.discount },
    })),
  });

  try {
    validateCouponQuoteSnapshot(copy, "quote");
  } catch (error) {
    if (error instanceof CouponRedemptionError) throw error;
    fail(error instanceof Error ? error.message : "quote snapshot is invalid");
  }

  return deepFreeze(copy) as CouponQuoteSnapshot;
}

function validateReconciliation(value: unknown): asserts value is CouponProviderReconciliation {
  if (!recordObject(value)) fail("reconciliation must be a non-null object");
  const record = value as Record<string, unknown>;
  const allowed = ["kind", "providerSessionId"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) fail("reconciliation has unsupported fields");
  if (!["verified-success", "confirmed-failure", "confirmed-cancel", "verified-not-created", "unknown"].includes(record.kind as string)) fail("unsupported reconciliation kind");
  if (record.providerSessionId !== undefined) required(record.providerSessionId, "providerSessionId");
  if (record.kind === "verified-success" && record.providerSessionId === undefined) fail("verified-success requires providerSessionId");
  if (record.kind === "verified-not-created" && record.providerSessionId !== undefined) fail("verified-not-created cannot specify providerSessionId");
}

function storedRecord(value: unknown, id: string): CouponRecord {
  try { return validateCouponRecord(value, id); }
  catch (error) {
    throw new CouponRedemptionError("CORRUPTED_RECORD", error instanceof Error ? error.message : "stored coupon is invalid");
  }
}

export interface CouponAttemptPort {
  /** Trusted Commerce durable pre-payment phase fence; prevents a late reserve from acquiring a slot. */
  releaseUnstarted(input: {
    couponId: string;
    attemptId: string;
    quote: CouponQuote;
    overallPayableTotal: { currency: "USD"; minor: string };
  }): Promise<CouponAttempt>;
  reserve(input: {
    couponId: string;
    attemptId: string;
    quote: CouponQuote;
    overallPayableTotal: { currency: "USD"; minor: string };
    now: string;
  }): Promise<CouponAttempt>;
  attachProviderSession(couponId: string, attemptId: string, providerSessionId: string): Promise<CouponAttempt>;
  reconcile(couponId: string, attemptId: string, reconciliation: CouponProviderReconciliation): Promise<CouponAttempt>;
  reconcileFreeOrder(input: { couponId: string; attemptId: string; proof: CouponFreeOrderProof }): Promise<CouponAttempt>;
  get(couponId: string, attemptId: string): Promise<CouponAttempt | null>;
  getCounts(couponId: string): Promise<{ couponId: string; cap: number; capacity: number; pending: number; consumed: number; released: number; remaining: number } | null>;
}

function countState(record: CouponRecord, state: CouponAttempt["state"]): number {
  return record.attempts.filter(item => item.state === state).length;
}

function newAttempt(attemptId: string, couponId: string, quote: CouponQuoteSnapshot, state: "pending" | "released"): CouponAttempt {
  return { attemptId, couponId, ruleId: quote.ruleId, ruleVersion: quote.ruleVersion, quoteId: quote.quoteId, quote, state };
}

function replaceAttempt(record: CouponRecord, attemptId: string, next: CouponAttempt): CouponRecord {
  return { ...record, attempts: record.attempts.map(item => item.attemptId === attemptId ? next : item) };
}

export function createCouponAttemptOwner(collection: CouponCollection): CouponAttemptPort {
  async function read(id: string) {
    const stored = await collection.getVersioned(id);
    if (!stored) throw new CouponRedemptionError("UNKNOWN_ATTEMPT", "coupon was not found");
    return { stored, record: storedRecord(stored.value, id) };
  }

  async function update(id: string, fn: (record: CouponRecord) => CouponRecord, contention = "coupon CAS contention did not settle"): Promise<CouponRecord> {
    for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
      const { stored, record } = await read(id);
      const next = fn(record);
      if (next === record) {
        return detached(record);
      }
      if ((await collection.compareAndSet(id, stored.revision, next)).applied) {
        return detached(next);
      }
    }
    throw new CouponRedemptionError("CONTENTION", contention);
  }

  const find = (record: CouponRecord, attemptId: string): CouponAttempt => {
    const item = record.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!item) throw new CouponRedemptionError("UNKNOWN_ATTEMPT", "coupon attempt was not found");
    return item;
  };

  return {
    async releaseUnstarted({ couponId, attemptId, quote, overallPayableTotal }) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      const frozen = snapshot(quote, overallPayableTotal);
      if (frozen.couponId !== id) fail("coupon identity mismatch");
      const record = await update(id, (current) => {
        const existing = current.attempts.find(item => item.attemptId === aid);
        if (existing && !sameQuote(existing.quote, frozen)) {
          conflictingAttempt();
        }
        if (existing?.providerSessionId || existing?.freeOrder || existing?.state === "consumed") {
          terminalConflict("payment-bound attempt is not unstarted");
        }
        if (existing?.state === "released") return current;
        const released: CouponAttempt = existing ? { ...existing, state: "released" } : newAttempt(aid, id, frozen, "released");
        return { ...current, attempts: existing
          ? current.attempts.map(item => item.attemptId === aid ? released : item)
          : [...current.attempts, released] };
      });
      return detached(find(record, aid));
    },
    async reserve({ couponId, attemptId, quote, overallPayableTotal, now }) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      const frozen = snapshot(quote, overallPayableTotal);
      const record = await update(id, (record) => {
        const existing = record.attempts.find((item) => item.attemptId === aid);
        if (existing) {
          if (existing.quoteId !== frozen.quoteId || existing.ruleId !== frozen.ruleId ||
              existing.ruleVersion !== frozen.ruleVersion || !sameQuote(existing.quote, frozen)) {
            conflictingAttempt();
          }
          return record;
        }
        if (frozen.couponId !== id || frozen.ruleId !== record.rule.ruleId || frozen.ruleVersion !== record.rule.version) {
          throw new CouponRedemptionError("CONFLICTING_ATTEMPT", "quote is fenced to the current coupon rule");
        }
        const instant = normalizeCouponInstant(now, "now");
        if (record.disabled || instant < record.rule.startsAt || instant >= record.rule.endsAt) {
          fail("coupon is disabled or not active");
        }
        if (parseMinorUnits(frozen.eligibleSubtotal.minor) < parseMinorUnits(record.rule.minimumEligibleMerchandise.minor)) {
          fail("minimum eligible merchandise spend not met");
        }
        const used = record.attempts.filter((item) => item.state === "pending" || item.state === "consumed").length;
        if (used >= record.globalCap) throw new CouponRedemptionError("CAPACITY_EXHAUSTED", "coupon redemption capacity is exhausted");
        const attempt: CouponAttempt = deepFreeze(newAttempt(aid, id, frozen, "pending"));
        return deepFreeze({ ...record, attempts: [...record.attempts, attempt] });
      }, "coupon reservation contention did not settle");
      return detached(find(record, aid));
    },

    async attachProviderSession(couponId, attemptId, providerSessionId) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      const session = required(providerSessionId, "providerSessionId");
      const record = await update(id, (current) => {
        const item = find(current, aid);
        if (item.providerSessionId) {
          if (item.providerSessionId !== session) terminalConflict("provider session identity is immutable");
          return current;
        }
        if (item.state !== "pending" || item.freeOrder || item.quote.overallPayableTotal.minor === "0") {
          terminalConflict("provider session cannot attach to this attempt");
        }
        return replaceAttempt(current, aid, { ...item, providerSessionId: session });
      });
      return detached(find(record, aid));
    },

    async reconcile(couponId, attemptId, reconciliation) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      validateReconciliation(reconciliation);
      const record = await update(id, (current) => {
        const item = find(current, aid);
        if (item.quote.overallPayableTotal.minor === "0" && reconciliation.providerSessionId !== undefined) {
          terminalConflict("free attempts cannot have a provider session");
        }
        const mapped = item.providerSessionId;
        if (reconciliation.providerSessionId !== undefined && mapped !== undefined && reconciliation.providerSessionId !== mapped) {
          terminalConflict("provider session identity mismatch");
        }
        if (mapped !== undefined &&
            (reconciliation.kind === "confirmed-failure" || reconciliation.kind === "confirmed-cancel") &&
            reconciliation.providerSessionId === undefined) {
          terminalConflict("mapped provider session is required for failure or cancel");
        }
        if (reconciliation.kind === "verified-not-created" && mapped !== undefined) {
          terminalConflict("verified-not-created conflicts with mapped provider session");
        }
        if (reconciliation.kind === "unknown") return current;
        if (item.state === "consumed") {
          if (reconciliation.kind === "verified-success" && reconciliation.providerSessionId === mapped) return current;
          terminalConflict("consumed attempt is terminal");
        }
        if (item.state === "released") {
          if (["confirmed-failure", "confirmed-cancel", "verified-not-created"].includes(reconciliation.kind)) return current;
          terminalConflict("released attempt is terminal");
        }
        if (reconciliation.kind === "verified-success" && item.quote.overallPayableTotal.minor === "0") {
          terminalConflict("free attempts require free-order reconciliation");
        }
        const nextAttempt = {
          ...item,
          state: reconciliation.kind === "verified-success" ? ("consumed" as const) : ("released" as const),
          ...(reconciliation.providerSessionId ? { providerSessionId: reconciliation.providerSessionId } : {}),
        };
        return replaceAttempt(current, aid, nextAttempt);
      });
      return detached(find(record, aid));
    },

    async reconcileFreeOrder({ couponId, attemptId, proof }) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      if (!recordObject(proof)) fail("free-order proof must be an object");
      const keys = Object.keys(proof);
      const requiredKeys = proof.kind === "unknown"
        ? ["kind", "attemptId", "couponId", "ruleId", "ruleVersion", "quoteId"]
        : ["kind", "attemptId", "couponId", "ruleId", "ruleVersion", "quoteId", "orderId", "receiptId", "overallPayableTotal"];
      if (proof.kind !== "unknown" && proof.kind !== "verified-free-order") fail("free-order proof kind is invalid");
      if (keys.length !== requiredKeys.length || keys.some((key) => !requiredKeys.includes(key))) fail("free-order proof has unsupported fields");
      if (proof.attemptId !== aid) terminalConflict("free-order proof attemptId mismatch");
      if (proof.kind === "verified-free-order") {
        required(proof.orderId, "orderId"); required(proof.receiptId, "receiptId");
        if (!recordObject(proof.overallPayableTotal) ||
            Object.keys(proof.overallPayableTotal).length !== 2 || proof.overallPayableTotal.currency !== "USD" || proof.overallPayableTotal.minor !== "0") {
          fail("free-order proof needs canonical zero USD total");
        }
      }

      const record = await update(id, (current) => {
        const item = find(current, aid);
        if (proof.couponId !== item.couponId || proof.ruleId !== item.ruleId ||
            proof.ruleVersion !== item.ruleVersion || proof.quoteId !== item.quoteId) {
          terminalConflict("free-order proof mismatches frozen attempt");
        }
        if (item.quote.overallPayableTotal.minor !== "0" || item.providerSessionId) {
          terminalConflict("attempt is not a free order");
        }
        if (proof.kind === "unknown") return current;
        if (item.state === "consumed") {
          if (item.freeOrder?.orderId === proof.orderId && item.freeOrder?.receiptId === proof.receiptId) {
            return current;
          }
          terminalConflict("consumed attempt has different free order receipt");
        }
        if (item.state === "released") {
          terminalConflict("released free attempt cannot consume");
        }
        if (item.state !== "pending") {
          terminalConflict("free attempt is terminal");
        }
        return replaceAttempt(current, aid, { ...item, state: "consumed", freeOrder: { orderId: proof.orderId, receiptId: proof.receiptId } });
      });
      return detached(find(record, aid));
    },

    async get(couponId, attemptId) {
      const [id, aid] = attemptIdentity(couponId, attemptId);
      const stored = await collection.get(id);
      if (!stored) return null;
      const record = storedRecord(stored, id);
      const item = record.attempts.find((candidate) => candidate.attemptId === aid);
      return item ? detached(item) : null;
    },

    async getCounts(couponId) {
      const id = required(couponId, "couponId");
      const stored = await collection.get(id);
      if (!stored) return null;
      const record = storedRecord(stored, id);
      const pending = countState(record, "pending");
      const consumed = countState(record, "consumed");
      const released = countState(record, "released");
      return deepFreeze({
        couponId: id,
        cap: record.globalCap,
        capacity: record.globalCap,
        pending,
        consumed,
        released,
        remaining: Math.max(0, record.globalCap - pending - consumed),
      });
    },
  };
}
