/**
 * OFFLINE test suite — runs with a dummy key and makes ZERO network calls, so CI
 * can gate every push on it (no Tenki token / no data-plane needed). Covers what
 * can be proven without the live API: the server boots (with AND without a
 * credential), advertises a well-formed tool surface, negotiates the protocol,
 * rejects bad tool args PRE-network, and reports auth status without leaking
 * the token.
 *
 *   npm run build && node test/offline.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DUMMY = "tk_offline_dummy_key";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

const DEAD_ENDPOINT = "http://127.0.0.1:1";

/** Spawn the server over stdio with a specific env and hand back a live client. */
async function connectWith(env, name) {
	const t = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...process.env, TENKI_API_ENDPOINT: DEAD_ENDPOINT, ...env },
		stderr: "ignore",
	});
	const c = new Client({ name, version: "1.0.0" });
	await c.connect(t);
	return c;
}

// 1) UNAUTHENTICATED contract: a missing credential must NOT be fatal. Exiting
// here is what MCP clients report as an opaque "server failed to start", with
// stderr swallowed — so the server boots with tenki_auth_status alone and the
// agent can discover the real problem.
{
	const c = await connectWith({ TENKI_API_KEY: "", TENKI_AUTH_TOKEN: "" }, "offline-noauth");
	const { tools } = await c.listTools();
	check("no credential → server still boots and completes the handshake", true);
	check("no credential → exactly 1 tool registered", tools.length === 1, `${tools.length}: ${tools.map((t) => t.name).join(",")}`);
	check("no credential → that tool is tenki_auth_status", tools[0]?.name === "tenki_auth_status");
	check("auth_status is annotated read-only (survives TENKI_MCP_READONLY)", tools[0]?.annotations?.readOnlyHint === true, JSON.stringify(tools[0]?.annotations));

	const res = await c.callTool({ name: "tenki_auth_status", arguments: {} });
	const s = res.structuredContent ?? {};
	check("auth_status reports authenticated:false", s.authenticated === false, JSON.stringify(s).slice(0, 120));
	check("auth_status reports credential 'none'", s.credential === "none", JSON.stringify(s.credential));
	check("auth_status reports toolsRegistered 1 (degraded mode is visible)", s.toolsRegistered === 1, JSON.stringify(s.toolsRegistered));
	check("auth_status detail names the env vars to set", /TENKI_API_KEY/.test(s.detail ?? "") && /TENKI_AUTH_TOKEN/.test(s.detail ?? ""));
	check("auth_status made no network call (no probe error on a dead endpoint)", s.error === undefined, JSON.stringify(s.error));
	await c.close();
}

// 1b) credential KIND is derived from the prefix, and the token never leaks.
// The endpoint is dead, so the live probe fails — which is the point: a set but
// unusable credential reports authenticated:false WITH the reason.
{
	const ORY = "ory_st_offline_dummy_session";
	const c = await connectWith({ TENKI_API_KEY: "", TENKI_AUTH_TOKEN: ORY }, "offline-ory");
	const res = await c.callTool({ name: "tenki_auth_status", arguments: {} });
	const s = res.structuredContent ?? {};
	check("ory_st_ token classified as oauth_session_token", s.credential === "oauth_session_token", JSON.stringify(s.credential));
	check("auth_status names the source env var", s.source === "TENKI_AUTH_TOKEN", JSON.stringify(s.source));
	check("unreachable endpoint → authenticated:false with an error", s.authenticated === false && typeof s.error === "string", JSON.stringify(s).slice(0, 140));
	check("auth_status never echoes the token", !JSON.stringify(res).includes(ORY));
	await c.close();
}

// 2) the server over a real MCP client (spawned with a dummy key) — no network hit.
// The API endpoint is pinned to a dead loopback port so the suite's "ZERO
// network calls" promise is enforced, not assumed: if a validation regression
// ever lets a request escape, it fails loudly here instead of reaching
// api.tenki.cloud with the dummy key.
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER],
	env: { ...process.env, TENKI_API_KEY: DUMMY, TENKI_API_ENDPOINT: DEAD_ENDPOINT },
	stderr: "ignore",
});
const client = new Client({ name: "offline-test", version: "1.0.0" });

try {
	const init = await client.connect(transport);
	const info = client.getServerVersion?.() ?? init?.serverInfo;
	check("handshake → serverInfo name is 'tenki'", info?.name === "tenki", JSON.stringify(info));
	// VERSION in src/server.ts is hand-maintained; this pins it to package.json
	// so a release bump can never ship the two out of sync again.
	check("serverInfo.version matches package.json version", info?.version === PKG.version, `${info?.version} vs ${PKG.version}`);

	const { tools } = await client.listTools();
	check("advertises 75 tools (74 + tenki_auth_status)", tools.length === 75, `${tools.length}`);
	const names = tools.map((t) => t.name);
	check("standalone registry terminology is absent", !/registry/i.test(JSON.stringify(tools)));
	check("no duplicate tool names", new Set(names).size === names.length);
	check("every tool name matches ^tenki_[a-z0-9_]+$", names.every((n) => /^tenki_[a-z0-9_]+$/.test(n)));
	check("every tool has a non-empty description", tools.every((t) => typeof t.description === "string" && t.description.length > 0));
	check("every tool has an object inputSchema", tools.every((t) => t.inputSchema?.type === "object"));

	// 2b) structured output: tenki_exec (registered via registerTool) declares an
	// outputSchema AND still carries the guard's annotations — proving the modern
	// registration path cannot bypass the least-privilege guard.
	const execTool = tools.find((t) => t.name === "tenki_exec");
	check("tenki_exec advertises an object outputSchema", execTool?.outputSchema?.type === "object");
	check(
		"tenki_exec outputSchema declares ok/exitCode/captureError",
		["ok", "exitCode", "captureError"].every((k) => k in (execTool?.outputSchema?.properties ?? {})),
	);
	check(
		"tenki_exec (registerTool path) still carries guard annotations",
		execTool?.annotations?.readOnlyHint === false && execTool?.annotations?.openWorldHint === true,
		JSON.stringify(execTool?.annotations),
	);
	check("exactly 2 tools declare an outputSchema (update when migrating more)", tools.filter((t) => t.outputSchema).length === 2);

	// 3) pre-network validation: an out-of-range arg is rejected by zod BEFORE any API call
	let rejected = false;
	try {
		const r = await client.callTool({ name: "tenki_create_sandbox", arguments: { cpu_cores: 999 } });
		rejected = r.isError === true; // some SDK versions return isError instead of throwing
	} catch (e) {
		rejected = /-32602|invalid|validation/i.test(e?.message ?? "");
	}
	check("out-of-range tool arg rejected pre-network (cpu_cores 999)", rejected);

	// 3b) shared schemas reject bad input pre-network: port out of range, unsupported git op.
	// A bare `isError === true` is NOT enough to pass: a validation regression
	// would send the request, hit the dead endpoint, and come back isError with
	// a network message. Only a message naming the schema constraint counts.
	{
		const rejectsPreNetwork = async (name, args, constraintRe) => {
			let msg = "";
			try {
				const r = await client.callTool({ name, arguments: args });
				if (r.isError !== true) return false;
				msg = r.content?.find((c) => c.type === "text")?.text ?? "";
			} catch (e) {
				msg = e?.message ?? "";
			}
			return constraintRe.test(msg) && !/fetch failed|econn|socket|network/i.test(msg);
		};

		check(
			"out-of-range port rejected pre-network (99999)",
			await rejectsPreNetwork("tenki_expose_port", { session_id: "s", port: 99999 }, /65535|less than or equal/i),
		);
		check(
			"removed registry_ref is rejected pre-network instead of silently booting the default image",
			await rejectsPreNetwork("tenki_create_sandbox", { registry_ref: "workspace/template:latest" }, /unrecognized key|registry_ref/i),
		);
		check(
			"unsupported git operation rejected pre-network ('push' — API supports clone/checkout/diff/log)",
			await rejectsPreNetwork("tenki_git", { session_id: "s", operation: "push" }, /clone.*checkout.*diff.*log|invalid enum/is),
		);
		check(
			"whitespace-only session id rejected pre-network",
			await rejectsPreNetwork("tenki_get_sandbox", { session_id: "   " }, /at least 1 character|>=1 characters/i),
		);
		check(
			"empty path rejected pre-network (tenki_read_file)",
			await rejectsPreNetwork("tenki_read_file", { session_id: "s", path: "  " }, /must not be empty or whitespace-only/i),
		);
	}

	// 4) unknown tool → clean error (thrown JSON-RPC error OR isError result), not a crash
	let unknownErr = false;
	try {
		const r = await client.callTool({ name: "tenki_does_not_exist", arguments: {} });
		unknownErr = r?.isError === true;
	} catch {
		unknownErr = true; // any clean rejection is fine — the point is no crash/hang
	}
	check("unknown tool name → clean error", unknownErr);

	await client.close();
} catch (e) {
	console.error("  ✗ " + (e?.message ?? e));
	fail++;
	try { await client.close(); } catch { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
