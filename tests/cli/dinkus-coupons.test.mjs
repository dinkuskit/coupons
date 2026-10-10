// dinkus-coupons parsing, output, exit codes and safety rules, against a
// stand-in for the coupon service. tests/runtime/cli.test.mjs runs the same
// commands against the real Worker.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../../cli/kernel.mjs";
import { spec } from "../../cli/spec.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ENDPOINT = "https://coupons.example.test";
const SITE = "store-1";
// Built at runtime so no credential-shaped literal sits in the repository.
const PASS = ["fake", "admin", "pass"].join("-");

const coupon = {
	recordKind: "coupon",
	couponId: "coupon-1",
	code: "FALL10",
	normalizedCode: "FALL10",
	revision: 1,
	disabled: false,
	globalCap: 500,
	rule: {
		ruleId: "rule-1",
		version: 1,
		discount: { kind: "percentage", basisPoints: 1000, maximum: { currency: "USD", minor: "2500" } },
		appliesTo: "all-merchandise",
		selectedProductIds: [],
		includeSaleItems: false,
		minimumEligibleMerchandise: { currency: "USD", minor: "0" },
		startsAt: "2026-11-01T05:00:00.000Z",
		endsAt: "2026-12-01T04:59:59.000Z",
		timeZone: "America/Chicago",
	},
	createdAt: "2026-10-10T00:00:00.000Z",
	updatedAt: "2026-10-10T00:00:00.000Z",
	attempts: [],
};
const { attempts: _attempts, ...summary } = coupon;
const CONFIRMATION = "cfm-0123456789abcdef0123456789abcdef";
const confirmation = { value: CONFIRMATION, expiresAt: "2026-10-10T00:05:00.000Z" };

// A stand-in coupon service: canned answers per "METHOD /path", every request recorded.
function service(routes = {}) {
	const calls = [];
	const defaults = {
		"GET /coupons": () => Response.json({ coupons: [coupon] }),
		"GET /coupons/coupon-1": () => Response.json({ coupon }),
		"GET /coupons/coupon-1/counts": () => Response.json({ counts: { couponId: "coupon-1", cap: 500, capacity: 500, pending: 2, consumed: 7, released: 1, remaining: 491 } }),
		"POST /coupons/previews": (body) =>
			Response.json({ preview: body.action === "create" ? { action: "create", couponId: null, before: null, after: { ...summary, couponId: undefined } } : { action: body.action, couponId: body.couponId, before: summary, after: { ...summary, disabled: body.action === "disable" } }, confirmation }),
		"POST /coupons/commands": (body) => Response.json({ outcome: "committed", commandId: body.commandId, coupon: summary }),
	};
	const table = { ...defaults, ...routes };
	async function fetchImpl(url, init = {}) {
		const parsed = new URL(url);
		const path = parsed.pathname.replace(`/v1/stores/${SITE}`, "");
		const text = init.body;
		const body = text === undefined ? undefined : JSON.parse(text);
		calls.push({ method: init.method, url: parsed.href, path, headers: init.headers, text, body });
		const handler = table[`${init.method} ${path}`];
		if (!handler) return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
		return handler(body);
	}
	return { calls, fetchImpl };
}

async function dirs() {
	const base = await mkdtemp(join(tmpdir(), "dinkus-coupons-"));
	const cwd = join(base, "work");
	await mkdir(cwd);
	return { base, cwd, env: { XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state"), HOME: base } };
}

async function run(argv, { env = {}, fake = service(), stdin, stdinIsTTY = false, place } = {}) {
	const where = place ?? (await dirs());
	let stdout = "";
	let stderr = "";
	const exit = await runCli(spec, {
		argv,
		env: { ...where.env, DINKUS_COUPONS_TOKEN: PASS, ...env },
		cwd: where.cwd,
		stdout: { write: (text) => { stdout += text; } },
		stderr: { write: (text) => { stderr += text; } },
		stdin,
		stdinIsTTY,
		fetchImpl: fake.fetchImpl,
	});
	return { exit, stdout, stderr, calls: fake.calls, place: where };
}

const site = ["--endpoint", ENDPOINT, "--site", SITE];
const create = [...site, "coupons", "create", "--code", "FALL10", "--percent", "10", "--max-discount", "25", "--starts", "2026-11-01T00:00:00-05:00", "--ends", "2026-11-30T23:59:59-05:00", "--time-zone", "America/Chicago", "--cap", "500"];

test("help works at every depth and --version prints only the version", async () => {
	for (const argv of [["--help"], ["coupons", "--help"], ["coupons", "create", "-h", "--bogus"], ["help", "commands", "resolve"]]) {
		const result = await run(argv);
		assert.equal(result.exit, 0);
		assert.match(result.stdout, /^dinkus-coupons/);
		assert.equal(result.calls.length, 0);
	}
	const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const spawned = spawnSync(process.execPath, [join(root, "bin/dinkus-coupons.mjs"), "--version"], { encoding: "utf8" });
	assert.equal(spawned.status, 0);
	assert.equal(spawned.stdout, `${version}\n`);
});

test("list prints one JSON document, stable plain records, or a table, and never the pass", async () => {
	const json = await run([...site, "coupons", "list", "--json"]);
	assert.equal(json.exit, 0);
	const document = JSON.parse(json.stdout);
	assert.deepEqual(document, { schema: "dinkuskit.coupons.cli/v1", command: "coupons.list", outcome: "ok", context: { siteId: SITE, endpoint: ENDPOINT }, data: { coupons: [coupon] } });
	assert.equal(json.calls[0].url, `${ENDPOINT}/v1/stores/${SITE}/coupons`);
	assert.equal(json.calls[0].headers.authorization, `Bearer ${PASS}`);

	const plain = await run([...site, "coupons", "list", "--plain"]);
	assert.match(plain.stdout, /^schema=dinkuskit\.coupons\.cli\/v1\tcommand=coupons\.list\toutcome=ok\trecord=coupon\tcouponId=coupon-1\tcode=FALL10\tdisabled=false\t/);

	const human = await run([...site, "coupons", "list"]);
	assert.match(human.stdout, /FALL10\s+coupon-1\s+yes\s+10% off \(at most \$25\.00\)/);
	for (const result of [json, plain, human]) assert.equal(`${result.stdout}${result.stderr}`.includes(PASS), false);
});

test("show adds how many uses are left", async () => {
	const result = await run([...site, "coupons", "show", "coupon-1"]);
	assert.equal(result.exit, 0);
	assert.match(result.stdout, /uses: 7 used, 2 held for checkouts in progress, 491 left/);
	assert.match(result.stdout, /active: 2026-11-01 00:00 CDT to 2026-11-30 22:59:59 CST \(America\/Chicago\)/);
});

test("configuration: where the pass may go and what is required", async () => {
	const place = await dirs();
	await mkdir(join(place.cwd, ".dinkuskit"));
	await writeFile(join(place.cwd, ".dinkuskit", "coupons.json"), JSON.stringify({ endpoint: "https://elsewhere.example.test", site: SITE }));
	const untrusted = await run(["coupons", "list", "--json"], { place });
	assert.equal(untrusted.exit, 4);
	assert.equal(JSON.parse(untrusted.stdout).error.code, "untrusted_endpoint");
	assert.equal(untrusted.calls.length, 0);
	// The same endpoint from the environment is the operator's own choice.
	assert.equal((await run(["coupons", "list"], { place, env: { DINKUS_COUPONS_ENDPOINT: ENDPOINT } })).exit, 0);

	await writeFile(join(place.cwd, ".dinkuskit", "coupons.json"), JSON.stringify({ token: "x" }));
	const secret = await run([...site, "coupons", "list", "--json"], { place });
	assert.equal(secret.exit, 2);
	assert.equal(JSON.parse(secret.stdout).error.code, "secret_in_config");

	const cases = [
		[["--site", SITE, "coupons", "list"], {}, 2, "missing_endpoint"],
		[["--endpoint", "http://coupons.example.test", "--site", SITE, "coupons", "list"], {}, 2, "invalid_endpoint"],
		[["--endpoint", ENDPOINT, "coupons", "list"], {}, 2, "missing_site"],
		[["--endpoint", ENDPOINT, "--site", "store/1", "coupons", "list"], {}, 2, "invalid_id"],
		[[...site, "coupons", "list"], { DINKUS_COUPONS_TOKEN: "" }, 4, "missing_credential"],
		[["--endpoint", ENDPOINT, "coupons", "disable", "coupon-1", "--dry-run"], { DINKUS_COUPONS_SITE: SITE }, 2, "missing_context"],
		[[...site, "coupons", "list", "--json", "--plain"], {}, 2, "invalid_usage"],
	];
	for (const [argv, env, exit, code] of cases) {
		const result = await run([...argv, "--json"].filter((token, index, all) => token !== "--json" || all.indexOf("--json") === index), { env });
		assert.equal(result.exit, exit, `${argv.join(" ")} -> ${result.stderr}`);
		if (code !== "invalid_usage") assert.equal(JSON.parse(result.stdout).error.code, code);
		assert.equal(result.calls.length, 0);
	}
	// Reads may take the store from the environment.
	assert.equal((await run(["--endpoint", ENDPOINT, "coupons", "list"], { env: { DINKUS_COUPONS_SITE: SITE } })).exit, 0);
});

test("create --dry-run sends the documented preview request and changes nothing", async () => {
	const result = await run([...create, "--product", "tee", "--product", "mug", "--include-sale-items", "--min-spend", "20.5", "--dry-run", "--json"]);
	assert.equal(result.exit, 0);
	assert.deepEqual(result.calls.map((call) => `${call.method} ${call.path}`), ["POST /coupons/previews"]);
	assert.deepEqual(result.calls[0].body, {
		action: "create",
		coupon: {
			code: "FALL10",
			globalCap: 500,
			rule: {
				discount: { kind: "percentage", basisPoints: 1000, maximum: { currency: "USD", minor: "2500" } },
				appliesTo: "selected-products",
				selectedProductIds: ["tee", "mug"],
				includeSaleItems: true,
				minimumEligibleMerchandise: { currency: "USD", minor: "2050" },
				startsAt: "2026-11-01T00:00:00-05:00",
				endsAt: "2026-11-30T23:59:59-05:00",
				timeZone: "America/Chicago",
			},
		},
	});
	const document = JSON.parse(result.stdout);
	assert.equal(document.outcome, "preview");
	assert.deepEqual(document.confirmation, confirmation);

	const fixed = await run([...site, "coupons", "create", "--code", "FIVE", "--amount", "5", "--ends", "2026-12-31T23:59:59Z", "--cap", "1", "--disabled", "--dry-run", "--json"]);
	assert.deepEqual(fixed.calls[0].body.coupon, {
		code: "FIVE",
		globalCap: 1,
		disabled: true,
		rule: {
			discount: { kind: "fixed", amount: { currency: "USD", minor: "500" } },
			appliesTo: "all-merchandise",
			selectedProductIds: [],
			includeSaleItems: false,
			minimumEligibleMerchandise: { currency: "USD", minor: "0" },
			endsAt: "2026-12-31T23:59:59Z",
			timeZone: "UTC",
		},
	});
});

test("create refuses malformed input before contacting the service", async () => {
	const base = [...site, "coupons", "create", "--code", "X", "--ends", "2026-12-31T23:59:59Z", "--cap", "5", "--dry-run"];
	for (const extra of [
		[],
		["--percent", "10", "--amount", "5"],
		["--percent", "0"],
		["--percent", "100.001"],
		["--percent", "101"],
		["--amount", "5", "--max-discount", "2"],
		["--amount", "5.001"],
		["--amount", "-5"],
		["--percent", "10", "--min-spend", "ten"],
	]) {
		const result = await run([...base, ...extra]);
		assert.equal(result.exit, 2, extra.join(" "));
		assert.equal(result.calls.length, 0);
	}
	for (const argv of [
		[...site, "coupons", "create", "--code", "X", "--percent", "10", "--ends", "2026-12-31", "--cap", "5", "--dry-run"],
		[...site, "coupons", "create", "--code", "X", "--percent", "10", "--ends", "2026-12-31T23:59:59Z", "--cap", "0", "--dry-run"],
		[...site, "coupons", "create", "--code", "X", "--percent", "10", "--ends", "2026-12-31T23:59:59Z", "--cap", "5", "--dry-run", "--confirm", CONFIRMATION],
		[...site, "coupons", "disable"],
	]) {
		const result = await run(argv);
		assert.equal(result.exit, 2, argv.join(" "));
		assert.equal(result.calls.length, 0);
	}
});

test("a change commits only with a confirmation: --confirm, or the value typed at the prompt", async () => {
	const blocked = await run([...site, "coupons", "disable", "coupon-1", "--no-input", "--json"]);
	assert.equal(blocked.exit, 4);
	assert.equal(JSON.parse(blocked.stdout).error.code, "confirmation_required");
	assert.equal(blocked.calls.length, 0);

	const confirmed = await run([...site, "coupons", "disable", "coupon-1", "--no-input", "--confirm", CONFIRMATION, "--json"]);
	assert.equal(confirmed.exit, 0);
	assert.deepEqual(confirmed.calls.map((call) => `${call.method} ${call.path}`), ["POST /coupons/commands"]);
	const sent = confirmed.calls[0].body;
	assert.match(sent.commandId, /^cmd-[0-9a-f]{32}$/);
	assert.deepEqual(sent, { commandId: sent.commandId, confirmation: CONFIRMATION, request: { action: "disable", couponId: "coupon-1" } });
	const document = JSON.parse(confirmed.stdout);
	assert.deepEqual({ outcome: document.outcome, commandId: document.commandId, data: document.data }, { outcome: "committed", commandId: sent.commandId, data: summary });
	const record = JSON.parse(await readFile(join(confirmed.place.env.XDG_STATE_HOME, "dinkuskit/coupons/commands", `${sent.commandId}.json`), "utf8"));
	assert.equal(record.state, "closed");
	assert.equal(record.body, confirmed.calls[0].text);
	assert.equal(record.body.includes(PASS), false);

	const typed = new PassThrough();
	typed.end(`${CONFIRMATION}\n`);
	const prompted = await run([...site, "coupons", "enable", "coupon-1"], { stdin: typed, stdinIsTTY: true });
	assert.equal(prompted.exit, 0, prompted.stderr);
	assert.match(prompted.stderr, /status: on -> on|status: off -> on|confirmation: cfm-/);
	assert.deepEqual(prompted.calls.map((call) => `${call.method} ${call.path}`), ["POST /coupons/previews", "POST /coupons/commands"]);
	assert.match(prompted.stdout, /turned on coupon FALL10/);

	const refused = new PassThrough();
	refused.end("no\n");
	const declined = await run([...site, "coupons", "enable", "coupon-1"], { stdin: refused, stdinIsTTY: true });
	assert.equal(declined.exit, 4);
	assert.deepEqual(declined.calls.map((call) => `${call.method} ${call.path}`), ["POST /coupons/previews"]);
});

test("commit answers map to outcomes and exit codes", async () => {
	const reject = { "POST /coupons/commands": (body) => Response.json({ outcome: "rejected", commandId: body.commandId, rejection: { code: "REVISION_CONFLICT", message: "coupon revision does not match expectedRevision" } }, { status: 409 }) };
	const rejected = await run([...site, "coupons", "disable", "coupon-1", "--no-input", "--confirm", CONFIRMATION, "--json"], { fake: service(reject) });
	assert.equal(rejected.exit, 1);
	assert.deepEqual(JSON.parse(rejected.stdout).rejection, { code: "REVISION_CONFLICT", message: "coupon revision does not match expectedRevision" });

	for (const code of ["CONFIRMATION_EXPIRED", "CONFIRMATION_MISMATCH", "CONFIRMATION_ALREADY_USED", "CONFIRMATION_NOT_FOUND", "CONFLICTING_COMMAND"]) {
		const gate = { "POST /coupons/commands": () => Response.json({ error: { code, message: code } }, { status: 409 }) };
		const result = await run([...site, "coupons", "disable", "coupon-1", "--no-input", "--confirm", CONFIRMATION, "--json"], { fake: service(gate) });
		assert.equal(result.exit, 4, code);
		assert.equal(JSON.parse(result.stdout).error.code, code);
	}
	const forbidden = { "POST /coupons/commands": () => Response.json({ error: { code: "FORBIDDEN", message: "no" } }, { status: 403 }) };
	assert.equal((await run([...site, "coupons", "disable", "coupon-1", "--no-input", "--confirm", CONFIRMATION], { fake: service(forbidden) })).exit, 4);
	const previewRefused = { "POST /coupons/previews": () => Response.json({ error: { code: "CODE_IN_USE", message: "another coupon already uses this code" } }, { status: 409 }) };
	const inUse = await run([...create, "--dry-run", "--json"], { fake: service(previewRefused) });
	assert.equal(inUse.exit, 1);
	assert.equal(JSON.parse(inUse.stdout).error.code, "CODE_IN_USE");
});

test("an unknown outcome keeps the frozen request, and resolve resends exactly those bytes", async () => {
	let down = true;
	const flaky = {
		"POST /coupons/commands": (body) => (down ? Response.json({ error: { code: "INTERNAL", message: "internal error" } }, { status: 500 }) : Response.json({ outcome: "committed", commandId: body.commandId, coupon: summary })),
	};
	const fake = service(flaky);
	const place = await dirs();
	const unknown = await run([...create, "--no-input", "--confirm", CONFIRMATION, "--json"], { fake, place });
	assert.equal(unknown.exit, 3);
	const document = JSON.parse(unknown.stdout);
	assert.equal(document.outcome, "unknown");
	assert.match(unknown.stderr, /commands resolve cmd-/);
	const pending = await readdir(join(place.env.XDG_STATE_HOME, "dinkuskit/coupons/commands"));
	assert.deepEqual(pending, [`${document.commandId}.json`]);

	const elsewhere = await run(["--endpoint", ENDPOINT, "--site", "store-2", "commands", "resolve", document.commandId], { fake, place });
	assert.equal(elsewhere.exit, 2);

	down = false;
	const resolved = await run([...site, "commands", "resolve", document.commandId, "--json"], { fake, place });
	assert.equal(resolved.exit, 0);
	assert.equal(JSON.parse(resolved.stdout).outcome, "committed");
	const commits = fake.calls.filter((call) => call.path === "/coupons/commands");
	assert.equal(commits.length, 3 - 1);
	assert.equal(commits[1].text, commits[0].text);
	const again = await run([...site, "commands", "resolve", document.commandId, "--json"], { fake, place });
	assert.equal(JSON.parse(again.stdout).data.state, "closed");
	assert.equal(fake.calls.filter((call) => call.path === "/coupons/commands").length, 2);

	const missing = await run([...site, "commands", "resolve", "cmd-ffffffffffffffff"], { fake, place });
	assert.equal(missing.exit, 1);
	assert.equal((await run([...site, "commands", "resolve", "../../etc/passwd"], { fake, place })).exit, 2);
});

test("planned commands fail closed without contacting the service", async () => {
	const result = await run([...site, "coupons", "edit", "coupon-1", "--json"]);
	assert.equal(result.exit, 1);
	assert.equal(JSON.parse(result.stdout).error.code, "not_implemented");
	assert.equal(result.calls.length, 0);
});

test("a real HTTP round trip over loopback", async () => {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(request.url === `/v1/stores/${SITE}/coupons` && request.headers.authorization === `Bearer ${PASS}` ? { coupons: [coupon] } : { error: { code: "NOT_FOUND", message: request.url } }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address();
		const place = await dirs();
		const child = spawn(process.execPath, [join(root, "bin/dinkus-coupons.mjs"), "--endpoint", `http://127.0.0.1:${port}`, "--site", SITE, "coupons", "list", "--json"], {
			cwd: place.cwd,
			env: { ...place.env, PATH: process.env.PATH, DINKUS_COUPONS_TOKEN: PASS },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 0, stderr);
		const envelope = JSON.parse(stdout);
		assert.equal(envelope.outcome, "ok");
		assert.deepEqual(envelope.data.coupons.map((entry) => entry.code), ["FALL10"]);
		assert.equal(stdout.includes(PASS) || stderr.includes(PASS), false);
	} finally {
		server.close();
	}
});

test("the CLI stays out of the Worker: it imports only Node built-ins and its own files", async () => {
	for (const file of await readdir(join(root, "cli"))) {
		const text = await readFile(join(root, "cli", file), "utf8");
		for (const [, specifier] of text.matchAll(/^import[^"']*["']([^"']+)["']/gm)) {
			assert.ok(specifier.startsWith("node:") || specifier.startsWith("./") || specifier === "../package.json", `${file} imports ${specifier}`);
		}
	}
	for (const file of await readdir(join(root, "src"))) {
		if (!file.endsWith(".ts")) continue;
		assert.equal((await readFile(join(root, "src", file), "utf8")).includes("cli/"), false, `src/${file} references the CLI`);
	}
	const kernel = await readFile(join(root, "cli/kernel.mjs"), "utf8");
	assert.match(kernel, /^\/\/ Shared DinkusKit CLI kernel/);
});
