import { catalogFail, catalogStorage } from "./errors.js";
import type {
  CatalogBackorderPolicyRecord,
  CatalogBackorderPolicyStorage,
} from "./types.js";

export async function loadCatalogItemBackorderPolicy(
  storage: CatalogBackorderPolicyStorage,
  catalogItemId: string,
): Promise<CatalogBackorderPolicyRecord> {
  if (typeof catalogItemId !== "string" || catalogItemId.trim().length === 0) {
    catalogFail("INVALID_INPUT", "catalogItemId must be a non-empty string");
  }
  const id = catalogItemId.trim();
  const stored: CatalogBackorderPolicyRecord | null = await catalogStorage(() => storage.get(id), "backorder policy lookup failed");
  if (stored === null) {
    return { recordKind: "catalog-backorder-policy", recordId: id, catalogItemId: id, allowBackorders: false };
  }
  if (
    stored.recordKind !== "catalog-backorder-policy" ||
    stored.recordId !== id ||
    stored.catalogItemId !== id ||
    typeof stored.allowBackorders !== "boolean"
  ) {
    catalogFail("STORAGE_UNAVAILABLE", "stored backorder policy is invalid");
  }
  return stored;
}
