import { isRecord } from "../../shared/record.js";
import { CatalogError } from "./errors.js";

/** Optional merchant-supplied product identifiers. Absent means omitted; never invent. */
export interface CatalogProductIdentifiers {
  readonly gtin?: string;
  readonly mpn?: string;
  readonly brand?: string;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Validate GTIN-8/12/13/14 with GS1 check digit.
 * Accepts common formatting separators; stores/emits digits only.
 */
export function normalizeGtin(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CatalogError("INVALID_INPUT", "gtin must be a string");
  }
  const digits = digitsOnly(raw.trim());
  if (![8, 12, 13, 14].includes(digits.length)) {
    throw new CatalogError("INVALID_INPUT", "gtin must be GTIN-8, GTIN-12, GTIN-13, or GTIN-14");
  }
  let sum = 0;
  for (let i = 0; i < digits.length - 1; i += 1) {
    const digit = digits.charCodeAt(i) - 48;
    const fromRight = digits.length - 1 - i;
    sum += fromRight % 2 === 0 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  if (check !== digits.charCodeAt(digits.length - 1) - 48) {
    throw new CatalogError("INVALID_INPUT", "gtin check digit is invalid");
  }
  return digits;
}

function normalizeOptionalText(raw: unknown, label: string, max = 256): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new CatalogError("INVALID_INPUT", `${label} must be a string`);
  }
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > max) {
    throw new CatalogError("INVALID_INPUT", `${label} exceeds ${max} characters`);
  }
  return value;
}

/**
 * Normalize optional identifier fields from a write body.
 * Explicit null/empty clears a field; omitted keys leave existing values alone when merging.
 */
export function normalizeIdentifierPatch(raw: unknown): {
  gtin?: string | null;
  mpn?: string | null;
  brand?: string | null;
} {
  if (!isRecord(raw)) {
    throw new CatalogError("INVALID_INPUT", "identifiers input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set(["gtin", "mpn", "brand"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new CatalogError("INVALID_INPUT", `unknown identifier field: ${key}`);
    }
  }
  const patch: { gtin?: string | null; mpn?: string | null; brand?: string | null } = {};
  if ("gtin" in input) {
    patch.gtin =
      input.gtin === null || input.gtin === ""
        ? null
        : normalizeGtin(input.gtin);
  }
  if ("mpn" in input) {
    patch.mpn =
      input.mpn === null || input.mpn === ""
        ? null
        : (normalizeOptionalText(input.mpn, "mpn") ?? null);
  }
  if ("brand" in input) {
    patch.brand =
      input.brand === null || input.brand === ""
        ? null
        : (normalizeOptionalText(input.brand, "brand") ?? null);
  }
  if (!Object.keys(patch).length) {
    throw new CatalogError("INVALID_INPUT", "identifiers requires at least one of gtin, mpn, brand");
  }
  return patch;
}

export { projectIdentifiers } from "./project-identifiers.js";
