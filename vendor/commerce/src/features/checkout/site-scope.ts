const TRUSTED_SCHEMES = new Set(["http:", "https:"]);

export function presentSiteUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Canonical HTTP(S) origin. Rejects credentials, non-http(s) schemes,
 * empty/ambiguous hosts, and unparseable syntax. Path/query/hash are
 * discarded; default ports are normalized by `URL.origin``.
 */
export function canonicalizeHttpOrigin(value: string | undefined): string | null {
  const trimmed = presentSiteUrl(value);
  if (trimmed === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!TRUSTED_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (trimmed.includes("@")) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "." || hostname.includes(" ") || hostname.includes("\t")) {
    return null;
  }
  if (parsed.origin === "null") return null;
  return parsed.origin;
}

export interface ResolveTrustedSiteOriginInput {
  constructorSiteUrl?: string;
  runtimeSiteUrl?: string;
  topLevelSiteUrl?: string;
  checkoutSiteUrl?: string;
}

export function resolveTrustedSiteOrigin(
  input: ResolveTrustedSiteOriginInput,
): { ok: true; origin: string } | { ok: false } {
  let topOrigin: string | undefined;
  if (input.topLevelSiteUrl !== undefined) {
    const raw = presentSiteUrl(input.topLevelSiteUrl);
    if (raw === undefined) return { ok: false };
    const origin = canonicalizeHttpOrigin(raw);
    if (origin === null) return { ok: false };
    topOrigin = origin;
  }

  let checkoutOrigin: string | undefined;
  if (input.checkoutSiteUrl !== undefined) {
    const raw = presentSiteUrl(input.checkoutSiteUrl);
    if (raw === undefined) return { ok: false };
    const origin = canonicalizeHttpOrigin(raw);
    if (origin === null) return { ok: false };
    checkoutOrigin = origin;
  }

  if (topOrigin !== undefined && checkoutOrigin !== undefined && topOrigin !== checkoutOrigin) {
    return { ok: false };
  }

  let constructorOrigin: string | undefined;
  if (input.constructorSiteUrl !== undefined) {
    const raw = presentSiteUrl(input.constructorSiteUrl);
    if (raw === undefined) return { ok: false };
    const origin = canonicalizeHttpOrigin(raw);
    if (origin === null) return { ok: false };
    constructorOrigin = origin;
  }

  if (topOrigin !== undefined && constructorOrigin !== undefined && topOrigin !== constructorOrigin) {
    return { ok: false };
  }
  if (checkoutOrigin !== undefined && constructorOrigin !== undefined && checkoutOrigin !== constructorOrigin) {
    return { ok: false };
  }

  const configuredOrigin = checkoutOrigin ?? topOrigin ?? constructorOrigin;

  const runtimeRaw = presentSiteUrl(input.runtimeSiteUrl);
  if (runtimeRaw !== undefined) {
    const runtimeOrigin = canonicalizeHttpOrigin(runtimeRaw);
    if (runtimeOrigin === null) return { ok: false };
    if (configuredOrigin !== undefined && configuredOrigin !== runtimeOrigin) {
      return { ok: false };
    }
    return { ok: true, origin: runtimeOrigin };
  }

  if (configuredOrigin !== undefined) {
    return { ok: true, origin: configuredOrigin };
  }

  return { ok: false };
}
