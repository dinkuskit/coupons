import { isRecord } from "../../shared/record.js";
import { normalizeInventoryProviderBinding } from "./binding.js";
import {
  normalizeManagedSkuRegistrationClaimRecord,
  sameManagedSkuRegistrationRequest,
} from "./claim.js";
import { ManagedSkuRegistrationError } from "./registration-errors.js";
import {
  normalizeManagedSkuRegistration,
  normalizeManagedSkuRegistrationRejection,
} from "./registration-normalize.js";
import type {
  InventoryProviderBinding,
  InventorySkuIdentity,
  ManagedSkuRegistration,
  ManagedSkuRegistrationExecution,
  ManagedSkuRegistrationInput,
  ManagedSkuRegistrationRequest,
  ManagedSkuRegistrationRejection,
  ManagedSkuRegistrationResult,
  ManagedStockManagement,
  SetupPendingManagedStockManagement,
  StartManagedSkuRegistrationExecution,
  StartManagedSkuRegistrationResult,
  StockManagement,
} from "./types.js";

export {
  normalizeManagedSkuRegistration,
  normalizeManagedSkuRegistrationRejection,
} from "./registration-normalize.js";

function invalidRegistration(message: string): never {
  throw new ManagedSkuRegistrationError("INVALID_REGISTRATION", message);
}
function invalidTransition(message: string): never {
  throw new ManagedSkuRegistrationError("INVALID_TRANSITION", message);
}
function claimUnavailable(message: string): never {
  throw new ManagedSkuRegistrationError("REGISTRATION_CLAIM_UNAVAILABLE", message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalidRegistration(`${field} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidRegistration(`${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function normalizeInventorySkuIdentity(value: unknown): InventorySkuIdentity {
  const candidate = asRecord(value, "inventorySku");
  return {
    inventorySkuId: asNonEmptyString(candidate.inventorySkuId, "inventorySku.inventorySkuId"),
    sku: asNonEmptyString(candidate.sku, "inventorySku.sku"),
    displayName: asNonEmptyString(candidate.displayName, "inventorySku.displayName"),
  };
}

export function createManagedSkuRegistrationRequest(
  binding: InventoryProviderBinding,
  input: ManagedSkuRegistrationInput,
): ManagedSkuRegistrationRequest {
  const normalizedBinding = normalizeInventoryProviderBinding(binding);
  const candidate = asRecord(input, "managed SKU registration input") as Partial<
    ManagedSkuRegistrationInput
  >;
  const sku = asNonEmptyString(candidate.sku, "sku");

  if (
    candidate.productTitle !== undefined &&
    candidate.productTitle !== null &&
    typeof candidate.productTitle !== "string"
  ) {
    invalidRegistration("productTitle must be a string, null, or omitted",
    );
  }

  const productTitle = candidate.productTitle?.trim();
  return {
    poolId: normalizedBinding.poolId,
    sku,
    displayNameIfNew: productTitle || sku,
  };
}

export function normalizeManagedSkuRegistrationResult(
  value: unknown,
): ManagedSkuRegistrationResult {
  const candidate = asRecord(value, "managed SKU registration result");
  if (candidate.outcome === "rejected") {
    return {
      outcome: "rejected",
      ...normalizeManagedSkuRegistrationRejection(candidate),
    };
  }

  if (candidate.outcome !== "registered" && candidate.outcome !== "existing") {
    invalidRegistration("registration outcome must be registered, existing, or rejected",
    );
  }

  return {
    outcome: candidate.outcome,
    inventorySku: normalizeInventorySkuIdentity(candidate.inventorySku),
  };
}

export function applyManagedSkuRegistrationResult(
  current: StockManagement,
  result: ManagedSkuRegistrationResult,
): ManagedStockManagement {
  if (current.mode !== "managed" || current.status !== "setup-pending") {
    invalidTransition("managed SKU registration result requires setup-pending stock state",
    );
  }

  const registration = normalizeManagedSkuRegistration(current.registration);
  const normalizedResult = normalizeManagedSkuRegistrationResult(result);
  if (normalizedResult.outcome === "rejected") {
    return {
      mode: "managed",
      status: "setup-needs-attention",
      registration,
      rejection: {
        code: normalizedResult.code,
        message: normalizedResult.message,
      },
    };
  }

  if (normalizedResult.inventorySku.sku !== registration.request.sku) {
    invalidTransition("Inventory returned a different SKU than Commerce requested",
    );
  }

  if (normalizedResult.outcome === "registered") {
    return {
      mode: "managed",
      status: "active",
      inventorySkuId: normalizedResult.inventorySku.inventorySkuId,
    };
  }

  return {
    mode: "managed",
    status: "needs-review",
    candidate: normalizedResult.inventorySku,
  };
}

function normalizeExecution(
  value: ManagedSkuRegistrationExecution,
): ManagedSkuRegistrationExecution {
  const candidate = asRecord(value, "managed SKU registration execution");
  const provider = asRecord(candidate.provider, "inventory provider");
  if (typeof provider.registerManagedSku !== "function") {
    invalidRegistration("inventory provider must implement registerManagedSku",
    );
  }
  if (typeof candidate.persist !== "function") {
    invalidRegistration("persist must be a function",
    );
  }
  return value;
}

function createOperationId(
  execution: StartManagedSkuRegistrationExecution,
): string {
  if (
    execution.createOperationId !== undefined &&
    typeof execution.createOperationId !== "function"
  ) {
    invalidRegistration("createOperationId must be a function when supplied",
    );
  }
  const createId =
    execution.createOperationId ?? (() => globalThis.crypto.randomUUID());
  return asNonEmptyString(createId(), "operationId");
}

function normalizeStartExecution(
  value: StartManagedSkuRegistrationExecution,
): StartManagedSkuRegistrationExecution {
  const execution = normalizeExecution(value) as StartManagedSkuRegistrationExecution;
  if (typeof execution.claim !== "function") {
    claimUnavailable("registration claim authority is unavailable",
    );
  }
  asNonEmptyString(execution.catalogItemId, "catalogItemId");
  asNonEmptyString(execution.claimKey, "claimKey");
  return execution;
}

async function executePendingRegistration(
  pending: SetupPendingManagedStockManagement,
  rawExecution: ManagedSkuRegistrationExecution,
): Promise<ManagedStockManagement> {
  const execution = normalizeExecution(rawExecution);
  await execution.persist(pending);
  const result = await execution.provider.registerManagedSku(
    pending.registration,
  );
  const next = applyManagedSkuRegistrationResult(pending, result);
  await execution.persist(next);
  return next;
}

export async function startManagedSkuRegistration(
  current: StockManagement,
  binding: InventoryProviderBinding,
  input: ManagedSkuRegistrationInput,
  rawExecution: StartManagedSkuRegistrationExecution,
): Promise<StartManagedSkuRegistrationResult> {
  if (
    current.mode !== "managed" ||
    (current.status !== "setup-required" &&
      current.status !== "setup-needs-attention")
  ) {
    invalidTransition("managed SKU registration can start only from setup-required or setup-needs-attention",
    );
  }

  const execution = normalizeStartExecution(rawExecution);
  const operationId = createOperationId(execution);
  if (
    current.status === "setup-needs-attention" &&
    normalizeManagedSkuRegistration(current.registration).operationId === operationId
  ) {
    invalidTransition("corrected registration requires a new operationId",
    );
  }

  const pending: SetupPendingManagedStockManagement = {
    mode: "managed",
    status: "setup-pending",
    registration: {
      operationId,
      request: createManagedSkuRegistrationRequest(binding, input),
    },
  };

  let claimResult;
  try {
    claimResult = await execution.claim({
      claimKey: execution.claimKey,
      catalogItemId: execution.catalogItemId,
      registration: pending.registration,
    });
  } catch (error) {
    if (
      error instanceof ManagedSkuRegistrationError &&
      error.code === "REGISTRATION_CLAIM_UNAVAILABLE"
    ) {
      throw error;
    }
    claimUnavailable("registration claim authority is unavailable",
    );
  }

  if (claimResult.outcome !== "claimed" && claimResult.outcome !== "existing") {
    claimUnavailable("registration claim authority returned an invalid outcome",
    );
  }
  const claim = normalizeManagedSkuRegistrationClaimRecord(claimResult.claim);
  if (
    claim.claimKey !== execution.claimKey ||
    claim.catalogItemId !== execution.catalogItemId
  ) {
    claimUnavailable("registration claim authority returned a different claim scope",
    );
  }

  const claimedPending: SetupPendingManagedStockManagement = {
    mode: "managed",
    status: "setup-pending",
    registration: {
      operationId: claim.operationId,
      request: claim.request,
    },
  };
  const sameRequest = sameManagedSkuRegistrationRequest(
    claim.request,
    pending.registration.request,
  );

  if (claimResult.outcome === "existing") {
    return {
      outcome: "already-claimed",
      state: claimedPending,
      sameRequest,
    };
  }
  if (claim.operationId !== pending.registration.operationId || !sameRequest) {
    claimUnavailable("registration claim authority changed the winning operation",
    );
  }

  return {
    outcome: "started",
    state: await executePendingRegistration(claimedPending, execution),
  };
}

export async function retryManagedSkuRegistration(
  current: StockManagement,
  execution: ManagedSkuRegistrationExecution,
): Promise<ManagedStockManagement> {
  if (current.mode !== "managed" || current.status !== "setup-pending") {
    invalidTransition("managed SKU registration retry requires setup-pending stock state",
    );
  }

  return executePendingRegistration(
    {
      mode: "managed",
      status: "setup-pending",
      registration: normalizeManagedSkuRegistration(current.registration),
    },
    execution,
  );
}

export function confirmExistingManagedSku(
  current: StockManagement,
): ManagedStockManagement {
  if (current.mode !== "managed" || current.status !== "needs-review") {
    invalidTransition("existing SKU confirmation requires needs-review stock state",
    );
  }

  const candidate = normalizeInventorySkuIdentity(current.candidate);

  return {
    mode: "managed",
    status: "active",
    inventorySkuId: candidate.inventorySkuId,
  };
}
