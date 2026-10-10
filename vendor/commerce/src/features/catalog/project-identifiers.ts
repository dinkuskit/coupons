import type { CatalogProductIdentifiers } from "./identifiers.js";

/** Project optional identifier fields for public catalog output. */
export function projectIdentifiers(
  item: CatalogProductIdentifiers,
): CatalogProductIdentifiers | undefined {
  const out: { gtin?: string; mpn?: string; brand?: string } = {};
  if (typeof item.gtin === "string" && item.gtin) out.gtin = item.gtin;
  if (typeof item.mpn === "string" && item.mpn) out.mpn = item.mpn;
  if (typeof item.brand === "string" && item.brand) out.brand = item.brand;
  return Object.keys(out).length ? out : undefined;
}
