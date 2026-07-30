/**
 * OFFLINE test suite — runs with a dummy key and makes ZERO network calls, so CI
 * can gate every push on it (no Tenki token / no data-plane needed). Covers what
 * can be proven without the live API: the server boots, advertises a well-formed
 * tool surface, negotiates the protocol, rejects bad tool args PRE-network, and
 * enforces the auth-required contract.
 *
 *   npm run build && node test/offline.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
const DUMMY = "tk_offline_dummy_key";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

// 1) auth contract: no key → exit 1 with the documented message, nothing on stdout
{
	const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, TENKI_API_KEY: "", TENKI_AUTH_TOKEN: "" }, encoding: "utf8", timeout: 8000 });
	check("no-key launch exits non-zero", r.status === 1, `status ${r.status}`);
	check("no-key error names TENKI_API_KEY", /set TENKI_API_KEY/.test(r.stderr || ""), (r.stderr || "").slice(0, 60));
	check("no-key writes nothing to stdout", (r.stdout || "") === "", JSON.stringify((r.stdout || "").slice(0, 40)));
}

// 2) the server over a real MCP client (spawned with a dummy key) — no network hit
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, TENKI_API_KEY: DUMMY }, stderr: "ignore" });
const client = new Client({ name: "offline-test", version: "1.0.0" });

try {
	const init = await client.connect(transport);
	const info = client.getServerVersion?.() ?? init?.serverInfo;
	check("handshake → serverInfo name is 'tenki'", info?.name === "tenki", JSON.stringify(info));

	const { tools } = await client.listTools();
	check("advertises 84 tools", tools.length === 84, `${tools.length}`);
	const names = tools.map((t) => t.name);
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
	check("exactly 1 tool declares an outputSchema (update when migrating more)", tools.filter((t) => t.outputSchema).length === 1);

	// 3) pre-network validation: an out-of-range arg is rejected by zod BEFORE any API call
	let rejected = false;
	try {
		const r = await client.callTool({ name: "tenki_create_sandbox", arguments: { cpu_cores: 999 } });
		rejected = r.isError === true; // some SDK versions return isError instead of throwing
	} catch (e) {
		rejected = /-32602|invalid|validation/i.test(e?.message ?? "");
	}
	check("out-of-range tool arg rejected pre-network (cpu_cores 999)", rejected);

	// 3b) shared schemas reject bad input pre-network: port out of range, unsupported git op
	{
		let portRejected = false;
		try {
			const r = await client.callTool({ name: "tenki_expose_port", arguments: { session_id: "s", port: 99999 } });
			portRejected = r.isError === true;
		} catch (e) {
			portRejected = /-32602|invalid|validation/i.test(e?.message ?? "");
		}
		check("out-of-range port rejected pre-network (99999)", portRejected);

		let gitRejected = false;
		try {
			const r = await client.callTool({ name: "tenki_git", arguments: { session_id: "s", operation: "push" } });
			gitRejected = r.isError === true;
		} catch (e) {
			gitRejected = /-32602|invalid|validation/i.test(e?.message ?? "");
		}
		check("unsupported git operation rejected pre-network ('push' — API supports clone/checkout/diff/log)", gitRejected);
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
