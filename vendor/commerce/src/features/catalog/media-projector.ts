import type { MediaReference } from "./media.js";

/** The subset of an EmDash plugin media item this projection reads. */
export interface ProductMediaItem {
  readonly id: string;
  readonly mimeType: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly alt?: string | null;
  readonly caption?: string | null;
  readonly status?: string;
}

export interface ProductMediaReader {
  get(id: string): Promise<ProductMediaItem | null>;
}

/**
 * One public catalog image. `id` is the EmDash media id; the storefront host
 * maps it to the public file URL.
 */
export interface PublicCatalogImage {
  readonly id: string;
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly placeholder: boolean;
}

export interface ProductImageProjector {
  /** Resolve one reference; `productName` is the final alt fallback. */
  project(
    reference: MediaReference,
    productName: string,
    placeholder?: boolean,
  ): Promise<PublicCatalogImage | null>;
}

const dimension = (value: number | null | undefined): number | null =>
  typeof value === "number" && value > 0 && Number.isFinite(value) ? Math.round(value) : null;
const text = (value: string | null | undefined): string => (typeof value === "string" ? value.trim() : "");

/**
 * Resolve product media references live through the host's media access, so
 * alt text and dimensions always come from the Media Library item. Missing
 * access or an unusable item yields null; callers apply the placeholder rule.
 */
export function createProductImageProjector(media: ProductMediaReader | undefined): ProductImageProjector {
  const cache = new Map<string, Promise<ProductMediaItem | null>>();
  const read = (id: string): Promise<ProductMediaItem | null> => {
    if (!media) return Promise.resolve(null);
    let pending = cache.get(id);
    if (!pending) {
      pending = media.get(id).catch(() => null);
      cache.set(id, pending);
    }
    return pending;
  };
  return {
    async project(reference, productName, placeholder = false) {
      const item = await read(reference.mediaId);
      if (
        !item ||
        item.id !== reference.mediaId ||
        (item.status !== undefined && item.status !== "ready") ||
        !item.mimeType.startsWith("image/")
      ) {
        return null;
      }
      return {
        id: item.id,
        alt: text(item.alt) || text(item.caption) || productName,
        width: dimension(item.width),
        height: dimension(item.height),
        placeholder,
      };
    },
  };
}
