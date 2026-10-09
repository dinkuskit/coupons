import { StorefrontAvailabilityError } from "./errors.js";
import {
  DEFAULT_STOREFRONT_AVAILABILITY_POLICY,
  normalizeStorefrontAvailabilityPolicy,
  sameStorefrontAvailabilityPolicy,
} from "./policy.js";
import {
  STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID,
  type SetStorefrontAvailabilityPolicyOptions,
  type SetStorefrontAvailabilityPolicyResult,
  type StorefrontAvailabilityDisplayPolicy,
  type StorefrontAvailabilitySettingsRecord,
  type StorefrontAvailabilitySettingsStorage,
} from "./types.js";

function defaultSettings(): StorefrontAvailabilitySettingsRecord {
  return {
    recordKind: "storefront-availability-settings",
    recordId: STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID,
    policy: DEFAULT_STOREFRONT_AVAILABILITY_POLICY,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function normalizeStoredSettings(
  value: StorefrontAvailabilitySettingsRecord | null,
): StorefrontAvailabilitySettingsRecord {
  if (value === null) return defaultSettings();
  if (
    value.recordKind !== "storefront-availability-settings" ||
    value.recordId !== STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID ||
    typeof value.updatedAt !== "string" ||
    value.updatedAt.trim().length === 0
  ) {
    throw new StorefrontAvailabilityError(
      "STORAGE_UNAVAILABLE",
      "stored storefront availability settings are invalid",
    );
  }
  try {
    return {
      ...value,
      policy: normalizeStorefrontAvailabilityPolicy(value.policy),
      updatedAt: value.updatedAt.trim(),
    };
  } catch (error) {
    if (error instanceof StorefrontAvailabilityError) {
      throw new StorefrontAvailabilityError(
        "STORAGE_UNAVAILABLE",
        "stored storefront availability settings are invalid",
      );
    }
    throw error;
  }
}

export async function loadStorefrontAvailabilityPolicy(
  storage: StorefrontAvailabilitySettingsStorage,
): Promise<StorefrontAvailabilityDisplayPolicy> {
  let stored: StorefrontAvailabilitySettingsRecord | null;
  try {
    stored = await storage.get(STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID);
  } catch {
    throw new StorefrontAvailabilityError(
      "STORAGE_UNAVAILABLE",
      "storefront availability settings lookup failed",
    );
  }
  return normalizeStoredSettings(stored).policy;
}

export async function setStorefrontAvailabilityPolicy(
  storage: StorefrontAvailabilitySettingsStorage,
  rawPolicy: unknown,
  options: SetStorefrontAvailabilityPolicyOptions = {},
): Promise<SetStorefrontAvailabilityPolicyResult> {
  const policy = normalizeStorefrontAvailabilityPolicy(rawPolicy);
  let stored: StorefrontAvailabilitySettingsRecord | null;
  try {
    stored = await storage.get(STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID);
  } catch {
    throw new StorefrontAvailabilityError(
      "STORAGE_UNAVAILABLE",
      "storefront availability settings lookup failed",
    );
  }
  const settings = normalizeStoredSettings(stored);
  if (sameStorefrontAvailabilityPolicy(settings.policy, policy)) {
    return { changed: false, settings };
  }
  const updated: StorefrontAvailabilitySettingsRecord = {
    recordKind: "storefront-availability-settings",
    recordId: STOREFRONT_AVAILABILITY_SETTINGS_RECORD_ID,
    policy,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  try {
    await storage.put(updated.recordId, updated);
  } catch {
    throw new StorefrontAvailabilityError(
      "STORAGE_UNAVAILABLE",
      "storefront availability settings update failed",
    );
  }
  return { changed: true, settings: updated };
}
