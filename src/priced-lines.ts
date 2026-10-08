import { CatalogError, normalizeMoney, parseMinorUnits, type CouponCatalogStorage, type Money } from "./core.js";
import { ServiceError } from "./errors.js";

/**
 * One line of the shopper's cart as Commerce priced it from its own catalog.
 * `regular` and `sale` are Commerce's catalog price record for the product, so
 * the evaluator applies the same "customer pays" and sale-item rules it applies
 * inside Commerce. Shipping and tax are never lines.
 */
export interface PricedLine {
  readonly productId: string;
  readonly quantity: number;
  readonly regular: Money;
  readonly sale?: Money;
}

export const MAX_LINES = 100;
const LINE_KEYS = new Set(["productId", "quantity", "regular", "sale"]);

function invalid(message: string): never {
  throw new ServiceError(400, "INVALID_INPUT", message);
}

function money(value: unknown, label: string): Money {
  try {
    return normalizeMoney(value, label);
  } catch (error) {
    if (error instanceof CatalogError) invalid(error.message);
    throw error;
  }
}

export function parsePricedLines(value: unknown): PricedLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LINES) {
    invalid(`lines must be an array of 1 to ${MAX_LINES} priced lines`);
  }
  return value.map((line, index) => {
    if (typeof line !== "object" || line === null || Array.isArray(line)) invalid(`lines[${index}] must be an object`);
    const record = line as Record<string, unknown>;
    if (Object.keys(record).some(key => !LINE_KEYS.has(key))) {
      invalid(`lines[${index}] accepts only productId, quantity, regular and sale`);
    }
    if (typeof record.productId !== "string" || record.productId.trim() === "" || record.productId.length > 200) {
      invalid(`lines[${index}].productId must be a non-empty string`);
    }
    if (typeof record.quantity !== "number" || !Number.isSafeInteger(record.quantity) || record.quantity <= 0) {
      invalid(`lines[${index}].quantity must be a positive safe integer`);
    }
    const regular = money(record.regular, `lines[${index}].regular`);
    const sale = record.sale === undefined ? undefined : money(record.sale, `lines[${index}].sale`);
    if (sale && parseMinorUnits(sale.minor) >= parseMinorUnits(regular.minor)) {
      invalid(`lines[${index}].sale must be lower than regular`);
    }
    return { productId: record.productId.trim(), quantity: record.quantity, regular, ...(sale ? { sale } : {}) };
  });
}

/**
 * The evaluator reads products and prices through storage ports. Here those
 * ports answer only from the lines Commerce sent, so the service can never
 * see or invent a price Commerce did not charge.
 */
export function pricedLineStorage(lines: readonly PricedLine[]): CouponCatalogStorage {
  const prices = new Map<string, { regular: Money; sale?: Money }>();
  for (const line of lines) {
    const known = prices.get(line.productId);
    const price = { regular: line.regular, ...(line.sale ? { sale: line.sale } : {}) };
    if (known && JSON.stringify(known) !== JSON.stringify(price)) {
      invalid(`product ${line.productId} appears with two different prices`);
    }
    prices.set(line.productId, price);
  }
  const readOnly = async (): Promise<never> => {
    throw new Error("priced-line storage is read-only");
  };
  return {
    catalog: {
      get: async (id: string) => (prices.has(id) ? { recordKind: "catalog-item", itemId: id } : null) as never,
    },
    prices: {
      get: async (id: string) => {
        const price = prices.get(id);
        return price ? { recordKind: "catalog-price", recordId: id, catalogItemId: id, ...price } : null;
      },
      getVersioned: readOnly,
      put: readOnly,
      delete: readOnly,
      compareAndSet: readOnly,
      compareAndDelete: readOnly,
    },
  };
}
