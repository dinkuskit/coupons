import type { InventorySkuIdentity, StockManagement } from "./types.js";
import {
  normalizeManagedSkuRegistration,
  normalizeManagedSkuRegistrationRejection,
} from "./registration.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeStoredIdentity(value: unknown): InventorySkuIdentity | null {
  const candidate = asRecord(value);
  if (!candidate) return null;

  const inventorySkuId =
    typeof candidate.inventorySkuId === "string" ? candidate.inventorySkuId.trim() : "";
  const sku = typeof candidate.sku === "string" ? candidate.sku.trim() : "";
  const displayName =
    typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";

  return inventorySkuId && sku && displayName
    ? { inventorySkuId, sku, displayName }
    : null;
}

export function normalizeStoredStockManagement(value: unknown): StockManagement {
  const stored = asRecord(value);
  if (stored?.mode === "unmanaged") return { mode: "unmanaged" };

  if (stored?.mode === "managed") {
    if (stored.status === "setup-required") {
      return { mode: "managed", status: "setup-required" };
    }

    if (stored.status === "setup-pending") {
      try {
        return {
          mode: "managed",
          status: "setup-pending",
          registration: normalizeManagedSkuRegistration(stored.registration),
        };
      } catch {
        return { mode: "managed", status: "setup-required" };
      }
    }

    if (stored.status === "setup-needs-attention") {
      try {
        return {
          mode: "managed",
          status: "setup-needs-attention",
          registration: normalizeManagedSkuRegistration(stored.registration),
          rejection: normalizeManagedSkuRegistrationRejection(stored.rejection),
        };
      } catch {
        return { mode: "managed", status: "setup-required" };
      }
    }

    if (stored.status === "active") {
      const inventorySkuId =
        typeof stored.inventorySkuId === "string" ? stored.inventorySkuId.trim() : "";
      return inventorySkuId
        ? { mode: "managed", status: "active", inventorySkuId }
        : { mode: "managed", status: "setup-required" };
    }

    if (stored.status === "needs-review") {
      const candidate = normalizeStoredIdentity(stored.candidate);
      return candidate
        ? { mode: "managed", status: "needs-review", candidate }
        : { mode: "managed", status: "setup-required" };
    }

    return { mode: "managed", status: "setup-required" };
  }

  return { mode: "unmanaged" };
}

export function createInitialStockManagement(manageStock: boolean): StockManagement {
  return manageStock
    ? { mode: "managed", status: "setup-required" }
    : { mode: "unmanaged" };
}

export function setManageStock(
  current: StockManagement,
  manageStock: boolean,
): StockManagement {
  if (!manageStock) return { mode: "unmanaged" };
  if (current.mode === "managed") return current;
  return { mode: "managed", status: "setup-required" };
}
