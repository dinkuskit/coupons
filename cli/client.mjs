// Authenticated client for the hosted coupon service's admin API. It only moves
// requests and responses; coupon rules, codes, revisions and counts stay in the
// service.
import { CliError, EXIT, createHttp, expectJson, usageError, validateEndpoint } from "./kernel.mjs";

export const TOKEN_ENV = "DINKUS_COUPONS_TOKEN";
export const ENDPOINT_ENV = "DINKUS_COUPONS_ENDPOINT";
export const SITE_ENV = "DINKUS_COUPONS_SITE";

// Store ids and coupon ids travel in the URL path, so they use the service's
// path alphabet.
const PATH_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function pathId(value, what) {
	if (!PATH_ID.test(value ?? "")) throw usageError(`${what} "${value}" may use only letters, digits, ".", "_", ":" and "-" (at most 200).`, "invalid_id");
	return value;
}

export function resolveConnection(ctx) {
	const endpointText = ctx.config.resolve("endpoint");
	if (!endpointText) {
		throw usageError(`No coupon service endpoint. Pass --endpoint, set ${ENDPOINT_ENV}, or add it to your user config.`, "missing_endpoint");
	}
	const endpoint = validateEndpoint(endpointText);
	const siteValue = ctx.config.resolve("site");
	if (!siteValue) throw usageError(`No store. Pass --site, set ${SITE_ENV}, or add it to a profile.`, "missing_site");
	const siteId = pathId(siteValue, "--site");
	const token = ctx.env[TOKEN_ENV];
	if (!token) {
		throw new CliError("missing_credential", `Set ${TOKEN_ENV} to a coupons:admin pass for this store.`, { exit: EXIT.blocked });
	}
	// A project config file comes with the working directory, so it must not
	// decide which host receives the pass.
	if (ctx.config.source("endpoint") === "project") {
		throw new CliError(
			"untrusted_endpoint",
			`Refusing to send ${TOKEN_ENV} to an endpoint from project config. Pass --endpoint or set ${ENDPOINT_ENV}.`,
			{ exit: EXIT.blocked },
		);
	}
	return { endpoint, siteId, token };
}

export function createCouponsClient(ctx, connection = resolveConnection(ctx)) {
	const request = createHttp({
		baseUrl: `${connection.endpoint}/v1/stores/${connection.siteId}`,
		headers: { authorization: `Bearer ${connection.token}` },
		timeoutMs: ctx.timeoutMs,
		fetchImpl: ctx.fetchImpl,
		signal: ctx.signal,
	});
	const get = async (path, what) => expectJson(await request("GET", path), what);
	return {
		connection,
		request,
		list: () => get("/coupons", "List coupons"),
		coupon: (couponId) => get(`/coupons/${couponId}`, `Read coupon ${couponId}`),
		counts: (couponId) => get(`/coupons/${couponId}/counts`, `Read uses of coupon ${couponId}`),
		command: (commandId) => request("GET", `/coupons/commands/${commandId}`),
		async preview(body, what) {
			const response = await request("POST", "/coupons/previews", { body });
			if (response.status === 409 && typeof response.json?.error?.code === "string") {
				throw new CliError(response.json.error.code, response.json.error.message ?? `${what} was refused (${response.json.error.code}).`, {
					exit: EXIT.failure,
					outcome: "rejected",
				});
			}
			return expectJson(response, what);
		},
	};
}
