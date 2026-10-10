import { isRecord } from "../../shared/record.js";
import type { StorageCollection } from "emdash";
import { CatalogError } from "./errors.js";
import { normalizeIdentifierPatch, type CatalogProductIdentifiers } from "./identifiers.js";
import type {
  CatalogItemReadStorage,
  CatalogItemRecord,
  CatalogStorage,
  CatalogStorageRecord,
} from "./types.js";

export interface SetCatalogItemIdentifiersInput {
  catalogItemId: string;
  gtin?: string | null;
  mpn?: string | null;
  brand?: string | null;
}

export interface SetCatalogItemIdentifiersResult {
  changed: boolean;
  item: CatalogItemRecord;
  identifiers: CatalogProductIdentifiers;
}

export async function setCatalogItemIdentifiers(
  storage: CatalogStorage &
    CatalogItemReadStorage &
    Pick<StorageCollection<CatalogStorageRecord>, "compareAndSet" | "getVersioned">,
  rawInput: unknown,
): Promise<SetCatalogItemIdentifiersResult> {
  if (!isRecord(rawInput)) {
    throw new CatalogError("INVALID_INPUT", "request body must be an object");
  }
  const input = rawInput as Record<string, unknown>;
  if (
    typeof input.catalogItemId !== "string" ||
    !input.catalogItemId ||
    input.catalogItemId.length > 1024
  ) {
    throw new CatalogError("INVALID_INPUT", "catalogItemId must be a valid itemId");
  }
  const { catalogItemId: _id, ...fields } = input;
  const patch = normalizeIdentifierPatch(fields);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stored = await storage.getVersioned(input.catalogItemId as string);
    const current = stored?.value as CatalogItemRecord | undefined;
    if (
      !stored ||
      !current ||
      current.recordKind !== "catalog-item" ||
      current.itemId !== input.catalogItemId
    ) {
      throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
    }
    let gtin = current.gtin;
    let mpn = current.mpn;
    let brand = current.brand;
    if (patch.gtin === null) gtin = undefined;
    else if (patch.gtin !== undefined) gtin = patch.gtin;
    if (patch.mpn === null) mpn = undefined;
    else if (patch.mpn !== undefined) mpn = patch.mpn;
    if (patch.brand === null) brand = undefined;
    else if (patch.brand !== undefined) brand = patch.brand;
    if (gtin === current.gtin && mpn === current.mpn && brand === current.brand) {
      const identifiers: CatalogProductIdentifiers = {
        ...(gtin ? { gtin } : {}),
        ...(mpn ? { mpn } : {}),
        ...(brand ? { brand } : {}),
      };
      return { changed: false, item: current, identifiers };
    }
    const item: CatalogItemRecord = {
      ...current,
      ...(gtin !== undefined ? { gtin } : { gtin: undefined }),
      ...(mpn !== undefined ? { mpn } : { mpn: undefined }),
      ...(brand !== undefined ? { brand } : { brand: undefined }),
    };
    // Drop cleared optional keys rather than storing undefined.
    if (!gtin) delete (item as { gtin?: string }).gtin;
    if (!mpn) delete (item as { mpn?: string }).mpn;
    if (!brand) delete (item as { brand?: string }).brand;
    try {
      const result = await storage.compareAndSet(item.itemId, stored.revision, item);
      if (result.applied) {
        const identifiers: CatalogProductIdentifiers = {
          ...(item.gtin ? { gtin: item.gtin } : {}),
          ...(item.mpn ? { mpn: item.mpn } : {}),
          ...(item.brand ? { brand: item.brand } : {}),
        };
        return { changed: true, item, identifiers };
      }
    } catch (error) {
      throw new CatalogError("STORAGE_UNAVAILABLE", "catalog identifier update failed", {
        cause: error,
      });
    }
  }
  throw new CatalogError("STORAGE_UNAVAILABLE", "catalog identifier update conflicted repeatedly");
}
