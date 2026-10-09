import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ServiceError } from "./errors.js";

export type CouponScope = "coupons:checkout" | "coupons:admin";

/**
 * Verifies the store's bearer token the way Payments does: issuer, audience,
 * RS256 or ES256 from the issuer's JWKS, at most an hour old, the requested
 * scope, and a site_id equal to the store in the request path.
 */
export function createAuthenticator(config: { issuer: string; audience: string; jwksUrl: string }, key?: JWTVerifyGetKey) {
  if (new URL(config.issuer).protocol !== "https:" || new URL(config.jwksUrl).protocol !== "https:" || !config.audience) {
    throw new Error("invalid_identity_configuration");
  }
  const resolveKey = key ?? createRemoteJWKSet(new URL(config.jwksUrl));
  return async (request: Request, siteId: string, scope: CouponScope): Promise<void> => {
    const bearer = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!bearer) throw new ServiceError(401, "UNAUTHENTICATED", "a bearer token is required");
    let payload;
    try {
      ({ payload } = await jwtVerify(bearer, resolveKey, {
        issuer: config.issuer, audience: config.audience, algorithms: ["RS256", "ES256"],
        requiredClaims: ["exp", "iat", "sub"], maxTokenAge: "1h",
      }));
    } catch {
      throw new ServiceError(401, "UNAUTHENTICATED", "the bearer token is not valid");
    }
    if (typeof payload.site_id !== "string" || payload.site_id !== siteId ||
        typeof payload.scope !== "string" || !payload.scope.split(" ").includes(scope)) {
      throw new ServiceError(403, "FORBIDDEN", "the token does not grant this scope for this store");
    }
  };
}
