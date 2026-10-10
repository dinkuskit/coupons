import type {
  InventorySkuIdentity,
  ManagedSkuRegistration,
  ManagedSkuRegistrationRejection,
  StockManagement,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function identity(value: unknown): InventorySkuIdentity | null {
  const c = asRecord(value);
  if (!c) return null;
  const inventorySkuId = str(c.inventorySkuId), sku = str(c.sku), displayName = str(c.displayName);
  return inventorySkuId && sku && displayName ? { inventorySkuId, sku, displayName } : null;
}

function registration(value: unknown): ManagedSkuRegistration | null {
  const c = asRecord(value), r = asRecord(c?.request);
  if (!c || !r) return null;
  const operationId = str(c.operationId), poolId = str(r.poolId), sku = str(r.sku), displayNameIfNew = str(r.displayNameIfNew);
  return operationId && poolId && sku && displayNameIfNew
    ? { operationId, request: { poolId, sku, displayNameIfNew } }
    : null;
}

function rejection(value: unknown): ManagedSkuRegistrationRejection | null {
  const c = asRecord(value);
  if (!c) return null;
  const code = str(c.code), message = str(c.message);
  return code && message ? { code, message } : null;
}

export function normalizeStoredStockManagement(value: unknown): StockManagement {
  const s = asRecord(value);
  if (s?.mode === "unmanaged") return { mode: "unmanaged" };
  if (s?.mode !== "managed") return { mode: "unmanaged" };
  if (s.status === "setup-required") return { mode: "managed", status: "setup-required" };
  if (s.status === "setup-pending") {
    const reg = registration(s.registration);
    return reg ? { mode: "managed", status: "setup-pending", registration: reg } : { mode: "managed", status: "setup-required" };
  }
  if (s.status === "setup-needs-attention") {
    const reg = registration(s.registration), rej = rejection(s.rejection);
    return reg && rej
      ? { mode: "managed", status: "setup-needs-attention", registration: reg, rejection: rej }
      : { mode: "managed", status: "setup-required" };
  }
  if (s.status === "active") {
    const inventorySkuId = str(s.inventorySkuId);
    return inventorySkuId ? { mode: "managed", status: "active", inventorySkuId } : { mode: "managed", status: "setup-required" };
  }
  if (s.status === "needs-review") {
    const candidate = identity(s.candidate);
    return candidate ? { mode: "managed", status: "needs-review", candidate } : { mode: "managed", status: "setup-required" };
  }
  return { mode: "managed", status: "setup-required" };
}

export function createInitialStockManagement(manageStock: boolean): StockManagement {
  return manageStock ? { mode: "managed", status: "setup-required" } : { mode: "unmanaged" };
}

export function setManageStock(current: StockManagement, manageStock: boolean): StockManagement {
  if (!manageStock) return { mode: "unmanaged" };
  if (current.mode === "managed") return current;
  return { mode: "managed", status: "setup-required" };
}
