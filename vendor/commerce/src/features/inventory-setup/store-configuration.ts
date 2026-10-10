import { isRecord } from "../../shared/record.js";
import {
  InventoryProviderBindingError,
  normalizeInventoryProviderBinding,
} from "../inventory-provider/kernel/index.js";
import { InventorySetupError } from "./errors.js";
import { loadStoreInventoryConfiguration } from "./store-configuration-read.js";
import {
  STORE_INVENTORY_CONFIGURATIONS_COLLECTION,
  type CreateStoreInventoryConfigurationOptions,
  type CreateStoreInventoryConfigurationResult,
  type StoreInventoryConfigurationRecord,
  type StoreInventoryConfigurationStorage,
  type StoreInventoryConfigurationStorageRecord,
} from "./types.js";

export { loadStoreInventoryConfiguration } from "./store-configuration-read.js";

export type StoreInventoryConfigurationUniqueField = "configurationKey";

const COMMERCE_PLUGIN_ID = "dinkus-commerce";
const CONFIGURATION_KEY = "active" as const;
const INDEX_NAME =
  `uidx_plugin_${COMMERCE_PLUGIN_ID}_${STORE_INVENTORY_CONFIGURATIONS_COLLECTION}_configurationKey`;

function fail(
  code: "INVALID_CONFIGURATION" | "STORAGE_CONSTRAINTS_UNAVAILABLE" | "STORAGE_UNAVAILABLE",
  message: string,
  cause?: unknown,
): InventorySetupError {
  return new InventorySetupError(code, message, cause === undefined ? undefined : { cause });
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw fail("INVALID_CONFIGURATION", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeConfigurationInput(value: unknown) {
  if (!isRecord(value)) {
    throw fail("INVALID_CONFIGURATION", "inventory configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "providerRef",
    "poolId",
    "defaultFulfillmentLocationId",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw fail(
      "INVALID_CONFIGURATION",
      "inventory configuration contains a caller-controlled field",
    );
  }
  try {
    return normalizeInventoryProviderBinding(input);
  } catch (error) {
    if (error instanceof InventoryProviderBindingError) {
      throw fail("INVALID_CONFIGURATION", error.message, error);
    }
    throw error;
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    chain.push(current);
    if (typeof current !== "object" || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function isConfigurationKeyViolation(error: unknown): boolean {
  let text = "";
  let named = false;
  let coded = false;
  for (const entry of errorChain(error)) {
    if (entry instanceof Error) text += `\n${entry.message}`;
    if (typeof entry === "object" && entry !== null) {
      const object = entry as Record<string, unknown>;
      text += `\n${String(object.message ?? "")}`;
      named ||= object.constraint === INDEX_NAME || object.index === INDEX_NAME;
      coded ||= ["23505", "SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE"].includes(
        String(object.code ?? ""),
      );
    }
  }
  named ||= text.includes(INDEX_NAME);
  return (
    named &&
    (coded ||
      /unique constraint failed/i.test(text) ||
      /duplicate key value violates unique constraint/i.test(text))
  );
}

export function storeInventoryConfigurationUniqueIndexName(
  field: StoreInventoryConfigurationUniqueField,
): string {
  if (field !== "configurationKey") {
    throw fail("INVALID_CONFIGURATION", "unknown inventory configuration unique field");
  }
  return INDEX_NAME;
}

function makeProbe(
  recordId: string,
  configurationKey: string,
): StoreInventoryConfigurationStorageRecord {
  return {
    recordKind: "store-inventory-configuration-probe",
    recordId,
    configurationKey,
    siteId: `probe-site-${recordId}`,
    binding: {
      providerRef: `probe-provider-${recordId}`,
      poolId: `probe-pool-${recordId}`,
      defaultFulfillmentLocationId: `probe-location-${recordId}`,
    },
    configuredAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

async function assertConfigurationKeyConstraint(
  storage: StoreInventoryConfigurationStorage,
): Promise<void> {
  const token = globalThis.crypto.randomUUID();
  const key = `__DINKUS_STORE_CONFIGURATION_PROBE__${token}`;
  const records = [
    makeProbe(`configuration-probe-left-${token}`, key),
    makeProbe(`configuration-probe-right-${token}`, key),
  ];
  const attempted: StoreInventoryConfigurationStorageRecord[] = [];
  try {
    for (const record of records) {
      attempted.push(record);
      try {
        await storage.put(record.recordId, record);
      } catch (error) {
        if (isConfigurationKeyViolation(error)) return;
        throw fail(
          "STORAGE_CONSTRAINTS_UNAVAILABLE",
          "store inventory configuration uniqueness could not be proven",
          error,
        );
      }
    }
    throw fail(
      "STORAGE_CONSTRAINTS_UNAVAILABLE",
      "store inventory configuration unique constraint is not active",
    );
  } finally {
    let cleanupCause: unknown;
    for (const record of attempted.reverse()) {
      try {
        await storage.delete(record.recordId);
      } catch (error) {
        cleanupCause ??= error;
      }
    }
    if (cleanupCause !== undefined) {
      throw fail(
        "STORAGE_CONSTRAINTS_UNAVAILABLE",
        "store inventory configuration probe cleanup failed",
        cleanupCause,
      );
    }
  }
}

function resolveExisting(
  configuration: StoreInventoryConfigurationRecord,
  requested: ReturnType<typeof normalizeInventoryProviderBinding>,
  storage: StoreInventoryConfigurationStorage,
  now: () => Date,
): Promise<CreateStoreInventoryConfigurationResult> | CreateStoreInventoryConfigurationResult {
  if (
    configuration.binding.providerRef !== requested.providerRef ||
    configuration.binding.poolId !== requested.poolId
  ) {
    return { outcome: "migration-required", configuration };
  }
  if (
    configuration.binding.defaultFulfillmentLocationId ===
    requested.defaultFulfillmentLocationId
  ) {
    return { outcome: "existing", configuration };
  }
  const updated: StoreInventoryConfigurationRecord = {
    ...configuration,
    binding: requested,
    updatedAt: now().toISOString(),
  };
  return storage
    .put(updated.recordId, updated)
    .then(() => ({ outcome: "location-updated" as const, configuration: updated }))
    .catch((error: unknown) => {
      throw fail("STORAGE_UNAVAILABLE", "store inventory configuration update failed", error);
    });
}

export async function createStoreInventoryConfiguration(
  storage: StoreInventoryConfigurationStorage,
  rawBinding: unknown,
  options: CreateStoreInventoryConfigurationOptions = {},
): Promise<CreateStoreInventoryConfigurationResult> {
  const requested = normalizeConfigurationInput(rawBinding);
  const now = options.now ?? (() => new Date());
  const existing = await loadStoreInventoryConfiguration(storage);
  if (existing) return resolveExisting(existing, requested, storage, now);

  await assertConfigurationKeyConstraint(storage);
  const timestamp = now().toISOString();
  const configuration: StoreInventoryConfigurationRecord = {
    recordKind: "store-inventory-configuration",
    recordId: asNonEmptyString(
      (options.createRecordId ?? (() => globalThis.crypto.randomUUID()))(),
      "recordId",
    ),
    configurationKey: CONFIGURATION_KEY,
    siteId: asNonEmptyString(
      (options.createSiteId ?? (() => globalThis.crypto.randomUUID()))(),
      "siteId",
    ),
    binding: requested,
    configuredAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    await storage.put(configuration.recordId, configuration);
    return { outcome: "created", configuration };
  } catch (error) {
    if (!isConfigurationKeyViolation(error)) {
      throw fail("STORAGE_UNAVAILABLE", "store inventory configuration write failed", error);
    }
    const winner = await loadStoreInventoryConfiguration(storage);
    if (!winner) {
      throw fail(
        "STORAGE_CONSTRAINTS_UNAVAILABLE",
        "store inventory configuration winner could not be loaded",
        error,
      );
    }
    return resolveExisting(winner, requested, storage, now);
  }
}
