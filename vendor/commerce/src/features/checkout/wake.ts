import { isRecord } from "../../shared/record.js";
import { reconcileCheckout } from "./orchestrate.js";
import type {
  CheckoutExecution,
  CheckoutPaymentAssociationPort,
  CheckoutAttempt,
} from "./types.js";

export interface CommercePaymentWake {
  eventId: string;
  attemptId: string;
  bindingRef: string;
  deliveryGeneration: number;
  wokeAt: number;
}

export interface CommercePaymentWakePort {
  list(): Promise<readonly CommercePaymentWake[]>;
  /**
   * Payments must compare the complete event identity: an older ack cannot
   * remove or acknowledge a newer event or delivery for the same attempt.
   */
  acknowledge(wake: CommercePaymentWake): Promise<boolean>;
}

export type WakeReconciliationResult =
  | { wake: CommercePaymentWake; status: "acknowledged"; attempt: CheckoutAttempt }
  | { wake: CommercePaymentWake; status: "retained"; reason: "unknown" | "unavailable" | "missing" | "mismatch" };

/**
 * Trusted server-owned consumer. It accepts no browser input and does not
 * expose a Commerce route. Re-running a wake is safe because reconciliation
 * uses the existing attempt CAS and deterministic order writer.
 */
export async function reconcilePaymentWakes(
  execution: CheckoutExecution,
  associations: CheckoutPaymentAssociationPort,
  wakes: CommercePaymentWakePort,
): Promise<WakeReconciliationResult[]> {
  const results: WakeReconciliationResult[] = [];
  let pending: readonly CommercePaymentWake[];
  try {
    pending = await wakes.list();
  } catch {
    return results;
  }
  for (const wake of pending) {
    if (!isWake(wake)) {
      results.push({ wake, status: "retained", reason: "unknown" });
      continue;
    }
    let association;
    try {
      association = await associations.get(wake.attemptId);
    } catch {
      results.push({ wake, status: "retained", reason: "unavailable" });
      continue;
    }
    if (!association) {
      results.push({ wake, status: "retained", reason: "missing" });
      continue;
    }
    if (association.attemptId !== wake.attemptId ||
        association.bindingRef !== wake.bindingRef) {
      results.push({ wake, status: "retained", reason: "mismatch" });
      continue;
    }
    try {
      const stored = await execution.store.read(association.cartId);
      const canonicalAttempt = stored?.record.attempts.find(
        candidate => candidate.attemptId === association.attemptId,
      );
      if (!canonicalAttempt || canonicalAttempt.payment.bindingRef !== association.bindingRef) {
        results.push({ wake, status: "retained", reason: "mismatch" });
        continue;
      }
      const attempt = await reconcileCheckout(execution, association.cartId, wake.attemptId);
      if (attempt.phase !== "paid" && attempt.phase !== "released") {
        results.push({ wake, status: "retained", reason: "unknown" });
        continue;
      }
      if (attempt.coupon && attempt.coupon.status !==
          (attempt.phase === "paid" ? "consumed" : "released")) {
        results.push({ wake, status: "retained", reason: "unknown" });
        continue;
      }
      if (attempt.phase === "paid" &&
          (!attempt.order || attempt.order.attemptId !== wake.attemptId)) {
        results.push({ wake, status: "retained", reason: "mismatch" });
        continue;
      }
      if (!await wakes.acknowledge(wake)) {
        results.push({ wake, status: "retained", reason: "unavailable" });
        continue;
      }
      results.push({ wake, status: "acknowledged", attempt });
    } catch {
      results.push({ wake, status: "retained", reason: "unavailable" });
    }
  }
  return results;
}

function isWake(value: unknown): value is CommercePaymentWake {
  if (!isRecord(value)) return false;
  const wake = value as Partial<CommercePaymentWake>;
  return typeof wake.eventId === "string" && wake.eventId.trim() !== "" &&
    typeof wake.attemptId === "string" && wake.attemptId.trim() !== "" &&
    typeof wake.bindingRef === "string" && wake.bindingRef.trim() !== "" &&
    typeof wake.deliveryGeneration === "number" &&
    Number.isSafeInteger(wake.deliveryGeneration) && wake.deliveryGeneration > 0 &&
    typeof wake.wokeAt === "number" && Number.isFinite(wake.wokeAt);
}
