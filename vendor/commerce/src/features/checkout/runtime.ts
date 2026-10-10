import type { StorageCollection } from "emdash";

import type {
  CatalogBackorderPolicyStorage,
  CatalogManualAvailabilityStorage,
  CatalogPriceStorage,
  CatalogStorageRecord,
} from "../catalog/kernel/index.js";
import type { StoreInventoryConfigurationStorage } from "../inventory-setup/kernel/index.js";
import type {
  StorefrontAvailabilitySettingsStorage,
  StorefrontOutOfStockListingStorage,
} from "../storefront-availability/kernel/index.js";
import type { CheckoutCouponPort } from "../coupons/index.js";
import type { PaidOrderReceiver } from "../../handoffs/paid-order.js";
import { GuestCheckoutError } from "./errors.js";
import { admitGuestCheckoutWrite } from "./origin-admission.js";
import { resolveTrustedSiteOrigin } from "./site-scope.js";
import { createCheckoutPaymentAssociationPort } from "./storage.js";
import type {
  CheckoutRecord,
  CheckoutPaymentAssociation,
  GuestCapabilityRecord,
  GuestCheckoutHostOptions,
  GuestCheckoutRuntime,
} from "./types.js";

export interface GuestCheckoutStorageNames {
  carts: string;
  capabilities: string;
  catalogItems: string;
  prices: string;
  backorderPolicies: string;
  manualAvailability: string;
  configurations: string;
  settings: string;
  listing?: string;
  paymentAssociations?: string;
}

export const NATIVE_GUEST_CHECKOUT_STORAGE = {
  carts: "checkoutCarts",
  capabilities: "checkoutGuestCapabilities",
  catalogItems: "catalogItems",
  prices: "catalogPrices",
  backorderPolicies: "catalogBackorderPolicies",
  manualAvailability: "catalogManualAvailability",
  configurations: "storeInventoryConfigurations",
  settings: "storefrontAvailabilitySettings",
  listing: "storefrontOutOfStockListing",
  paymentAssociations: "checkoutPaymentAssociations",
} as const satisfies GuestCheckoutStorageNames;

export const SANDBOX_GUEST_CHECKOUT_STORAGE = {
  carts: "checkout_carts",
  capabilities: "checkout_guest_capabilities",
  catalogItems: "catalog_items",
  prices: "catalog_prices",
  backorderPolicies: "catalog_backorder_policies",
  manualAvailability: "catalog_manual_availability",
  configurations: "store_inventory_configurations",
  settings: "storefront_availability_settings",
  listing: "storefront_out_of_stock_listing",
  paymentAssociations: "checkout_payment_associations",
} as const satisfies GuestCheckoutStorageNames;

export function bindGuestCheckoutRuntime(
  storage: Record<string, unknown>,
  names: GuestCheckoutStorageNames,
  options: {
    siteUrl?: string;
    constructorSiteUrl?: string;
    runtimeSiteUrl?: string;
    topLevelSiteUrl?: string;
    checkoutSiteUrl?: string;
    host?: GuestCheckoutHostOptions;
    /** Entry-bound coupon support; the host cannot supply it. */
    coupons?: CheckoutCouponPort;
    /** Entry-bound Orders receiver for the paid-order handoff. */
    paidOrders?: PaidOrderReceiver;
  } = {},
): GuestCheckoutRuntime {
  const constructorSiteUrl = options.constructorSiteUrl ?? options.host?.siteUrl;
  const runtimeSiteUrl = options.runtimeSiteUrl ?? options.siteUrl;
  const topLevelSiteUrl = options.topLevelSiteUrl ?? options.host?.topLevelSiteUrl;
  const checkoutSiteUrl = options.checkoutSiteUrl ?? options.host?.checkoutSiteUrl;
  const resolved = resolveTrustedSiteOrigin({
    constructorSiteUrl,
    topLevelSiteUrl,
    checkoutSiteUrl,
    runtimeSiteUrl,
  });
  return {
    carts: storage[names.carts] as Pick<StorageCollection<CheckoutRecord>, "compareAndSet" | "getVersioned">,
    capabilities: storage[names.capabilities] as Pick<
      StorageCollection<GuestCapabilityRecord>,
      "compareAndSet" | "get" | "getVersioned"
    >,
    catalog: {
      catalog: storage[names.catalogItems] as Pick<StorageCollection<CatalogStorageRecord>, "get">,
      prices: storage[names.prices] as CatalogPriceStorage,
      backorderPolicies: storage[names.backorderPolicies] as CatalogBackorderPolicyStorage,
      configurations: storage[names.configurations] as StoreInventoryConfigurationStorage,
      settings: storage[names.settings] as StorefrontAvailabilitySettingsStorage,
      listing: names.listing
        ? storage[names.listing] as StorefrontOutOfStockListingStorage
        : undefined,
      manualAvailability: storage[names.manualAvailability] as CatalogManualAvailabilityStorage,
    },
    siteUrl: resolved.ok ? resolved.origin : undefined,
    constructorSiteUrl,
    runtimeSiteUrl,
    topLevelSiteUrl,
    checkoutSiteUrl,
    host: options.host ?? {},
    ...(options.paidOrders ? { paidOrders: options.paidOrders } : {}),
    ...(options.host?.pricing ? { pricing: {
      ...options.host.pricing,
      coupons: options.coupons,
    } } : {}),
    ...(names.paymentAssociations && storage[names.paymentAssociations]
      ? { paymentAssociations: createCheckoutPaymentAssociationPort(
        storage[names.paymentAssociations] as StorageCollection<CheckoutPaymentAssociation>,
      ) }
      : {}),
  };
}

export function admitBoundGuestCheckoutRuntime(
  ctx: {
    storage: Record<string, unknown>;
    request: { url: string; headers?: Headers | Record<string, string> };
    site?: { url?: string };
  },
  names: GuestCheckoutStorageNames,
  host: GuestCheckoutHostOptions = {},
  coupons?: CheckoutCouponPort,
  paidOrders?: PaidOrderReceiver,
): GuestCheckoutRuntime {
  const constructorSiteUrl = host.siteUrl;
  const runtimeSiteUrl = ctx.site?.url;
  const topLevelSiteUrl = host.topLevelSiteUrl;
  const checkoutSiteUrl = host.checkoutSiteUrl;
  const resolved = resolveTrustedSiteOrigin({
    constructorSiteUrl,
    topLevelSiteUrl,
    checkoutSiteUrl,
    runtimeSiteUrl,
  });
  if (!resolved.ok) throw new GuestCheckoutError("UNAVAILABLE");
  admitGuestCheckoutWrite({
    requestUrl: ctx.request.url,
    headers: ctx.request.headers,
    siteOrigin: resolved.origin,
  });
  return bindGuestCheckoutRuntime(ctx.storage, names, {
    siteUrl: resolved.origin,
    constructorSiteUrl,
    runtimeSiteUrl,
    topLevelSiteUrl,
    checkoutSiteUrl,
    host,
    coupons,
    paidOrders,
  });
}
