import { CatalogError } from "./errors.js";
import {
  CATALOG_COLLECTION,
  COMMERCE_PLUGIN_ID,
  type CatalogIntegrityProbeRecord,
  type CatalogStorage,
} from "./types.js";

export type CatalogUniqueField = "commandId" | "skuKey";

const INDEX_NAMES: Record<CatalogUniqueField, string> = {
  commandId: `uidx_plugin_${COMMERCE_PLUGIN_ID}_${CATALOG_COLLECTION}_commandId`,
  skuKey: `uidx_plugin_${COMMERCE_PLUGIN_ID}_${CATALOG_COLLECTION}_skuKey`,
};

// These values are deliberately outside the caller-valid command and SKU grammars,
// so an operator-supplied identity can never collide with an integrity sentinel.
const PROBE_PREFIX = "__DINKUS_CATALOG_INTEGRITY_PROBE__";

function makeProbe(
  suffix: string,
  token: string,
  commandId: string,
  skuKey: string,
): CatalogIntegrityProbeRecord {
  return {
    recordKind: "integrity-probe",
    itemId: `__dinkus_catalog_${suffix}_${token}`,
    commandId,
    kind: "integrity-probe",
    name: "DinkusKit catalog storage integrity probe",
    sku: skuKey,
    skuKey,
    state: "internal",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

function makeProbes(
  field: CatalogUniqueField,
): [CatalogIntegrityProbeRecord, CatalogIntegrityProbeRecord] {
  const token = globalThis.crypto.randomUUID();
  if (field === "commandId") {
    const commandId = `${PROBE_PREFIX}:COMMAND:${token}`;
    return [
      makeProbe("command-left", token, commandId, `${PROBE_PREFIX}-COMMAND-LEFT-${token}`),
      makeProbe("command-right", token, commandId, `${PROBE_PREFIX}-COMMAND-RIGHT-${token}`),
    ];
  }

  const skuKey = `${PROBE_PREFIX}-SKU-${token}`;
  return [
    makeProbe("sku-left", token, `${PROBE_PREFIX}:SKU:LEFT:${token}`, skuKey),
    makeProbe("sku-right", token, `${PROBE_PREFIX}:SKU:RIGHT:${token}`, skuKey),
  ];
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

function errorText(error: unknown): string {
  return errorChain(error)
    .map((entry) => {
      if (entry instanceof Error) return entry.message;
      if (typeof entry === "object" && entry && "message" in entry) {
        return String((entry as { message?: unknown }).message ?? "");
      }
      return String(entry);
    })
    .join("\n");
}

function errorProperties(error: unknown): Array<Record<string, unknown>> {
  return errorChain(error).filter(
    (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
  );
}

export function isConfirmedUniqueViolation(
  error: unknown,
  field: CatalogUniqueField,
  collection: string = CATALOG_COLLECTION,
  pluginId: string = COMMERCE_PLUGIN_ID,
): boolean {
  const expectedIndex = `uidx_plugin_${pluginId}_${collection}_${field}`;
  const text = errorText(error);
  const properties = errorProperties(error);
  const namesExpectedIndex =
    text.includes(expectedIndex) ||
    properties.some((entry) => entry.constraint === expectedIndex || entry.index === expectedIndex);
  if (!namesExpectedIndex) return false;

  const hasPostgresCode = properties.some((entry) => String(entry.code ?? "") === "23505");
  const hasSqliteCode = properties.some((entry) =>
    ["SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE"].includes(String(entry.code ?? "")),
  );
  const namesUniqueFailure =
    /unique constraint failed/i.test(text) ||
    /duplicate key value violates unique constraint/i.test(text) ||
    /SQLITE_CONSTRAINT(?:_UNIQUE)?/i.test(text);

  return hasPostgresCode || hasSqliteCode || namesUniqueFailure;
}

export function identifyConfirmedUniqueViolation(error: unknown, collection: string = CATALOG_COLLECTION, pluginId: string = COMMERCE_PLUGIN_ID): CatalogUniqueField | null {
  if (isConfirmedUniqueViolation(error, "commandId", collection, pluginId)) return "commandId";
  if (isConfirmedUniqueViolation(error, "skuKey", collection, pluginId)) return "skuKey";
  return null;
}

async function proveUniqueIndex(storage: CatalogStorage, field: CatalogUniqueField, collection: string, pluginId: string): Promise<void> {
  const [left, right] = makeProbes(field);
  const attempted: CatalogIntegrityProbeRecord[] = [];

  try {
    attempted.push(left);
    try {
      await storage.put(left.itemId, left);
    } catch (error) {
      if (isConfirmedUniqueViolation(error, field, collection, pluginId)) return;
      throw new CatalogError(
        "STORAGE_CONSTRAINTS_UNAVAILABLE",
        `catalog ${field} uniqueness could not be proven`,
        { cause: error },
      );
    }

    attempted.push(right);
    try {
      await storage.put(right.itemId, right);
    } catch (error) {
      if (isConfirmedUniqueViolation(error, field, collection, pluginId)) return;
      throw new CatalogError(
        "STORAGE_CONSTRAINTS_UNAVAILABLE",
        `catalog ${field} uniqueness could not be proven`,
        { cause: error },
      );
    }

    throw new CatalogError(
      "STORAGE_CONSTRAINTS_UNAVAILABLE",
      `catalog ${field} unique constraint is not active`,
    );
  } finally {
    let cleanupFailed = false;
    let cleanupCause: unknown;
    for (const probe of attempted.reverse()) {
      try {
        await storage.delete(probe.itemId);
      } catch (error) {
        if (!cleanupFailed) cleanupCause = error;
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      throw new CatalogError(
        "STORAGE_CONSTRAINTS_UNAVAILABLE",
        `catalog ${field} uniqueness probe cleanup failed`,
        { cause: cleanupCause },
      );
    }
  }
}

export async function assertCatalogStorageConstraints(storage: CatalogStorage, collection: string = CATALOG_COLLECTION, pluginId: string = COMMERCE_PLUGIN_ID): Promise<void> {
  await proveUniqueIndex(storage, "commandId", collection, pluginId);
  await proveUniqueIndex(storage, "skuKey", collection, pluginId);
}

export function catalogUniqueIndexName(field: CatalogUniqueField): string {
  return INDEX_NAMES[field];
}
