export const INVENTORY_PROVIDER_FEATURE_ID = "dinkus.inventory-provider";

export interface InventoryProviderBindingInput {
  providerRef: string;
  poolId: string;
  defaultFulfillmentLocationId: string;
}

export interface InventoryProviderBinding {
  providerRef: string;
  poolId: string;
  defaultFulfillmentLocationId: string;
}

export interface UnmanagedStockManagement {
  mode: "unmanaged";
}

export type ManagedStockStatus =
  | "setup-required"
  | "setup-pending"
  | "setup-needs-attention"
  | "needs-review"
  | "active";

export interface SetupRequiredManagedStockManagement {
  mode: "managed";
  status: "setup-required";
}

export interface ManagedSkuRegistration {
  operationId: string;
  request: ManagedSkuRegistrationRequest;
}

export interface SetupPendingManagedStockManagement {
  mode: "managed";
  status: "setup-pending";
  registration: ManagedSkuRegistration;
}

export interface ManagedSkuRegistrationRejection {
  code: string;
  message: string;
}

export interface SetupNeedsAttentionManagedStockManagement {
  mode: "managed";
  status: "setup-needs-attention";
  registration: ManagedSkuRegistration;
  rejection: ManagedSkuRegistrationRejection;
}

export interface InventorySkuIdentity {
  inventorySkuId: string;
  sku: string;
  displayName: string;
}

export interface NeedsReviewManagedStockManagement {
  mode: "managed";
  status: "needs-review";
  candidate: InventorySkuIdentity;
}

export interface ActiveManagedStockManagement {
  mode: "managed";
  status: "active";
  inventorySkuId: string;
}

export type ManagedStockManagement =
  | SetupRequiredManagedStockManagement
  | SetupPendingManagedStockManagement
  | SetupNeedsAttentionManagedStockManagement
  | NeedsReviewManagedStockManagement
  | ActiveManagedStockManagement;

export type StockManagement = UnmanagedStockManagement | ManagedStockManagement;

export interface ManagedSkuRegistrationInput {
  sku: string;
  productTitle?: string | null;
}

export interface ManagedSkuRegistrationRequest {
  poolId: string;
  sku: string;
  displayNameIfNew: string;
}

export interface ManagedSkuRegistrationClaimRecord {
  recordKind: "managed-sku-registration-claim";
  recordId: string;
  claimKey: string;
  catalogItemId: string;
  operationId: string;
  request: ManagedSkuRegistrationRequest;
  createdAt: string;
}

export interface ManagedSkuRegistrationClaimInput {
  claimKey: string;
  catalogItemId: string;
  registration: ManagedSkuRegistration;
}

export type ManagedSkuRegistrationClaimResult =
  | {
      outcome: "claimed";
      claim: ManagedSkuRegistrationClaimRecord;
    }
  | {
      outcome: "existing";
      claim: ManagedSkuRegistrationClaimRecord;
    };

export interface ManagedSkuRegistrationClaimPort {
  claim(
    input: ManagedSkuRegistrationClaimInput,
  ): Promise<ManagedSkuRegistrationClaimResult>;
}

export type StartManagedSkuRegistrationResult =
  | {
      outcome: "started";
      state: ManagedStockManagement;
    }
  | {
      outcome: "already-claimed";
      state: SetupPendingManagedStockManagement;
      sameRequest: boolean;
    };

export interface ConcurrentManagedSkuRegistrationFeedback {
  message: string;
  actionLabel: "Refresh status";
}

export interface ManagedSkuRegistrationUnavailableFeedback {
  message: "Inventory setup is temporarily unavailable. Please try again.";
}

export type ManagedSkuRegistrationResult =
  | {
      outcome: "registered";
      inventorySku: InventorySkuIdentity;
    }
  | {
      outcome: "existing";
      inventorySku: InventorySkuIdentity;
    }
  | {
      outcome: "rejected";
      code: string;
      message: string;
    };

export interface InventoryProviderPort {
  registerManagedSku(
    registration: ManagedSkuRegistration,
  ): Promise<ManagedSkuRegistrationResult>;
}

export type PersistManagedStockManagement = (
  state: ManagedStockManagement,
) => Promise<void>;

export interface ManagedSkuRegistrationExecution {
  persist: PersistManagedStockManagement;
  provider: InventoryProviderPort;
}

export interface StartManagedSkuRegistrationExecution
  extends ManagedSkuRegistrationExecution {
  catalogItemId: string;
  claimKey: string;
  claim: ManagedSkuRegistrationClaimPort["claim"];
  createOperationId?: () => string;
}
