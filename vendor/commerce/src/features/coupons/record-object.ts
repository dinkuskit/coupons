/** Shared structural admission; callers retain their own errors and field validation. */
export function recordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
