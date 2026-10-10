import { isRecord } from "../../shared/record.js";
import { catalogFail } from "./errors.js";
import { createInitialStockManagement } from "../inventory-provider/kernel/index.js";
import type {
  CatalogFulfillment,
  CreateCatalogItemInput,
  NormalizedCreateCatalogItemInput,
} from "./types.js";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SKU_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const ASCII_PATTERN = /^[\x00-\x7F]*$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    catalogFail("INVALID_INPUT", `${field} must be a string`);
  }
  return value;
}

export function normalizeSku(value: unknown): string {
  const normalized = requireString(value, "sku").normalize("NFKC").trim();
  if (!ASCII_PATTERN.test(normalized)) {
    catalogFail("INVALID_INPUT", "sku must contain ASCII characters only");
  }

  const canonical = normalized.toUpperCase();
  if (canonical.length < 1 || canonical.length > 64) {
    catalogFail("INVALID_INPUT", "sku must be between 1 and 64 characters");
  }
  if (!SKU_PATTERN.test(canonical)) {
    catalogFail("INVALID_INPUT", "sku must be uppercase alphanumeric hyphen segments",);
  }
  return canonical;
}

export function normalizeCreateCatalogItemInput(
  input: unknown,
): NormalizedCreateCatalogItemInput {
  if (!isRecord(input)) {
    catalogFail("INVALID_INPUT", "request body must be an object");
  }

  const candidate = input as Partial<CreateCatalogItemInput>;
  const commandId = requireString(candidate.commandId, "commandId");
  if (commandId.trim() !== commandId || !COMMAND_ID_PATTERN.test(commandId)) {
    catalogFail("INVALID_INPUT", "commandId must be 1-128 ASCII [A-Za-z0-9:_-]",);
  }

  const name = requireString(candidate.name, "name").normalize("NFKC").trim();
  if (name.length < 1 || name.length > 160 || CONTROL_PATTERN.test(name)) {
    catalogFail("INVALID_INPUT", "name must be 1-160 characters without controls",);
  }

  const sku = normalizeSku(candidate.sku);
  const manageStock = Object.hasOwn(candidate, "manageStock")
    ? candidate.manageStock
    : false;
  if (typeof manageStock !== "boolean") {
    catalogFail("INVALID_INPUT", "manageStock must be a boolean");
  }
  const fulfillment = candidate.fulfillment;
  if (
    fulfillment !== undefined &&
    fulfillment !== "physical" &&
    fulfillment !== "digital"
  ) {
    catalogFail("INVALID_INPUT", "fulfillment must be physical or digital");
  }
  return {
    commandId,
    creationIntent: { manageStock },
    kind: "simple-product",
    name,
    sku,
    skuKey: sku,
    stockManagement: createInitialStockManagement(manageStock),
    ...(fulfillment === undefined ? {} : { fulfillment: fulfillment as CatalogFulfillment }),
  };
}
