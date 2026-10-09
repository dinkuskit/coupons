import { normalizeStoredStockManagement } from "../inventory-provider/index.js";
import { CatalogError } from "./errors.js";
import {
  DEFAULT_CATALOG_MANUAL_AVAILABILITY,
  type CatalogManualAvailabilityRecord,
  type CatalogManualAvailabilityStatus,
  type SetCatalogItemManualAvailabilityInput,
  type SetCatalogItemManualAvailabilityResult,
  type SetCatalogItemManualAvailabilityStorage,
} from "./types.js";

const MANUAL_AVAILABILITY_STATUSES = new Set<CatalogManualAvailabilityStatus>([
  "in-stock",
  "out-of-stock",
  "available-on-backorder",
]);

function normalizeInput(value: unknown): SetCatalogItemManualAvailabilityInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogError(
      "INVALID_INPUT",
      "manual availability input must be an object",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.catalogItemId !== "string" ||
    input.catalogItemId.trim().length === 0 ||
    typeof input.status !== "string" ||
    !MANUAL_AVAILABILITY_STATUSES.has(
      input.status as CatalogManualAvailabilityStatus,
    )
  ) {
    throw new CatalogError(
      "INVALID_INPUT",
      "manual availability accepts only catalogItemId and a supported status",
    );
  }
  return {
    catalogItemId: input.catalogItemId.trim(),
    status: input.status as CatalogManualAvailabilityStatus,
  };
}

function normalizeStoredAvailability(
  value: CatalogManualAvailabilityRecord | null,
  catalogItemId: string,
): CatalogManualAvailabilityRecord {
  if (value === null) {
    return {
      recordKind: "catalog-manual-availability",
      recordId: catalogItemId,
      catalogItemId,
      status: DEFAULT_CATALOG_MANUAL_AVAILABILITY,
    };
  }
  if (
    value.recordKind !== "catalog-manual-availability" ||
    value.recordId !== catalogItemId ||
    value.catalogItemId !== catalogItemId ||
    !MANUAL_AVAILABILITY_STATUSES.has(value.status)
  ) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "stored manual availability is invalid",
    );
  }
  return value;
}

export async function loadCatalogItemManualAvailability(
  storage: SetCatalogItemManualAvailabilityStorage["availability"],
  catalogItemId: string,
): Promise<CatalogManualAvailabilityRecord> {
  let stored: CatalogManualAvailabilityRecord | null;
  try {
    stored = await storage.get(catalogItemId);
  } catch (error) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "manual availability lookup failed",
      { cause: error },
    );
  }
  return normalizeStoredAvailability(stored, catalogItemId);
}

export async function setCatalogItemManualAvailability(
  storage: SetCatalogItemManualAvailabilityStorage,
  rawInput: unknown,
): Promise<SetCatalogItemManualAvailabilityResult> {
  const input = normalizeInput(rawInput);
  let item;
  try {
    item = await storage.catalog.get(input.catalogItemId);
  } catch (error) {
    throw new CatalogError("STORAGE_UNAVAILABLE", "catalog item lookup failed", {
      cause: error,
    });
  }
  if (item === null || item.recordKind !== "catalog-item") {
    throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  if (item.itemId !== input.catalogItemId) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "stored catalog item identity does not match its key",
    );
  }
  if (normalizeStoredStockManagement(item.stockManagement).mode === "managed") {
    throw new CatalogError(
      "MANAGE_STOCK_ENABLED",
      "manual availability requires Manage Stock to be disabled",
    );
  }

  const availability = await loadCatalogItemManualAvailability(
    storage.availability,
    input.catalogItemId,
  );
  if (availability.status === input.status) {
    return { changed: false, availability };
  }
  const updated: CatalogManualAvailabilityRecord = {
    ...availability,
    status: input.status,
  };
  try {
    await storage.availability.put(updated.recordId, updated);
  } catch (error) {
    throw new CatalogError(
      "STORAGE_UNAVAILABLE",
      "manual availability update failed",
      { cause: error },
    );
  }
  return { changed: true, availability: updated };
}
