import { CatalogError } from "./errors.js";
import type {
  CatalogBackorderPolicyRecord,
  SetCatalogItemBackordersInput,
  SetCatalogItemBackordersResult,
  SetCatalogItemBackordersStorage,
} from "./types.js";

function normalizeInput(value: unknown): SetCatalogItemBackordersInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError("INVALID_INPUT", "backorder setting input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.catalogItemId !== "string" ||
    input.catalogItemId.trim().length === 0 ||
    typeof input.allowBackorders !== "boolean"
  ) {
    throw new CatalogError(
      "INVALID_INPUT",
      "backorder setting accepts only catalogItemId and boolean allowBackorders",
    );
  }
  return {
    catalogItemId: input.catalogItemId.trim(),
    allowBackorders: input.allowBackorders,
  };
}

function assertCatalogItem(
  value: Awaited<ReturnType<SetCatalogItemBackordersStorage["catalog"]["get"]>>,
  catalogItemId: string,
): void {
  if (value === null || value.recordKind !== "catalog-item") {
    throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  if (value.itemId !== catalogItemId) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "stored catalog item identity does not match its key",
    );
  }
}

function normalizeStoredPolicy(
  value: CatalogBackorderPolicyRecord | null,
  catalogItemId: string,
): CatalogBackorderPolicyRecord {
  if (value === null) {
    return {
      recordKind: "catalog-backorder-policy",
      recordId: catalogItemId,
      catalogItemId,
      allowBackorders: false,
    };
  }
  if (
    value.recordKind !== "catalog-backorder-policy" ||
    value.recordId !== catalogItemId ||
    value.catalogItemId !== catalogItemId ||
    typeof value.allowBackorders !== "boolean"
  ) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "stored backorder policy is invalid");
  }
  return value;
}

export async function loadCatalogItemBackorderPolicy(
  storage: SetCatalogItemBackordersStorage["policies"],
  catalogItemId: string,
): Promise<CatalogBackorderPolicyRecord> {
  let stored: CatalogBackorderPolicyRecord | null;
  try {
    stored = await storage.get(catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "backorder policy lookup failed", {
      cause: error,
    });
  }
  return normalizeStoredPolicy(stored, catalogItemId);
}

export async function setCatalogItemBackorders(
  storage: SetCatalogItemBackordersStorage,
  rawInput: unknown,
): Promise<SetCatalogItemBackordersResult> {
  const input = normalizeInput(rawInput);
  let storedCatalogItem;
  try {
    storedCatalogItem = await storage.catalog.get(input.catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog item lookup failed", {
      cause: error,
    });
  }
  assertCatalogItem(storedCatalogItem, input.catalogItemId);
  const policy = await loadCatalogItemBackorderPolicy(
    storage.policies,
    input.catalogItemId,
  );
  if (policy.allowBackorders === input.allowBackorders) {
    return { changed: false, policy };
  }
  const updated: CatalogBackorderPolicyRecord = {
    ...policy,
    allowBackorders: input.allowBackorders,
  };
  try {
    await storage.policies.put(updated.recordId, updated);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "backorder policy update failed", {
      cause: error,
    });
  }
  return { changed: true, policy: updated };
}
