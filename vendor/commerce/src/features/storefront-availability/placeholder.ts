import type { StorageCollection } from "emdash";

import { normalizeMediaReference, type MediaReference } from "../catalog/kernel/index.js";
import { StorefrontAvailabilityError } from "./errors.js";

export const STOREFRONT_PLACEHOLDER_IMAGE_COLLECTION = "storefrontPlaceholderImage";
export const STOREFRONT_PLACEHOLDER_IMAGE_RECORD_ID = "active";

/** Store-level placeholder shown for products without a primary image. Commerce ships no file. */
export interface StorefrontPlaceholderImageRecord {
  recordKind: "storefront-placeholder-image";
  recordId: typeof STOREFRONT_PLACEHOLDER_IMAGE_RECORD_ID;
  image: MediaReference | null;
  updatedAt: string;
}

export type StorefrontPlaceholderImageStorage = Pick<
  StorageCollection<StorefrontPlaceholderImageRecord>,
  "get" | "put"
>;

export interface SetStorefrontPlaceholderImageOptions {
  now?: () => Date;
}

export interface SetStorefrontPlaceholderImageResult {
  changed: boolean;
  placeholder: StorefrontPlaceholderImageRecord;
}

function record(
  image: MediaReference | null = null,
  updatedAt = "1970-01-01T00:00:00.000Z",
): StorefrontPlaceholderImageRecord {
  return {
    recordKind: "storefront-placeholder-image",
    recordId: STOREFRONT_PLACEHOLDER_IMAGE_RECORD_ID,
    image,
    updatedAt,
  };
}

function unavailable(message: string): never {
  throw new StorefrontAvailabilityError("STORAGE_UNAVAILABLE", message);
}

/** Accept one media id, or null / "" for no placeholder. */
function reference(value: unknown): MediaReference | null {
  return value === null || value === "" ? null : normalizeMediaReference(value, "Placeholder image");
}

export async function loadStorefrontPlaceholderImage(
  storage: StorefrontPlaceholderImageStorage,
): Promise<StorefrontPlaceholderImageRecord> {
  let stored: StorefrontPlaceholderImageRecord | null;
  try {
    stored = await storage.get(STOREFRONT_PLACEHOLDER_IMAGE_RECORD_ID);
  } catch {
    unavailable("placeholder image lookup failed");
  }
  if (stored === null) return record();
  try {
    if (
      stored.recordKind !== "storefront-placeholder-image" ||
      stored.recordId !== STOREFRONT_PLACEHOLDER_IMAGE_RECORD_ID ||
      typeof stored.updatedAt !== "string" ||
      !stored.updatedAt.trim()
    ) {
      throw new Error("record");
    }
    return record(stored.image === null ? null : reference(stored.image?.mediaId), stored.updatedAt.trim());
  } catch {
    unavailable("stored placeholder image is invalid");
  }
}

export async function setStorefrontPlaceholderImage(
  storage: StorefrontPlaceholderImageStorage,
  rawInput: unknown,
  options: SetStorefrontPlaceholderImageOptions = {},
): Promise<SetStorefrontPlaceholderImageResult> {
  const input = rawInput as { image?: unknown } | null;
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).join() !== "image"
  ) {
    throw new StorefrontAvailabilityError("INVALID_INPUT", "placeholder accepts only image");
  }
  let image: MediaReference | null;
  try {
    image = reference(input.image);
  } catch (error) {
    throw new StorefrontAvailabilityError(
      "INVALID_INPUT",
      error instanceof Error ? error.message : "Placeholder image is invalid",
    );
  }
  const current = await loadStorefrontPlaceholderImage(storage);
  if (JSON.stringify(current.image) === JSON.stringify(image)) {
    return { changed: false, placeholder: current };
  }
  const updated = record(image, (options.now ?? (() => new Date()))().toISOString());
  try {
    await storage.put(updated.recordId, updated);
  } catch {
    unavailable("placeholder image update failed");
  }
  return { changed: true, placeholder: updated };
}
