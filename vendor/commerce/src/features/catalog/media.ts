import type { StorageCollection } from "emdash";

import { CatalogError, catalogStorage } from "./errors.js";
import type { CatalogItemReadStorage } from "./types.js";

export const CATALOG_MEDIA_COLLECTION = "catalogMedia";
export const CATALOG_GALLERY_LIMIT = 8;

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A reference into the EmDash Media Library by media id. Commerce stores no
 * file, URL, alt or size copy: EmDash 1.2.0 exposes no plugin-visible mapping
 * from a media id to its public file URL, so the storefront host resolves it.
 */
export interface MediaReference {
  mediaId: string;
}

export interface CatalogMediaRecord {
  recordKind: "catalog-media";
  recordId: string;
  catalogItemId: string;
  image: MediaReference | null;
  gallery: MediaReference[];
}

export type CatalogMediaStorage = Pick<
  StorageCollection<CatalogMediaRecord>,
  "delete" | "get" | "put"
>;

export interface SaveCatalogItemMediaStorage {
  catalog: CatalogItemReadStorage;
  media: CatalogMediaStorage;
}

/** Omitted fields keep their stored value; `image: null` or `""` clears the primary image. */
export interface SaveCatalogItemMediaInput {
  catalogItemId: string;
  image?: string | null;
  gallery?: readonly string[];
}

export interface SaveCatalogItemMediaResult {
  changed: boolean;
  media: CatalogMediaRecord;
}

function invalid(message: string): never {
  throw new CatalogError("INVALID_INPUT", message);
}

function storageFailure(message: string, cause?: unknown): never {
  throw new CatalogError("STORAGE_UNAVAILABLE", message, { cause });
}

/** Accept one Media Library media id as the host and its chooser report it. */
export function normalizeMediaReference(value: unknown, field: string): MediaReference {
  const mediaId = typeof value === "string" ? value.trim() : "";
  if (!MEDIA_ID_PATTERN.test(mediaId)) invalid(`${field} must be a Media Library media id`);
  return { mediaId };
}

export function normalizeGallery(value: unknown): MediaReference[] {
  if (!Array.isArray(value)) invalid("gallery must be a list of Media Library media ids");
  if (value.length > CATALOG_GALLERY_LIMIT) {
    invalid(`Gallery holds at most ${CATALOG_GALLERY_LIMIT} images`);
  }
  const gallery = value.map((entry) => normalizeMediaReference(entry, "gallery"));
  if (new Set(gallery.map((entry) => entry.mediaId)).size !== gallery.length) {
    invalid("That image is already in the gallery");
  }
  return gallery;
}

function mediaRecord(
  catalogItemId: string,
  image: MediaReference | null = null,
  gallery: MediaReference[] = [],
): CatalogMediaRecord {
  return { recordKind: "catalog-media", recordId: catalogItemId, catalogItemId, image, gallery };
}

const storedId = (value: unknown): string | undefined =>
  (value as { mediaId?: unknown } | null)?.mediaId as string | undefined;

export async function loadCatalogItemMedia(
  storage: CatalogMediaStorage,
  catalogItemId: string,
): Promise<CatalogMediaRecord> {
  const stored: CatalogMediaRecord | null = await catalogStorage(() => storage.get(catalogItemId), "catalog media lookup failed");
  if (stored === null) return mediaRecord(catalogItemId);
  try {
    if (
      stored.recordKind !== "catalog-media" ||
      stored.recordId !== catalogItemId ||
      stored.catalogItemId !== catalogItemId ||
      !Array.isArray(stored.gallery)
    ) {
      invalid("record");
    }
    return mediaRecord(
      catalogItemId,
      stored.image === null ? null : normalizeMediaReference(storedId(stored.image), "image"),
      normalizeGallery(stored.gallery.map(storedId)),
    );
  } catch (error) {
    storageFailure("stored catalog media is invalid", error);
  }
}

export async function saveCatalogItemMedia(
  storage: SaveCatalogItemMediaStorage,
  rawInput: unknown,
): Promise<SaveCatalogItemMediaResult> {
  const input = (rawInput ?? {}) as Partial<SaveCatalogItemMediaInput>;
  const catalogItemId = typeof input.catalogItemId === "string" ? input.catalogItemId.trim() : "";
  if (
    typeof rawInput !== "object" ||
    Array.isArray(rawInput) ||
    !catalogItemId ||
    Object.keys(input).some((key) => !["catalogItemId", "gallery", "image"].includes(key))
  ) {
    invalid("media save accepts only catalogItemId, image and gallery");
  }
  const image =
    input.image === undefined
      ? undefined
      : input.image === null || input.image === ""
        ? null
        : normalizeMediaReference(input.image, "image");
  const gallery = input.gallery === undefined ? undefined : normalizeGallery(input.gallery);
  const item = await catalogStorage(() => storage.catalog.get(catalogItemId), "catalog item lookup failed");
  if (item === null || item.recordKind !== "catalog-item" || item.itemId !== catalogItemId) {
    throw new CatalogError("CATALOG_ITEM_NOT_FOUND", "catalog item was not found");
  }
  const current = await loadCatalogItemMedia(storage.media, catalogItemId);
  const next = mediaRecord(
    catalogItemId,
    image === undefined ? current.image : image,
    gallery ?? current.gallery,
  );
  if (JSON.stringify(current) === JSON.stringify(next)) return { changed: false, media: current };
  try {
    if (next.image === null && next.gallery.length === 0) await storage.media.delete(catalogItemId);
    else await storage.media.put(catalogItemId, next);
  } catch (error) {
    storageFailure("catalog media update failed", error);
  }
  return { changed: true, media: next };
}
