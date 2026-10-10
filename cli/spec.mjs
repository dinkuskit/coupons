// dinkus-coupons command tree. The contract is docs/CLI-SPEC.md; this file
// binds that surface to the shared kernel and the coupon service client.
import { CliError, EXIT } from "./kernel.mjs";
import { ENDPOINT_ENV, SITE_ENV, TOKEN_ENV } from "./client.mjs";
import { commandsResolve, commandsShow, couponsCreate, couponsDisable, couponsEnable, couponsList, couponsShow } from "./commands.mjs";
import packageJson from "../package.json" with { type: "json" };

const { version } = packageJson;

function planned(missing) {
	return () => {
		throw new CliError("not_implemented", `Not implemented yet: ${missing}`, { exit: EXIT.failure });
	};
}

const dryRun = { type: "boolean", description: "Ask the service for a preview and a confirmation value; change nothing." };
const confirm = { type: "string", value: "<value>", description: "Make the change only if it matches the preview this value came from." };
const couponId = [{ name: "coupon-id" }];
const commandId = [{ name: "command-id" }];

export const spec = {
	name: "dinkus-coupons",
	version,
	description: "Create, list and turn coupons on or off in the hosted DinkusKit coupon service.",
	schema: "dinkuskit.coupons.cli/v1",
	configName: "coupons",
	docs: "https://github.com/dinkuskit/coupons/blob/main/docs/CLI-SPEC.md",
	envMap: { endpoint: ENDPOINT_ENV, site: SITE_ENV, profile: "DINKUS_COUPONS_PROFILE" },
	defaults: {},
	globals: {
		endpoint: { type: "string", value: "<url>", description: `Coupon service URL, such as https://coupons.example. Env: ${ENDPOINT_ENV}.` },
		site: { type: "string", value: "<site-id>", description: `Store id (the pass's site_id). Required as a flag for changes. Env: ${SITE_ENV}.` },
	},
	environment: [
		[TOKEN_ENV, "A coupons:admin pass for the store. Never a flag or config value."],
		[ENDPOINT_ENV, "Default --endpoint."],
		[SITE_ENV, "Default --site for reads."],
		["DINKUS_COUPONS_PROFILE", "Default --profile."],
		["XDG_CONFIG_HOME", "User config: $XDG_CONFIG_HOME/dinkuskit/coupons/config.json."],
		["XDG_STATE_HOME", "Pending changes: $XDG_STATE_HOME/dinkuskit/coupons/commands/."],
	],
	examples: [
		"dinkus-coupons --site store-1 coupons list",
		"dinkus-coupons --site store-1 coupons create --code FALL10 --percent 10 --ends 2026-11-30T23:59:59-05:00 --cap 500 --dry-run",
		"dinkus-coupons --site store-1 coupons disable <coupon-id>",
	],
	tree: {
		commands: {
			coupons: {
				summary: `Read and change the store's coupons. Needs ${TOKEN_ENV}.`,
				commands: {
					list: {
						summary: "List every coupon in the store.",
						usage: "coupons list",
						description: "Reads GET /coupons. JSON output passes the service's coupon records through unchanged.",
						examples: ["dinkus-coupons --site store-1 coupons list --json | jq -r '.data.coupons[].code'"],
						run: couponsList,
					},
					show: {
						summary: "Show one coupon and how many uses are left.",
						usage: "coupons show <coupon-id>",
						description: "Reads GET /coupons/{id} and GET /coupons/{id}/counts.",
						args: couponId,
						run: couponsShow,
					},
					create: {
						summary: "Create a coupon, after a preview you confirm.",
						usage: "coupons create --code <code> (--percent <p> [--max-discount <usd>] | --amount <usd>) --ends <time> --cap <uses> [options] (--dry-run | --confirm <value>)",
						description:
							"Without --product the coupon applies to all merchandise. Amounts are USD. Times need a UTC offset; --starts defaults to the moment the service previews the change. Interactive runs show the preview and ask you to type its confirmation value; scripts run --dry-run --json first, then the same command with --no-input --confirm <value>.",
						flags: {
							code: { type: "string", value: "<code>", required: true, description: "Code shoppers type. Matching ignores case." },
							percent: { type: "string", value: "<percent>", description: "Percentage off eligible merchandise, such as 10 or 12.5." },
							"max-discount": { type: "string", value: "<usd>", description: "Largest discount a --percent coupon can give." },
							amount: { type: "string", value: "<usd>", description: "Fixed amount off eligible merchandise, such as 5 or 12.50." },
							"min-spend": { type: "string", value: "<usd>", description: "Eligible merchandise needed before the coupon applies (default 0)." },
							product: { type: "string", value: "<product-id>", multiple: true, description: "Limit the coupon to this Commerce product id." },
							"include-sale-items": { type: "boolean", description: "Let the coupon discount items already on sale (default: excluded)." },
							starts: { type: "string", value: "<time>", description: "Start, such as 2026-11-01T00:00:00-05:00 (default: now)." },
							ends: { type: "string", value: "<time>", required: true, description: "End, such as 2026-11-30T23:59:59-05:00." },
							"time-zone": { type: "string", value: "<zone>", description: "IANA time zone the store reports in (default UTC)." },
							cap: { type: "string", value: "<uses>", required: true, description: "Total uses allowed across all shoppers." },
							disabled: { type: "boolean", description: "Create the coupon turned off." },
							"dry-run": dryRun,
							confirm,
						},
						examples: [
							"dinkus-coupons --site store-1 coupons create --code FALL10 --percent 10 --max-discount 25 --ends 2026-11-30T23:59:59-05:00 --cap 500 --dry-run --json",
							"dinkus-coupons --site store-1 coupons create --code FALL10 --percent 10 --max-discount 25 --ends 2026-11-30T23:59:59-05:00 --cap 500 --no-input --confirm <value> --json",
						],
						run: couponsCreate,
					},
					disable: {
						summary: "Turn a coupon off, after a preview you confirm.",
						usage: "coupons disable <coupon-id> (--dry-run | --confirm <value>)",
						description: "Checkouts that already hold the coupon keep their discount; new checkouts cannot use it.",
						args: couponId,
						flags: { "dry-run": dryRun, confirm },
						run: couponsDisable,
					},
					enable: {
						summary: "Turn a coupon back on, after a preview you confirm.",
						usage: "coupons enable <coupon-id> (--dry-run | --confirm <value>)",
						args: couponId,
						flags: { "dry-run": dryRun, confirm },
						run: couponsEnable,
					},
					edit: {
						summary: "Change a coupon's code, uses or rule. (planned)",
						usage: "coupons edit <coupon-id>",
						args: couponId,
						run: planned("the service previews only create, disable and enable. Edits need an edit preview first."),
					},
				},
			},
			commands: {
				summary: "Recover a change whose outcome is unknown.",
				commands: {
					show: {
						summary: "Show what this machine and the service know about a change.",
						usage: "commands show <command-id>",
						description: "Reads the local pending record and GET /coupons/commands/{id}.",
						args: commandId,
						run: commandsShow,
					},
					resolve: {
						summary: "Resend a change's frozen request to learn its outcome.",
						usage: "commands resolve <command-id>",
						description: "Sends the exact frozen request with the same command id. The service answers with the first result if it already made the change, so this never changes anything twice.",
						args: commandId,
						run: commandsResolve,
					},
				},
			},
		},
	},
};
