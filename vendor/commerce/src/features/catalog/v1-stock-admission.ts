import { isRecord } from "../../shared/record.js";
import { CatalogError } from "./errors.js";
import { normalizeStoredStockManagement } from "../inventory-provider/kernel/index.js";
import type { CatalogStorageRecord } from "./types.js";

export const MANAGE_STOCK_UNAVAILABLE_MESSAGE =
  "Manage stock is coming soon and cannot be turned on.";
export const MANAGE_STOCK_LOCKED_MESSAGE =
  "Manage stock cannot be changed in Commerce v1.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function isManagedCatalogRecord(
  item: CatalogStorageRecord | null | undefined,
): boolean {
  return (
    item !== null &&
    item !== undefined &&
    item.recordKind === "catalog-item" &&
    normalizeStoredStockManagement(item.stockManagement).mode === "managed"
  );
}

/**
 * When true, Manage Stock mutations are admitted (native local-stock loopback).
 * Sandbox/admin callers omit this and keep the v1 refuse-closed default.
 */
export function admitV1CatalogCreateInput(
  raw: unknown,
  allowManageStockMutations = false,
): unknown {
  if (allowManageStockMutations) return raw;
  const input = asRecord(raw);
  if (input === null) return raw;
  if (input.manageStock === true) {
    throw new CatalogError(
      "MANAGE_STOCK_UNAVAILABLE",
      MANAGE_STOCK_UNAVAILABLE_MESSAGE,
    );
  }
  return raw;
}

export function admitV1CatalogPriceSaveInput(
  raw: unknown,
  currentManaged: boolean,
  allowManageStockMutations = false,
): unknown {
  if (allowManageStockMutations) return raw;
  const input = asRecord(raw);
  if (input === null || !Object.hasOwn(input, "manageStock")) return raw;
  if (typeof input.manageStock !== "boolean") return raw;
  if (input.manageStock === currentManaged) {
    const { manageStock: _ignored, ...rest } = input;
    return rest;
  }
  if (input.manageStock === true) {
    throw new CatalogError(
      "MANAGE_STOCK_UNAVAILABLE",
      MANAGE_STOCK_UNAVAILABLE_MESSAGE,
    );
  }
  throw new CatalogError("MANAGE_STOCK_UNAVAILABLE", MANAGE_STOCK_LOCKED_MESSAGE);
}
