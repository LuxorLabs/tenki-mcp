/**
 * client-integration suite — the "does it load in Claude Desktop / Cursor / Claude Code" path.
 *
 *   npm run build && TENKI_API_KEY=… node test/client-integration.test.mjs
 *
 * Covers the client-integration scenarios:
 *   • mcp-handshake-toolslist        — handshake + protocol negotiation (latest AND an
 *                                       older pinned version) + tools/list advertises all
 *                                       71 tools with valid, unique, described object schemas.
 *   • stdout-purity-and-clean-shutdown — stdout carries ONLY JSON-RPC frames (0 bytes idle,
 *                                       banner/logs on stderr); client.close / stdin-EOF /
 *                                       SIGTERM each exit fast with no orphaned pid.
 *   • startup-and-auth-contract      — no key → exit 1 with the documented stderr line;
 *                                       TENKI_AUTH_TOKEN fallback starts; bogus tk_/ory_st_/
 *                                       no-prefix keys each surface a clean 401 through the
 *                                       normal tool-result channel, token never echoed.
 *
 * These scenarios mostly SPAWN dist/index.js directly (child_process / raw JSON-RPC / a fresh
 * MCP client per bad key) with varying env and inspect stdout/stderr/exit — the shared happy
 * connection only covers the positive handshake case. The harness is still used for its
 * check/report/cleanup plumbing and as the canonical advertised-tool set (h.tools).
 */
import { Harness, isDataPlaneOutage } from "./harness.mjs";
import { VERSION } from "../dist/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO_ROOT, "dist", "index.js");
const OLDER_PROTOCOL = "2024-11-05"; // a known older supported MCP protocol version (must still negotiate)
const NAME_RE = /^tenki_[a-z0-9_]+$/;
const DOC_STDERR = "set TENKI_API_KEY (or TENKI_AUTH_TOKEN)"; // documented no-key stderr line
const BANNER = "tenki-mcp running on stdio";

/** Minimal, hermetic env: never inherit the runner's real TENKI_* so probes are deterministic. */
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── raw child spawn plumbing (JSON-RPC over stdio) ───────────────────────────────
const spawned = []; // raw child records
const clientPids = []; // pids of SDK-client-spawned children (for the orphan sweep)

function launch(env, { stdin = "pipe" } = {}) {
	const child = spawn(process.execPath, [SERVER], { env, stdio: [stdin, "pipe", "pipe"] });
	const rec = { child, stdout: "", stderr: "", lines: [], messages: [], _buf: "" };
	child.stdout.on("data", (d) => {
		rec.stdout += d;
		rec._buf += d;
		let i;
		while ((i = rec._buf.indexOf("\n")) >= 0) {
			const line = rec._buf.slice(0, i);
			rec._buf = rec._buf.slice(i + 1);
			if (line.trim()) {
				rec.lines.push(line);
				try {
					rec.messages.push(JSON.parse(line));
				} catch {
					rec.messages.push({ __unparsed: line });
				}
			}
		}
	});
	child.stderr.on("data", (d) => { rec.stderr += d; });
	spawned.push(rec);
	return rec;
}

const send = (rec, obj) => rec.child.stdin.write(JSON.stringify(obj) + "\n");

async function waitForMessage(rec, predicate, ms = 4000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = rec.messages.find(predicate);
		if (found) return found;
		if (Date.now() > deadline) return undefined;
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function waitForStderr(rec, needle, ms = 4000) {
	const deadline = Date.now() + ms;
	while (!rec.stderr.includes(needle)) {
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 20));
	}
	return true;
}

function exited(child) { return child.exitCode !== null || child.signalCode !== null; }

async function waitExit(rec, ms = 4000) {
	if (exited(rec.child)) return { code: rec.child.exitCode, signal: rec.child.signalCode };
	return Promise.race([
		once(rec.child, "exit").then(([code, signal]) => ({ code, signal })),
		new Promise((r) => setTimeout(() => r({ timedOut: true }), ms)),
	]);
}

/** Full raw handshake with a pinned protocolVersion; returns the parsed init + tools/list results. */
async function rawHandshake(protocolVersion) {
	const rec = launch({ ...baseEnv(), TENKI_API_KEY: "tk_offline_dummy" });
	const t0 = Date.now();
	send(rec, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion, capabilities: {}, clientInfo: { name: "ci-probe", version: "1.0.0" } },
	});
	const init = await waitForMessage(rec, (m) => m.id === 1, 4000);
	const initMs = Date.now() - t0;
	send(rec, { jsonrpc: "2.0", method: "notifications/initialized" });
	send(rec, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	const list = await waitForMessage(rec, (m) => m.id === 2, 4000);
	return { rec, init, list, initMs };
}

/** Spawn a fresh MCP client with an arbitrary key, call tenki_whoami, capture the result. */
async function spawnClientWhoami(key) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...baseEnv(), TENKI_API_KEY: key },
		stderr: "pipe",
	});
	const client = new Client({ name: "ci-authprobe", version: "1.0.0" });
	await client.connect(transport); // handshake is offline; never touches the network
	const pid = transport.pid ?? null;
	if (pid) clientPids.push(pid);
	let text = "", isErr = false, threw = false;
	const t0 = Date.now();
	try {
		const res = await client.callTool({ name: "tenki_whoami", arguments: {} }, CallToolResultSchema, { timeout: 30000 });
		text = res.content?.find((c) => c.type === "text")?.text ?? "";
		isErr = !!res.isError;
	} catch (e) {
		threw = true;
		text = e?.message ?? String(e);
	}
	const ms = Date.now() - t0;
	await client.close();
	return { text, isErr, threw, ms, pid };
}

/**
 * Assert a bad-key whoami result is a clean, attributable auth error with no token leak.
 * Throws an outage-flavored error (→ checkData SKIP) if the control plane was unreachable.
 */
function assertClean401(text, key) {
	must(!text.includes(key), `SECURITY: token value echoed in whoami error output`);
	if (/\b401\b|unauthenticated|unauthorized/i.test(text)) return; // clean, attributable auth error
	if (isDataPlaneOutage({ message: text })) throw new Error(`control-plane unreachable: ${text}`); // → SKIP
	throw new Error(`unexpected whoami response (no 401/auth error): ${text.slice(0, 200)}`);
}

// ── run ──────────────────────────────────────────────────────────────────────────
const h = await Harness.connect("client-integration");
console.log(`connected — ${h.tools.length} tools\n`);

try {
	// ══ mcp-handshake-toolslist ═════════════════════════════════════════════════════

	await h.check(`handshake: serverInfo {name:tenki, version:${VERSION}} + capabilities.tools.listChanged`, async () => {
		const info = h.client.getServerVersion();
		must(info?.name === "tenki", `serverInfo.name=${info?.name} (want 'tenki')`);
		must(info?.version === VERSION, `serverInfo.version=${info?.version} (want '${VERSION}')`);
		const caps = h.client.getServerCapabilities();
		must(caps?.tools?.listChanged === true, `capabilities.tools.listChanged=${JSON.stringify(caps?.tools)}`);
	});

	await h.check(`tools/list: exactly ${h.tools.length} unique tenki_* tools, all described with object schemas`, async () => {
		must(h.tools.length === 71, `advertised ${h.tools.length} tools (documented surface = 71 (70 workflow tools + tenki_auth_status); any drift is a regression)`);
		const names = h.tools.map((t) => t.name);
		const dupes = names.filter((n, i) => names.indexOf(n) !== i);
		must(dupes.length === 0, `duplicate tool names: ${JSON.stringify([...new Set(dupes)])}`);
		for (const t of h.tools) {
			must(NAME_RE.test(t.name), `name '${t.name}' fails ${NAME_RE}`);
			must(typeof t.description === "string" && t.description.trim().length > 0, `tool '${t.name}' has no description`);
			const s = t.inputSchema;
			must(s && typeof s === "object" && s.type === "object", `tool '${t.name}' inputSchema.type=${s?.type} (want 'object')`);
			const props = s.properties ?? {};
			for (const req of s.required ?? []) {
				must(Object.prototype.hasOwnProperty.call(props, req), `tool '${t.name}' requires '${req}' absent from properties`);
			}
		}
	});

	// The two raw-handshake checks share one spawned server: negotiate latest, then inspect its stdout.
	const latest = await rawHandshake(LATEST_PROTOCOL_VERSION);

	await h.check(`handshake: raw stdio spawn negotiates latest protocol, advertises ${h.tools.length} tools <2s offline`, async () => {
		must(latest.init, "no initialize response");
		must(!latest.init.error, `initialize errored: ${JSON.stringify(latest.init.error)}`);
		must(latest.init.result?.protocolVersion === LATEST_PROTOCOL_VERSION, `echoed protocol ${latest.init.result?.protocolVersion} (want ${LATEST_PROTOCOL_VERSION})`);
		const si = latest.init.result?.serverInfo;
		must(si?.name === "tenki" && si?.version === VERSION, `serverInfo=${JSON.stringify(si)}`);
		must(latest.init.result?.capabilities?.tools?.listChanged === true, `capabilities=${JSON.stringify(latest.init.result?.capabilities)}`);
		must(latest.list?.result?.tools?.length === h.tools.length, `raw tools/list=${latest.list?.result?.tools?.length} (want ${h.tools.length})`);
		must(latest.initMs < 2000, `handshake took ${latest.initMs}ms (want <2000ms offline)`);
	});

	await h.check("stdout purity: every stdout frame after handshake+tools/list is valid JSON-RPC; banner only on stderr", async () => {
		must(latest.rec.lines.length >= 2, `expected ≥2 stdout frames (init+tools), got ${latest.rec.lines.length}`);
		for (const m of latest.rec.messages) {
			must(!m.__unparsed, `non-JSON stray write on stdout: ${String(m.__unparsed).slice(0, 120)}`);
			must(m.jsonrpc === "2.0", `stdout frame not JSON-RPC 2.0: ${JSON.stringify(m).slice(0, 120)}`);
		}
		must(!latest.rec.stdout.includes(BANNER), "banner leaked onto stdout (must be stderr only)");
		must(latest.rec.stderr.includes(BANNER), "startup banner missing from stderr");
		latest.rec.child.stdin.end();
	});

	await h.check(`handshake: older protocol (${OLDER_PROTOCOL}) negotiates without disconnect, still ${h.tools.length} tools`, async () => {
		const { rec, init, list } = await rawHandshake(OLDER_PROTOCOL);
		must(init, "no initialize response for older protocol");
		must(!init.error, `older-protocol initialize errored: ${JSON.stringify(init.error)}`);
		must(init.result?.protocolVersion === OLDER_PROTOCOL, `echoed ${init.result?.protocolVersion} (want ${OLDER_PROTOCOL} — server should honor a supported older version)`);
		must(list?.result?.tools?.length === h.tools.length, `older-protocol tools/list=${list?.result?.tools?.length} (want ${h.tools.length})`);
		must(!exited(rec.child), "server disconnected after older-protocol handshake");
		rec.child.stdin.end();
	});

	// ══ stdout-purity-and-clean-shutdown ════════════════════════════════════════════

	await h.check("shutdown: idle EOF → 0 bytes stdout, banner on stderr, exit 0 within 2s", async () => {
		const rec = launch({ ...baseEnv(), TENKI_API_KEY: "tk_offline_dummy" });
		rec.child.stdin.end(); // immediate EOF, no requests
		const t0 = Date.now();
		const ex = await waitExit(rec, 3000);
		must(!ex.timedOut, "server did not exit on stdin EOF (hang)");
		must(ex.code === 0, `idle-EOF exit code=${ex.code} signal=${ex.signal} (want 0)`);
		must(rec.stdout.length === 0, `idle server wrote ${rec.stdout.length} bytes to stdout (want 0)`);
		must(rec.stderr.includes(BANNER), "banner missing from stderr on idle launch");
		must(Date.now() - t0 < 2000, "idle-EOF shutdown slower than 2s");
	});

	await h.check("shutdown: client.close() reaps the child fast with no orphan pid", async () => {
		const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...baseEnv(), TENKI_API_KEY: "tk_offline_dummy" }, stderr: "pipe" });
		const client = new Client({ name: "ci-close", version: "1.0.0" });
		await client.connect(transport);
		const pid = transport.pid;
		must(typeof pid === "number", "no child pid from transport");
		const t0 = Date.now();
		await client.close();
		const closeMs = Date.now() - t0;
		must(closeMs < 2000, `client.close() took ${closeMs}ms (want <2000ms)`);
		// Give the OS a beat to reap, then confirm the pid is gone.
		await new Promise((r) => setTimeout(r, 300));
		let alive = true;
		try { process.kill(pid, 0); } catch { alive = false; }
		must(!alive, `orphaned child pid ${pid} still alive after client.close()`);
	});

	await h.check("shutdown: SIGTERM on a running server exits within 2s, no orphan", async () => {
		const rec = launch({ ...baseEnv(), TENKI_API_KEY: "tk_offline_dummy" });
		must(await waitForStderr(rec, BANNER, 3000), "server never printed its startup banner");
		const pid = rec.child.pid;
		const t0 = Date.now();
		rec.child.kill("SIGTERM");
		const ex = await waitExit(rec, 3000);
		must(!ex.timedOut, "server ignored SIGTERM (hang)");
		must(Date.now() - t0 < 2000, "SIGTERM shutdown slower than 2s");
		await new Promise((r) => setTimeout(r, 200));
		let alive = true;
		try { process.kill(pid, 0); } catch { alive = false; }
		must(!alive, `orphaned child pid ${pid} still alive after SIGTERM`);
	});

	// ══ startup-and-auth-contract ═══════════════════════════════════════════════════

	await h.check("auth: no key → exit 1 + documented stderr line, 0 bytes stdout", async () => {
		const rec = launch(baseEnv(), { stdin: "ignore" }); // neither TENKI_API_KEY nor TENKI_AUTH_TOKEN
		const ex = await waitExit(rec, 3000);
		must(!ex.timedOut, "no-key launch did not exit (should fail fast)");
		must(ex.code === 1, `no-key exit code=${ex.code} signal=${ex.signal} (want 1)`);
		must(rec.stderr.includes(DOC_STDERR), `stderr missing documented line; got: ${JSON.stringify(rec.stderr.trim())}`);
		must(rec.stdout.length === 0, `no-key launch wrote ${rec.stdout.length} bytes to stdout (want 0)`);
	});

	await h.check("auth: TENKI_AUTH_TOKEN fallback boots (banner on stderr, alive, 0 bytes stdout)", async () => {
		const rec = launch({ ...baseEnv(), TENKI_AUTH_TOKEN: "tk_offline_dummy_authtoken" }); // fallback env, no TENKI_API_KEY
		must(await waitForStderr(rec, BANNER, 3000), "fallback launch never printed the banner");
		must(!exited(rec.child), "fallback launch exited instead of running");
		must(rec.stdout.length === 0, `fallback launch wrote ${rec.stdout.length} bytes to stdout (want 0)`);
		rec.child.stdin.end();
	});

	// Bad-key 401s require the live control plane — a network outage SKIPs (not a fail).
	await h.checkData("auth: bogus tk_ key → clean 401 via whoami (Bearer branch), token not echoed", async () => {
		const r = await spawnClientWhoami("tk_deadbeef_not_a_real_key_000111222");
		must(!r.threw, `whoami threw instead of returning an isError result: ${r.text.slice(0, 160)}`);
		must(r.isErr, `whoami on a bad key returned success (isError=false): ${r.text.slice(0, 160)}`);
		must(r.ms < 5000, `bad-key whoami took ${r.ms}ms (want <5s, no hang)`);
		assertClean401(r.text, "tk_deadbeef_not_a_real_key_000111222");
	});

	await h.checkData("auth: bogus ory_st_ key → clean 401 via whoami (X-Session-Token branch), token not echoed", async () => {
		const r = await spawnClientWhoami("ory_st_deadbeefnotarealsessiontoken000");
		must(!r.threw, `whoami threw instead of returning an isError result: ${r.text.slice(0, 160)}`);
		must(r.isErr, `whoami on a bad key returned success (isError=false): ${r.text.slice(0, 160)}`);
		must(r.ms < 5000, `bad-key whoami took ${r.ms}ms (want <5s, no hang)`);
		assertClean401(r.text, "ory_st_deadbeefnotarealsessiontoken000");
	});

	await h.checkData("auth: bogus no-prefix key → clean 401 via whoami (Cookie branch), token not echoed", async () => {
		const r = await spawnClientWhoami("plainjunkcookievalue000111222333");
		must(!r.threw, `whoami threw instead of returning an isError result: ${r.text.slice(0, 160)}`);
		must(r.isErr, `whoami on a bad key returned success (isError=false): ${r.text.slice(0, 160)}`);
		must(r.ms < 5000, `bad-key whoami took ${r.ms}ms (want <5s, no hang)`);
		assertClean401(r.text, "plainjunkcookievalue000111222333");
	});

	// ══ orphan sweep — the whole point of the shutdown scenarios ═════════════════════
	await h.check("no orphan pids: every spawned server child was reaped", async () => {
		const orphans = [];
		for (const rec of spawned) {
			if (!exited(rec.child)) {
				rec.child.stdin.end();
				const ex = await waitExit(rec, 1500);
				if (ex.timedOut && !exited(rec.child)) orphans.push(`raw:${rec.child.pid}`);
			}
		}
		for (const pid of clientPids) {
			try { process.kill(pid, 0); orphans.push(`client:${pid}`); } catch { /* reaped */ }
		}
		must(orphans.length === 0, `orphaned server pids survived the suite: ${orphans.join(", ")}`);
	});
} catch (e) {
	console.error("suite error:", e?.message ?? e);
} finally {
	await h.cleanup(); // no API resources created; symmetry with the other suites
	// Best-effort: never leave a spawned server behind, even on an early throw.
	for (const rec of spawned) {
		if (!exited(rec.child)) { try { rec.child.kill("SIGKILL"); } catch { /* ignore */ } }
	}
	const r = h.report();
	console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${h.tools.length} tools)`);
	const bad = r.results.filter((x) => x.status === "fail");
	if (bad.length) console.log("FAILURES:\n" + bad.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	const skipped = r.results.filter((x) => x.status === "skip");
	if (skipped.length) console.log("SKIPPED:\n" + skipped.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	await h.close();
	process.exitCode = r.failed ? 1 : 0;
}
