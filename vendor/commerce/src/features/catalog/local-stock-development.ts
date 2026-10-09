export const LOCAL_STOCK_MANAGEMENT_OPTION = "enableLocalStockManagement";

export interface LocalStockHostOptions {
  /**
   * Host-owned local-development opt-in. Default false.
   * Not a merchant setting, URL query, browser flag, or request override.
   */
  enableLocalStockManagement?: boolean;
  /**
   * Host-owned configured site URL. Required for admission together with the
   * opt-in and a loopback request URL when runtime site context is empty.
   * Not taken from request, query, or browser input. Pass the same origin the
   * host set as EmDash `siteUrl` / `EMDASH_SITE_URL`.
   */
  siteUrl?: string;
}

export interface ManageStockControl {
  enabled: boolean;
}

export interface LocalStockAdmissionContext {
  hostEnableLocalStockManagement: boolean;
  requestUrl?: string;
  /**
   * Single-source site URL for direct callers. Split constructor/runtime
   * fields take precedence when either is present.
   */
  siteUrl?: string;
  constructorSiteUrl?: string;
  runtimeSiteUrl?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TRUSTED_SCHEMES = new Set(["http:", "https:"]);

function hostnameOf(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (!TRUSTED_SCHEMES.has(parsed.protocol)) return null;
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function presentUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function isLoopbackUrl(value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const hostname = hostnameOf(value.trim());
  return hostname !== null && LOOPBACK_HOSTS.has(hostname);
}

export function trustedSiteUrlSources(input: {
  siteUrl?: string;
  constructorSiteUrl?: string;
  runtimeSiteUrl?: string;
}): string[] {
  const constructorSiteUrl = presentUrl(input.constructorSiteUrl);
  const runtimeSiteUrl = presentUrl(input.runtimeSiteUrl);
  if (constructorSiteUrl !== undefined || runtimeSiteUrl !== undefined) {
    return [constructorSiteUrl, runtimeSiteUrl].filter(
      (value): value is string => value !== undefined,
    );
  }
  const siteUrl = presentUrl(input.siteUrl);
  return siteUrl === undefined ? [] : [siteUrl];
}

export function isLocalLoopbackContext(input: {
  requestUrl?: string;
  siteUrl?: string;
  constructorSiteUrl?: string;
  runtimeSiteUrl?: string;
}): boolean {
  if (!isLoopbackUrl(input.requestUrl)) return false;
  const sources = trustedSiteUrlSources(input);
  return sources.length > 0 && sources.every((url) => isLoopbackUrl(url));
}

export function normalizeHostLocalStockOption(value: unknown): boolean {
  return value === true;
}

export function isLocalStockManagementEnabled(
  input: LocalStockAdmissionContext,
): boolean {
  return (
    normalizeHostLocalStockOption(input.hostEnableLocalStockManagement) &&
    isLocalLoopbackContext(input)
  );
}

export function readLocalStockAdmission(
  options: LocalStockHostOptions | undefined,
  ctx: { request?: { url?: string }; site?: { url?: string } },
): LocalStockAdmissionContext {
  const constructorSiteUrl = presentUrl(options?.siteUrl);
  const runtimeSiteUrl = presentUrl(ctx.site?.url);
  return {
    hostEnableLocalStockManagement: normalizeHostLocalStockOption(
      options?.enableLocalStockManagement,
    ),
    requestUrl: typeof ctx.request?.url === "string" ? ctx.request.url : undefined,
    constructorSiteUrl,
    runtimeSiteUrl,
    siteUrl: runtimeSiteUrl ?? constructorSiteUrl,
  };
}

export function manageStockControlFromAdmission(
  input: LocalStockAdmissionContext,
): ManageStockControl {
  return { enabled: isLocalStockManagementEnabled(input) };
}
