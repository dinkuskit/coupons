import type { StorageCollection } from "emdash";

import { normalizeManagedSkuRegistrationClaimRecord } from "./claim.js";
import {
  MANAGED_SKU_REGISTRATION_CLAIMS_COLLECTION,
  type ManagedSkuRegistrationClaimUniqueField,
} from "./claim-constants.js";
import { ManagedSkuRegistrationError } from "./registration-errors.js";
import { normalizeManagedSkuRegistration } from "./registration-normalize.js";
import type {
  ManagedSkuRegistrationClaimInput,
  ManagedSkuRegistrationClaimPort,
  ManagedSkuRegistrationClaimRecord,
  ManagedSkuRegistrationRequest,
} from "./types.js";

export {
  MANAGED_SKU_REGISTRATION_CLAIMS_COLLECTION,
  MANAGED_SKU_REGISTRATION_CLAIM_UNIQUE_INDEXES,
  type ManagedSkuRegistrationClaimUniqueField,
} from "./claim-constants.js";

const COMMERCE_PLUGIN_ID = "dinkus-commerce";
const INDEX_NAMES: Record<ManagedSkuRegistrationClaimUniqueField, string> = {
  claimKey: `uidx_plugin_${COMMERCE_PLUGIN_ID}_${MANAGED_SKU_REGISTRATION_CLAIMS_COLLECTION}_claimKey`,
  operationId: `uidx_plugin_${COMMERCE_PLUGIN_ID}_${MANAGED_SKU_REGISTRATION_CLAIMS_COLLECTION}_operationId`,
};

export type ManagedSkuRegistrationClaimStorage = Pick<
  StorageCollection<ManagedSkuRegistrationClaimRecord>,
  "delete" | "put" | "query"
>;

export interface ManagedSkuRegistrationClaimPortOptions {
  createRecordId?: () => string;
  now?: () => Date;
}

function unavailable(message: string, cause?: unknown): ManagedSkuRegistrationError {
  const error = new ManagedSkuRegistrationError(
    "REGISTRATION_CLAIM_UNAVAILABLE",
    message,
  );
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unavailable(`${field} must be a non-empty string`);
  }
  return value.trim();
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
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function isNamedUniqueViolation(
  error: unknown,
  field: ManagedSkuRegistrationClaimUniqueField,
): boolean {
  const expectedIndex = INDEX_NAMES[field];
  const text = errorText(error);
  const properties = errorProperties(error);
  const namesExpectedIndex =
    text.includes(expectedIndex) ||
    properties.some(
      (entry) =>
        entry.constraint === expectedIndex || entry.index === expectedIndex,
    );
  if (!namesExpectedIndex) return false;

  const hasPostgresCode = properties.some(
    (entry) => String(entry.code ?? "") === "23505",
  );
  const hasSqliteCode = properties.some((entry) =>
    ["SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE"].includes(
      String(entry.code ?? ""),
    ),
  );
  const namesUniqueFailure =
    /unique constraint failed/i.test(text) ||
    /duplicate key value violates unique constraint/i.test(text) ||
    /SQLITE_CONSTRAINT(?:_UNIQUE)?/i.test(text);

  return hasPostgresCode || hasSqliteCode || namesUniqueFailure;
}

export function identifyManagedSkuRegistrationClaimUniqueViolation(
  error: unknown,
): ManagedSkuRegistrationClaimUniqueField | null {
  if (isNamedUniqueViolation(error, "claimKey")) return "claimKey";
  if (isNamedUniqueViolation(error, "operationId")) return "operationId";
  return null;
}

export function managedSkuRegistrationClaimUniqueIndexName(
  field: ManagedSkuRegistrationClaimUniqueField,
): string {
  return INDEX_NAMES[field];
}

function makeProbe(
  recordId: string,
  claimKey: string,
  operationId: string,
): ManagedSkuRegistrationClaimRecord {
  return {
    recordKind: "managed-sku-registration-claim",
    recordId,
    claimKey,
    catalogItemId: `__DINKUS_REGISTRATION_CLAIM_PROBE_PRODUCT__${recordId}`,
    operationId,
    request: {
      poolId: `__DINKUS_REGISTRATION_CLAIM_PROBE_POOL__${recordId}`,
      sku: `__DINKUS_REGISTRATION_CLAIM_PROBE_SKU__${recordId}`,
      displayNameIfNew: "DinkusKit registration claim integrity probe",
    },
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

function makeProbes(
  field: ManagedSkuRegistrationClaimUniqueField,
): [ManagedSkuRegistrationClaimRecord, ManagedSkuRegistrationClaimRecord] {
  const token = globalThis.crypto.randomUUID();
  if (field === "claimKey") {
    const claimKey = `__DINKUS_REGISTRATION_CLAIM_PROBE_KEY__${token}`;
    return [
      makeProbe(`probe-claim-left-${token}`, claimKey, `probe-operation-left-${token}`),
      makeProbe(`probe-claim-right-${token}`, claimKey, `probe-operation-right-${token}`),
    ];
  }

  const operationId = `__DINKUS_REGISTRATION_CLAIM_PROBE_OPERATION__${token}`;
  return [
    makeProbe(`probe-operation-left-${token}`, `probe-key-left-${token}`, operationId),
    makeProbe(`probe-operation-right-${token}`, `probe-key-right-${token}`, operationId),
  ];
}

async function proveUniqueIndex(
  storage: ManagedSkuRegistrationClaimStorage,
  field: ManagedSkuRegistrationClaimUniqueField,
): Promise<void> {
  const [left, right] = makeProbes(field);
  const attempted: ManagedSkuRegistrationClaimRecord[] = [];

  try {
    attempted.push(left);
    try {
      await storage.put(left.recordId, left);
    } catch (error) {
      if (isNamedUniqueViolation(error, field)) return;
      throw unavailable(`registration claim ${field} uniqueness could not be proven`, error);
    }

    attempted.push(right);
    try {
      await storage.put(right.recordId, right);
    } catch (error) {
      if (isNamedUniqueViolation(error, field)) return;
      throw unavailable(`registration claim ${field} uniqueness could not be proven`, error);
    }

    throw unavailable(`registration claim ${field} unique constraint is not active`);
  } finally {
    let cleanupCause: unknown;
    for (const probe of attempted.reverse()) {
      try {
        await storage.delete(probe.recordId);
      } catch (error) {
        cleanupCause ??= error;
      }
    }
    if (cleanupCause !== undefined) {
      throw unavailable(
        `registration claim ${field} uniqueness probe cleanup failed`,
        cleanupCause,
      );
    }
  }
}

export async function assertManagedSkuRegistrationClaimStorageConstraints(
  storage: ManagedSkuRegistrationClaimStorage,
): Promise<void> {
  await proveUniqueIndex(storage, "claimKey");
  await proveUniqueIndex(storage, "operationId");
}

function normalizeClaimInput(input: ManagedSkuRegistrationClaimInput): {
  claimKey: string;
  catalogItemId: string;
  operationId: string;
  request: ManagedSkuRegistrationRequest;
} {
  const registration = normalizeManagedSkuRegistration(input.registration);
  return {
    claimKey: asNonEmptyString(input.claimKey, "claimKey"),
    catalogItemId: asNonEmptyString(input.catalogItemId, "catalogItemId"),
    operationId: registration.operationId,
    request: registration.request,
  };
}

async function loadUniqueClaim(
  storage: ManagedSkuRegistrationClaimStorage,
  field: ManagedSkuRegistrationClaimUniqueField,
  value: string,
): Promise<ManagedSkuRegistrationClaimRecord> {
  let result;
  try {
    result = await storage.query({ where: { [field]: value }, limit: 2 });
  } catch (error) {
    throw unavailable("registration claim winner lookup failed", error);
  }
  if (result.items.length !== 1 || result.hasMore) {
    throw unavailable("registration claim winner is ambiguous");
  }
  const claim = normalizeManagedSkuRegistrationClaimRecord(result.items[0]?.data);
  if (claim[field] !== value) {
    throw unavailable("registration claim winner does not match its unique key");
  }
  return claim;
}

function sameRequest(left: ManagedSkuRegistrationRequest, right: ManagedSkuRegistrationRequest) {
  return (
    left.poolId === right.poolId &&
    left.sku === right.sku &&
    left.displayNameIfNew === right.displayNameIfNew
  );
}

export function createManagedSkuRegistrationClaimPort(
  storage: ManagedSkuRegistrationClaimStorage,
  options: ManagedSkuRegistrationClaimPortOptions = {},
): ManagedSkuRegistrationClaimPort {
  const createRecordId =
    options.createRecordId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  return {
    async claim(rawInput) {
      const input = normalizeClaimInput(rawInput);
      await assertManagedSkuRegistrationClaimStorageConstraints(storage);

      const record: ManagedSkuRegistrationClaimRecord = {
        recordKind: "managed-sku-registration-claim",
        recordId: asNonEmptyString(createRecordId(), "recordId"),
        claimKey: input.claimKey,
        catalogItemId: input.catalogItemId,
        operationId: input.operationId,
        request: input.request,
        createdAt: now().toISOString(),
      };

      try {
        await storage.put(record.recordId, record);
        return { outcome: "claimed", claim: record };
      } catch (error) {
        const uniqueField = identifyManagedSkuRegistrationClaimUniqueViolation(error);
        if (!uniqueField) {
          throw unavailable("registration claim write failed", error);
        }

        const winner = await loadUniqueClaim(storage, uniqueField, record[uniqueField]);
        if (winner.catalogItemId !== input.catalogItemId) {
          throw unavailable("registration claim winner belongs to another catalog item");
        }
        if (
          uniqueField === "operationId" &&
          (winner.claimKey !== input.claimKey || !sameRequest(winner.request, input.request))
        ) {
          throw unavailable("registration operation ID conflicts with another claim");
        }
        return { outcome: "existing", claim: winner };
      }
    },
  };
}
