// Command implementations for dinkus-coupons. Each one calls the hosted coupon
// service through the shared client and shapes the result for the kernel.
import { randomBytes } from "node:crypto";
import { CliError, EXIT, createHttp, httpFailure, usageError } from "./kernel.mjs";
import { closeRecord, digest, loadRecord, saveRecord } from "./pending-store.mjs";
import { TOKEN_ENV, createCouponsClient, pathId, resolveConnection } from "./client.mjs";

// Commit answers that mean the confirmation gate stopped the change: nothing
// was written, and only a fresh preview can try again.
const CONFIRMATION_GATE = new Set([
	"CONFIRMATION_NOT_FOUND",
	"CONFIRMATION_EXPIRED",
	"CONFIRMATION_ALREADY_USED",
	"CONFIRMATION_MISMATCH",
	"CONFLICTING_COMMAND",
]);

// ---------------------------------------------------------------------------
// Formatting helpers (human output only)

function usd(money) {
	if (!money || typeof money.minor !== "string" || !/^\d+$/.test(money.minor)) return "-";
	const digits = money.minor.padStart(3, "0");
	return `$${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function discountText(rule) {
	const discount = rule?.discount;
	if (discount?.kind === "fixed") return `${usd(discount.amount)} off`;
	if (discount?.kind === "percentage") {
		const percent = `${discount.basisPoints / 100}% off`;
		return discount.maximum ? `${percent} (at most ${usd(discount.maximum)})` : percent;
	}
	return "-";
}

function scopeText(rule) {
	const products = rule?.appliesTo === "selected-products" ? `products ${(rule.selectedProductIds ?? []).join(", ")}` : "all merchandise";
	return `${products}; sale items ${rule?.includeSaleItems ? "included" : "excluded"}`;
}

// Show an instant as wall-clock time in the coupon's own time zone, which is
// how the merchant entered it. JSON and plain output keep the service's value.
function when(instant, timeZone) {
	const date = new Date(instant);
	if (Number.isNaN(date.getTime())) return String(instant ?? "-");
	try {
		const parts = Object.fromEntries(
			new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" })
				.formatToParts(date)
				.map((part) => [part.type, part.value]),
		);
		const seconds = parts.second === "00" ? "" : `:${parts.second}`;
		return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${seconds} ${parts.timeZoneName}`;
	} catch {
		return String(instant);
	}
}

function couponLines(coupon) {
	const rule = coupon.rule ?? {};
	return [
		`code: ${coupon.code}`,
		...(coupon.couponId ? [`coupon id: ${coupon.couponId}`] : []),
		`status: ${coupon.disabled ? "off" : "on"}`,
		`discount: ${discountText(rule)}`,
		`applies to: ${scopeText(rule)}`,
		`minimum spend: ${usd(rule.minimumEligibleMerchandise)}`,
		`active: ${when(rule.startsAt, rule.timeZone)} to ${when(rule.endsAt, rule.timeZone)} (${rule.timeZone})`,
		`uses allowed: ${coupon.globalCap}`,
		...(coupon.revision ? [`revision: ${coupon.revision}`] : []),
	];
}

function table(headers, rows) {
	if (rows.length === 0) return "No coupons.";
	const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
	const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

const couponRecord = (coupon) => [
	["couponId", coupon.couponId],
	["code", coupon.code],
	["disabled", coupon.disabled],
	["discount", coupon.rule?.discount],
	["appliesTo", coupon.rule?.appliesTo],
	["startsAt", coupon.rule?.startsAt],
	["endsAt", coupon.rule?.endsAt],
	["globalCap", coupon.globalCap],
	["revision", coupon.revision],
];

// Attach the resolved context to errors so --json failures still say where
// the command was pointed.
async function withContext(context, work) {
	try {
		return await work();
	} catch (error) {
		if (error instanceof CliError && !error.details?.context) error.details = { ...error.details, context };
		throw error;
	}
}

function connect(ctx) {
	const client = createCouponsClient(ctx);
	return { client, context: { siteId: client.connection.siteId, endpoint: client.connection.endpoint } };
}

// ---------------------------------------------------------------------------
// Reads

export async function couponsList(ctx) {
	const { client, context } = connect(ctx);
	return withContext(context, async () => {
		const data = await client.list();
		if (!Array.isArray(data.coupons)) throw new CliError("malformed_response", "List coupons: the service answered without a coupon list.", { exit: EXIT.contract });
		return {
			context,
			data,
			human: table(
				["CODE", "COUPON ID", "ON", "DISCOUNT", "ENDS", "USES", "REV"],
				data.coupons.map((coupon) => [coupon.code, coupon.couponId, coupon.disabled ? "no" : "yes", discountText(coupon.rule), when(coupon.rule?.endsAt, coupon.rule?.timeZone), coupon.globalCap, coupon.revision]),
			),
			plain: data.coupons.map((coupon) => [["record", "coupon"], ...couponRecord(coupon)]),
		};
	});
}

export async function couponsShow(ctx) {
	const { client, context } = connect(ctx);
	const couponId = pathId(ctx.args["coupon-id"], "<coupon-id>");
	return withContext(context, async () => {
		const { coupon } = await client.coupon(couponId);
		const { counts } = await client.counts(couponId);
		if (!coupon || !counts) throw new CliError("malformed_response", "Show coupon: the service answered outside the contract.", { exit: EXIT.contract });
		const human = [
			...couponLines(coupon),
			`uses: ${counts.consumed} used, ${counts.pending} held for checkouts in progress, ${counts.remaining} left`,
		].join("\n");
		return { context, data: { coupon, counts }, human, plain: [[["record", "coupon"], ...couponRecord(coupon), ["consumed", counts.consumed], ["pending", counts.pending], ["remaining", counts.remaining]]] };
	});
}

// ---------------------------------------------------------------------------
// Changes: preview, confirm, frozen request, awaited terminal result.

const USD_AMOUNT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function usdFlag(text, flag) {
	const match = USD_AMOUNT.exec(text ?? "");
	if (!match) throw usageError(`${flag} "${text}" must be a USD amount such as 5 or 12.50.`);
	return { currency: "USD", minor: String(BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))) };
}

function instantFlag(text, flag) {
	if (!INSTANT.test(text)) throw usageError(`${flag} "${text}" must be a date and time with its UTC offset, such as 2026-12-31T23:59:59-05:00.`);
	return text;
}

function createRequest(ctx) {
	const { flags } = ctx;
	if ((flags.percent === undefined) === (flags.amount === undefined)) throw usageError("Pass exactly one of --percent or --amount.");
	let discount;
	if (flags.percent !== undefined) {
		const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(flags.percent);
		const basisPoints = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
		if (!(basisPoints > 0 && basisPoints <= 10_000)) throw usageError(`--percent "${flags.percent}" must be more than 0 and at most 100, with up to two decimals.`);
		discount = { kind: "percentage", basisPoints, ...(flags["max-discount"] === undefined ? {} : { maximum: usdFlag(flags["max-discount"], "--max-discount") }) };
	} else {
		if (flags["max-discount"] !== undefined) throw usageError("--max-discount applies only to --percent coupons.");
		discount = { kind: "fixed", amount: usdFlag(flags.amount, "--amount") };
	}
	if (!/^[1-9]\d{0,8}$/.test(flags.cap)) throw usageError(`--cap "${flags.cap}" must be a whole number of uses from 1.`);
	const products = flags.product ?? [];
	return {
		action: "create",
		coupon: {
			code: flags.code,
			globalCap: Number(flags.cap),
			...(flags.disabled ? { disabled: true } : {}),
			rule: {
				discount,
				appliesTo: products.length ? "selected-products" : "all-merchandise",
				selectedProductIds: products,
				includeSaleItems: Boolean(flags["include-sale-items"]),
				minimumEligibleMerchandise: usdFlag(flags["min-spend"] ?? "0", "--min-spend"),
				...(flags.starts === undefined ? {} : { startsAt: instantFlag(flags.starts, "--starts") }),
				endsAt: instantFlag(flags.ends, "--ends"),
				timeZone: flags["time-zone"] ?? "UTC",
			},
		},
	};
}

const toggleRequest = (action) => (ctx) => ({ action, couponId: pathId(ctx.args["coupon-id"], "<coupon-id>") });

const KINDS = {
	create: { name: "coupons.create", verb: "created", request: createRequest },
	disable: { name: "coupons.disable", verb: "turned off", request: toggleRequest("disable") },
	enable: { name: "coupons.enable", verb: "turned on", request: toggleRequest("enable") },
};

function previewHuman(context, { preview, confirmation }) {
	const lines = [`store: ${context.siteId}`, `change: ${preview.action}`];
	if (preview.action === "create") lines.push(...couponLines(preview.after));
	else lines.push(`code: ${preview.before?.code}`, `coupon id: ${preview.couponId}`, `status: ${preview.before?.disabled ? "off" : "on"} -> ${preview.after?.disabled ? "off" : "on"}`);
	lines.push(`confirmation: ${confirmation?.value} (expires ${confirmation?.expiresAt})`);
	return lines.join("\n");
}

const newCommandId = () => `cmd-${randomBytes(16).toString("hex")}`;

// Interpret the commit response. Only known shapes are terminal; anything
// else after a send leaves the outcome unknown.
async function terminalResult(ctx, record, response) {
	const { json } = response;
	const context = record.context;
	const kind = KINDS[record.command.replace(/^coupons\./, "")];
	if (response.ok && json?.outcome === "committed" && json.coupon) {
		await closeRecord(ctx.env, record, { outcome: "committed", couponId: json.coupon.couponId, revision: json.coupon.revision });
		return { outcome: "committed", context, commandId: record.commandId, data: json.coupon, human: `${kind?.verb ?? "changed"} coupon ${json.coupon.code} (${json.coupon.couponId})\ncommand: ${record.commandId}` };
	}
	if (response.status === 409 && json?.outcome === "rejected" && json.rejection) {
		await closeRecord(ctx.env, record, { outcome: "rejected", code: json.rejection.code });
		return { outcome: "rejected", context, commandId: record.commandId, rejection: json.rejection, human: `rejected: ${json.rejection.code}${json.rejection.message ? ` (${json.rejection.message})` : ""}`, exit: EXIT.failure };
	}
	const code = typeof json?.error?.code === "string" ? json.error.code : undefined;
	if (code && response.status === 409 && CONFIRMATION_GATE.has(code)) {
		await closeRecord(ctx.env, record, { outcome: "blocked", code });
		throw new CliError(code, `The confirmation gate stopped the change (${code}); nothing was written. Preview again.`, { exit: EXIT.blocked, outcome: "blocked", details: { context, document: { commandId: record.commandId } } });
	}
	if (code && [400, 401, 403, 404].includes(response.status)) {
		await closeRecord(ctx.env, record, { outcome: "refused", code });
		throw new CliError(code, `The service refused the change (${code}); nothing was written.`, { exit: response.status === 401 || response.status === 403 ? EXIT.blocked : EXIT.failure, details: { context, document: { commandId: record.commandId } } });
	}
	return unknownResult(record, json === undefined ? "malformed_response" : `http_${response.status}`, json === undefined ? EXIT.contract : EXIT.unavailable);
}

function unknownResult(record, reason, exit = EXIT.unavailable) {
	return {
		outcome: "unknown",
		context: record.context,
		commandId: record.commandId,
		unknown: { reason, next: `dinkus-coupons --site ${record.context.siteId} commands resolve ${record.commandId}` },
		human: `outcome=unknown commandId=${record.commandId}`,
		notes: [`The outcome is unknown. The frozen request is kept locally; run: dinkus-coupons --site ${record.context.siteId} commands resolve ${record.commandId}`],
		exit,
	};
}

async function send(ctx, record) {
	const request = createHttp({
		baseUrl: `${record.context.endpoint}/v1/stores/${record.context.siteId}`,
		headers: { authorization: `Bearer ${ctx.env[TOKEN_ENV]}` },
		timeoutMs: ctx.timeoutMs,
		fetchImpl: ctx.fetchImpl,
		signal: ctx.signal,
	});
	ctx.lifecycle.sending = true;
	let response;
	try {
		response = await request("POST", "/coupons/commands", { body: record.body });
	} catch (error) {
		if (error instanceof CliError && error.exit === EXIT.unavailable) return unknownResult(record, error.code);
		throw error;
	} finally {
		ctx.lifecycle.sending = false;
	}
	return terminalResult(ctx, record, response);
}

async function change(ctx, kind) {
	if (ctx.flags.site === undefined) {
		throw usageError("Changes need --site on the command line; profiles and environment do not choose the store for a change.", "missing_context");
	}
	if (ctx.flags["dry-run"] && ctx.flags.confirm !== undefined) throw usageError("--dry-run and --confirm cannot be combined.");
	const request = kind.request(ctx);
	const { client, context } = connect(ctx);
	return withContext(context, async () => {
		if (ctx.flags["dry-run"]) {
			const previewed = await client.preview(request, `Preview ${kind.name}`);
			return { outcome: "preview", context, data: previewed.preview, confirmation: previewed.confirmation, human: previewHuman(context, previewed) };
		}
		let confirmation = ctx.flags.confirm;
		if (confirmation === undefined) {
			if (ctx.flags["no-input"]) {
				throw new CliError("confirmation_required", "A change with --no-input needs --confirm with the value from a fresh --dry-run.", { exit: EXIT.blocked });
			}
			const previewed = await client.preview(request, `Preview ${kind.name}`);
			ctx.io.stderr.write(`${previewHuman(context, previewed)}\n`);
			const answer = await ctx.prompt(`Type ${previewed.confirmation.value} to make this change, or anything else to cancel: `);
			if (answer !== previewed.confirmation.value) throw new CliError("not_confirmed", "Not confirmed; nothing was sent.", { exit: EXIT.blocked });
			confirmation = previewed.confirmation.value;
		}
		const commandId = newCommandId();
		const body = JSON.stringify({ commandId, confirmation, request });
		const record = {
			schema: "dinkuskit.coupons.cli-pending/v1",
			state: "pending",
			commandId,
			command: kind.name,
			context,
			body,
			digest: digest(body),
			createdAt: new Date().toISOString(),
		};
		await saveRecord(ctx.env, record);
		return send(ctx, record);
	});
}

export const couponsCreate = (ctx) => change(ctx, KINDS.create);
export const couponsDisable = (ctx) => change(ctx, KINDS.disable);
export const couponsEnable = (ctx) => change(ctx, KINDS.enable);

// ---------------------------------------------------------------------------
// Unknown-outcome recovery

function recordSummary(record) {
	return { commandId: record.commandId, command: record.command, state: record.state, createdAt: record.createdAt, digest: record.digest, terminal: record.terminal ?? null };
}

export async function commandsShow(ctx) {
	const commandId = ctx.args["command-id"];
	const record = await loadRecord(ctx.env, commandId);
	const { client, context } = connect(ctx);
	return withContext(record?.context ?? context, async () => {
		if (record && (record.context.siteId !== context.siteId || record.context.endpoint !== context.endpoint)) {
			throw usageError(`${commandId} was sent to store ${record.context.siteId} at ${record.context.endpoint}; pass that --site and --endpoint.`, "context_mismatch");
		}
		const response = await client.command(commandId);
		let service;
		if (response.ok || (response.status === 409 && response.json?.outcome === "rejected")) service = response.json;
		else if (response.status === 404 && response.json?.error?.code === "NOT_FOUND") service = null;
		else throw httpFailure(response, `Read command ${commandId}`);
		if (!record && service === null) throw new CliError("command_not_found", `Neither this machine nor the service has a record of ${commandId}.`);
		const data = { local: record ? recordSummary(record) : null, service };
		const human = [
			`command: ${commandId}`,
			`on this machine: ${record ? record.state : "no record"}`,
			`at the service: ${service === null ? "never committed" : service.outcome}`,
		].join("\n");
		return { context: record?.context ?? context, commandId, data, human };
	});
}

export async function commandsResolve(ctx) {
	const record = await loadRecord(ctx.env, ctx.args["command-id"]);
	if (!record) {
		throw new CliError("envelope_missing", `No frozen request for ${ctx.args["command-id"]} on this machine; replay is blocked and no new change is made.`);
	}
	if (record.state === "closed") {
		return { outcome: record.terminal?.outcome === "committed" ? "committed" : "ok", context: record.context, commandId: record.commandId, data: recordSummary(record), human: `${record.commandId} is already closed (${record.terminal?.outcome})` };
	}
	if (digest(record.body) !== record.digest) {
		throw new CliError("envelope_corrupt", `The frozen request for ${record.commandId} does not match its digest; refusing to replay.`, { exit: EXIT.contract });
	}
	const connection = resolveConnection(ctx);
	if (connection.siteId !== record.context.siteId || connection.endpoint !== record.context.endpoint) {
		throw usageError(`${record.commandId} was sent to store ${record.context.siteId} at ${record.context.endpoint}; pass that --site and --endpoint.`, "context_mismatch");
	}
	return send(ctx, record);
}
