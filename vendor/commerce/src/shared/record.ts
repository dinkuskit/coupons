/** A non-null, non-array object, as JSON object input or a stored record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The object's own enumerable keys, sorted and comma-joined, for exact-shape checks. */
export function sortedKeys(value: object): string {
  return Object.keys(value).sort().join();
}

/** JSON with object keys sorted, so the same contents compare equal whatever their key order. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => isRecord(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
}
