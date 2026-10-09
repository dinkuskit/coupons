import type { MediaReference } from "./media.js";

/**
 * Commerce-named size presets (widths in CSS pixels). The storefront host
 * produces them on demand through EmDash's image endpoint; Commerce serves no
 * image bytes and pre-generates no files.
 */
export const COMMERCE_IMAGE_PRESETS = {
  thumbnail: 300,
  single: 600,
  gallery_thumbnail: 100,
} as const;
export const COMMERCE_IMAGE_SRCSET_WIDTHS = [300, 600, 1200] as const;
/** Astro's default image endpoint route, which EmDash wraps to read Media Library bytes from storage. */
export const COMMERCE_IMAGE_ENDPOINT_ROUTE = "/_image";
export const COMMERCE_IMAGE_SIZES = `(min-width: ${COMMERCE_IMAGE_PRESETS.single}px) ${COMMERCE_IMAGE_PRESETS.single}px, 100vw`;

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
 * maps it to the public file URL (for example `handleMediaGet(await getDb(), id)`
 * then `Astro.locals.emdash.getPublicMediaUrl(item.storageKey)`) and builds
 * `srcset` with {@link commerceImageSrcset}.
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

/** Build one EmDash image-endpoint URL for a public media file URL at a preset width. */
export function commerceImageTransformUrl(src: string, width: number, siteUrl?: string): string {
  let href = src;
  if (src.startsWith("/") && !src.startsWith("//") && siteUrl) {
    try {
      href = new URL(src, siteUrl).href;
    } catch {
      href = src;
    }
  }
  return `${COMMERCE_IMAGE_ENDPOINT_ROUTE}?href=${encodeURIComponent(href)}&w=${width}&f=webp`;
}

/** Build the `srcset` for the `single` preset: 300/600/1200 candidates capped at the original width. */
export function commerceImageSrcset(src: string, originalWidth?: number | null, siteUrl?: string): string {
  const width = dimension(originalWidth);
  const candidates = COMMERCE_IMAGE_SRCSET_WIDTHS.filter((w) => width === null || w <= width);
  const widths = candidates.length ? candidates : [width as number];
  return widths.map((w) => `${commerceImageTransformUrl(src, w, siteUrl)} ${w}w`).join(", ");
}

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
