export {
  createProductImageProjector,
  type ProductImageProjector,
  type ProductMediaItem,
  type ProductMediaReader,
  type PublicCatalogImage,
} from "./media-projector.js";

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

const dimension = (value: number | null | undefined): number | null =>
  typeof value === "number" && value > 0 && Number.isFinite(value) ? Math.round(value) : null;

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
