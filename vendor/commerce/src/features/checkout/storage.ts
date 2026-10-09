import type { StorageCollection } from "emdash";
import type {
  CheckoutPaymentAssociation,
  CheckoutPaymentAssociationPort,
  CheckoutRecord,
  CheckoutStore,
} from "./types.js";

export const CHECKOUT_COLLECTION = "checkoutCarts";
export const CHECKOUT_PAYMENT_ASSOCIATIONS_COLLECTION = "checkoutPaymentAssociations";
export const CHECKOUT_PAYMENT_ASSOCIATIONS_SANDBOX_COLLECTION = "checkout_payment_associations";
export {
  CHECKOUT_GUEST_CAPABILITY_COLLECTION,
  CHECKOUT_GUEST_CAPABILITY_SANDBOX_COLLECTION,
  CHECKOUT_SANDBOX_COLLECTION,
} from "./types.js";

/** Mount this collection through the native/registry owner before exposing checkout. */
export function createCheckoutStore(collection: Pick<StorageCollection<CheckoutRecord>, "getVersioned" | "compareAndSet">): CheckoutStore {
  return {
    async read(cartId) {
      const stored = await collection.getVersioned(cartId);
      if (!stored) return null;
      if (!stored.value || !Array.isArray(stored.value.attempts) || !stored.value.attempts.length) {
        throw new Error("Invalid stored checkout aggregate");
      }
      return { version: stored.revision, record: stored.value };
    },
    async compareAndSet(cartId, version, record) {
      return (await collection.compareAndSet(cartId, version, record)).applied;
    },
  };
}

export function createCheckoutPaymentAssociationPort(
  collection: Pick<
    StorageCollection<CheckoutPaymentAssociation>,
    "get" | "compareAndSet"
  >,
): CheckoutPaymentAssociationPort {
  const valid = (record: CheckoutPaymentAssociation, attemptId = record.attemptId) =>
    record.recordKind === "checkout-payment-association" &&
    typeof record.attemptId === "string" && record.attemptId.trim() !== "" &&
    record.attemptId === attemptId &&
    typeof record.cartId === "string" && record.cartId.trim() !== "" &&
    typeof record.bindingRef === "string" && record.bindingRef.trim() !== "";
  return {
    async claim(record) {
      if (!valid(record)) return false;
      const existing = await collection.get(record.attemptId);
      if (existing) {
        return valid(existing, record.attemptId) &&
          existing.cartId === record.cartId &&
          existing.bindingRef === record.bindingRef;
      }
      return (await collection.compareAndSet(record.attemptId, null, record)).applied;
    },
    async get(attemptId) {
      if (typeof attemptId !== "string" || attemptId.trim() === "") return null;
      const record = await collection.get(attemptId);
      return record && valid(record, attemptId) ? record : null;
    },
  };
}
