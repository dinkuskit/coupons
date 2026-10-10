import type { PluginContext } from "emdash/plugin";
import { resolveCatalogItemPrice } from "./price.js";
import { loadCatalogItemMedia, type CatalogMediaStorage } from "./media.js";
import { createProductImageProjector, type PublicCatalogImage } from "./media-projector.js";
import {
  loadStorefrontPlaceholderImage,
  resolveStorefrontAvailability,
  type StorefrontPlaceholderImageStorage,
} from "../storefront-availability/kernel/index.js";
import type { CatalogStorageRecord } from "./types.js";
import {
  resolveCatalogVariantMember,
  variantSelections,
  type CatalogVariantProduct,
} from "./variants.js";
import { bindGuestCheckoutRuntime, SANDBOX_GUEST_CHECKOUT_STORAGE } from "../checkout/kernel/index.js";
import type { StorefrontAvailabilityResult } from "../storefront-availability/kernel/index.js";

function unavailable(): never { throw new Error("Catalog unavailable"); }
function optionalIds(item: { gtin?: string; mpn?: string; brand?: string }) {
  return {
    ...(item.gtin ? { gtin: item.gtin } : {}),
    ...(item.mpn ? { mpn: item.mpn } : {}),
    ...(item.brand ? { brand: item.brand } : {}),
  };
}

export const PUBLIC_CATALOG_ROUTE = "catalog/public";
export const PUBLIC_CATALOG_ITEM_ROUTE = "catalog/public/item";
export interface PublicCatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly sku: string;
  readonly price?: { readonly currency: "USD"; readonly minor: string };
  readonly availability: Pick<StorefrontAvailabilityResult, "status" | "sellable" | "listable">;
  /** Primary image, the store placeholder (placeholder: true), or null when neither resolves. The host maps ids to URLs. */
  readonly image: PublicCatalogImage | null;
  readonly gallery: readonly PublicCatalogImage[];
  /** Optional merchant identifiers; omitted when unset. Never invented. */
  readonly gtin?: string;
  readonly mpn?: string;
  readonly brand?: string;
  readonly variants?: {
    readonly schema: "dinkuskit.commerce.product-variants/v1";
    readonly productId: string;
    readonly options: CatalogVariantProduct["options"];
    readonly members: readonly {
      catalogItemId: string;
      selections: readonly ReturnType<typeof variantSelections>[number][];
      price: { readonly currency: "USD"; readonly minor: string } | null;
      availability: Pick<StorefrontAvailabilityResult, "status" | "sellable" | "listable">;
      fulfillment: "physical" | "digital";
    }[];
  };
}
export interface PublicCatalogResponse {
  readonly products: readonly PublicCatalogProduct[];
  readonly cursor?: string;
}

function assertItemId(itemId: string): void {
  if (typeof itemId !== "string" || !itemId || itemId.length > 1024) unavailable();
}

async function projectPublicCatalogProduct(
  ctx: PluginContext,
  storage: ReturnType<typeof bindGuestCheckoutRuntime>["catalog"],
  item: CatalogStorageRecord,
  images: ReturnType<typeof createProductImageProjector>,
  placeholder: Awaited<ReturnType<typeof loadStorefrontPlaceholderImage>>["image"],
): Promise<PublicCatalogProduct | null> {
  if (
    item.recordKind !== "catalog-item" ||
    [item.itemId, item.name, item.sku].some(
      (value) => typeof value !== "string" || !value || value.length > 1024,
    )
  ) {
    unavailable();
  }
  const variant = await resolveCatalogVariantMember(storage.catalog, item.itemId);
  if (variant === null) return null;
  const availability = await resolveStorefrontAvailability(storage, { catalogItemId: item.itemId });
  const price = await resolveCatalogItemPrice(storage.prices, item.itemId);
  const media = await loadCatalogItemMedia(
    ctx.storage.catalog_media as CatalogMediaStorage,
    item.itemId,
  );
  const image =
    (media.image && (await images.project(media.image, item.name))) ||
    (placeholder && (await images.project(placeholder, item.name, true))) ||
    null;
  const gallery: PublicCatalogImage[] = [];
  for (const entry of media.gallery) {
    const projected = await images.project(entry, item.name);
    if (projected) gallery.push(projected);
  }
  if (variant.product) {
    const members = [];
    for (const member of variant.product.members) {
      const memberItem = await resolveCatalogVariantMember(storage.catalog, member.catalogItemId);
      if (!memberItem?.member || memberItem.product?.productId !== variant.product.productId) continue;
      const memberPrice = await resolveCatalogItemPrice(storage.prices, member.catalogItemId);
      if (!memberPrice.listable || !memberPrice.customerPays) continue;
      const memberAvailability = await resolveStorefrontAvailability(storage, {
        catalogItemId: member.catalogItemId,
      });
      if (!memberAvailability.listable) continue;
      members.push({
        catalogItemId: member.catalogItemId,
        selections: variantSelections(variant.product, member),
        price: memberPrice.customerPays ?? null,
        availability: {
          status: memberAvailability.status,
          sellable: memberAvailability.sellable,
          listable: memberAvailability.listable,
        },
        fulfillment: member.fulfillment,
      });
    }
    if (!members.length) return null;
    return {
      id: variant.product.productId,
      name: item.name,
      sku: item.sku,
      ...(!variant.product.options.length && price.customerPays ? { price: price.customerPays } : {}),
      availability: { status: availability.status, sellable: !variant.product.options.length && availability.sellable, listable: members.some((member) => member.availability.listable) },
      image,
      gallery,
      ...optionalIds(item),
      variants: {
        schema: variant.product.schema,
        productId: variant.product.productId,
        options: variant.product.options,
        members,
      },
    };
  }
  if (!price.listable || !price.customerPays || !availability.listable) return null;
  return {
    id: item.itemId,
    name: item.name,
    sku: item.sku,
    price: price.customerPays,
    availability: {
      status: availability.status,
      sellable: availability.sellable,
      listable: availability.listable,
    },
    image,
    gallery,
    ...optionalIds(item),
  };
}

/** Runtime-owned context only. Structural storage access does not attest installation. */
export async function readPublicCatalog(ctx: PluginContext, cursor?: string): Promise<PublicCatalogResponse> {
  if (cursor !== undefined && (!cursor || cursor.length > 1024)) unavailable();
  const c = ctx.storage;
  const storage = bindGuestCheckoutRuntime(c, SANDBOX_GUEST_CHECKOUT_STORAGE, { runtimeSiteUrl: ctx.site.url }).catalog;
  const page = await c.catalog_items!.query({ limit: 50, cursor });
  if (page.items.length > 50 || (page.hasMore && (!page.cursor || page.cursor === cursor || page.cursor.length > 1024))) {
    unavailable();
  }
  const images = createProductImageProjector(ctx.media);
  const placeholder = (await loadStorefrontPlaceholderImage(c.storefront_placeholder_image as StorefrontPlaceholderImageStorage)).image;
  const products: PublicCatalogProduct[] = [];
  for (const row of page.items) {
    const item = row.data as unknown as CatalogStorageRecord;
    if (item.recordKind !== "catalog-item" || item.variantProductId) continue;
    if (row.id !== item.itemId) unavailable();
    const product = await projectPublicCatalogProduct(ctx, storage, item, images, placeholder);
    if (product) products.push(product);
  }
  return { products, ...(page.hasMore ? { cursor: page.cursor } : {}) };
}

/**
 * Resolve one authoritative Commerce product by its permanent itemId.
 * Publication, page selection, and CMS state belong to the host page resolver.
 */
export async function readPublicCatalogItem(
  ctx: PluginContext,
  itemId: string,
): Promise<PublicCatalogProduct | null> {
  assertItemId(itemId);
  const c = ctx.storage;
  const storage = bindGuestCheckoutRuntime(c, SANDBOX_GUEST_CHECKOUT_STORAGE, {
    runtimeSiteUrl: ctx.site.url,
  }).catalog;
  const row = await c.catalog_items!.get(itemId);
  if (!row) return null;
  let item = row as unknown as CatalogStorageRecord;
  if (item.recordKind !== "catalog-item" || item.itemId !== itemId) unavailable();
  if (item.variantProductId) {
    if (!await resolveCatalogVariantMember(storage.catalog, itemId)) return null;
    const parent = await c.catalog_items!.get(item.variantProductId);
    if (!parent) return null;
    item = parent as unknown as CatalogStorageRecord;
  }
  const images = createProductImageProjector(ctx.media);
  const placeholder = (
    await loadStorefrontPlaceholderImage(
      c.storefront_placeholder_image as StorefrontPlaceholderImageStorage,
    )
  ).image;
  return projectPublicCatalogProduct(ctx, storage, item, images, placeholder);
}
