/**
 * Shared test harness for tenki-mcp.
 *
 * Drives the server the way a real MCP client (Claude / Cursor) does: spawns
 * `dist/index.js` over stdio via the official MCP SDK client, calls tools, and
 * parses results. Tracks every created resource and tears it ALL down on
 * cleanup() — even when a check fails — so a test run never leaks sandboxes,
 * volumes, snapshots, or templates (or blows the volume quota).
 *
 *   import { Harness } from "../harness.mjs";
 *   const h = await Harness.connect();
 *   await h.check("create sandbox", async () => {
 *     const s = await h.createSandbox({ cpu_cores: 1 });   // auto-tracked
 *     if (!s.session?.id) throw new Error("no session id");
 *   });
 *   await h.cleanup();
 *   const report = h.report();   // { suite, passed, failed, skipped, results }
 *   await h.close();
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO_ROOT, "dist", "index.js");

export function loadToken() {
	if (process.env.TENKI_API_KEY) return process.env.TENKI_API_KEY;
	if (process.env.TENKI_AUTH_TOKEN) return process.env.TENKI_AUTH_TOKEN;
	try {
		const cfg = readFileSync(`${homedir()}/.config/tenki/config.yaml`, "utf8");
		return (cfg.match(/^auth_token:\s*(.+)$/m)?.[1] ?? "").trim();
	} catch {
		return "";
	}
}

/**
 * True if an error looks like a transient network/environment condition rather
 * than a code bug (connection failure, timeout, or DNS resolution failure). Such
 * checks SKIP, they don't fail.
 */
export function isDataPlaneOutage(err) {
	const m = (err?.message ?? String(err)).toLowerCase();
	return /fetch failed|connect timeout|timeout|econn|could not resolve|resolve host|network is unreachable|temporary failure in name resolution/.test(m);
}

export class Harness {
	constructor(client, suiteName) {
		this.client = client;
		this.suite = suiteName;
		this.results = [];
		this.tools = [];
		this.resources = { sandbox: [], volume: [], snapshot: [], template: [] };
	}

	static async connect(suiteName = "tenki-mcp") {
		const token = loadToken();
		if (!token) throw new Error("No token. Set TENKI_API_KEY or run `tenki login`.");
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [SERVER],
			env: { ...process.env, TENKI_API_KEY: token },
		});
		const client = new Client({ name: "tenki-mcp-test", version: "1.0.0" });
		await client.connect(transport);
		const h = new Harness(client, suiteName);
		const { tools } = await client.listTools();
		h.tools = tools;
		return h;
	}

	/**
	 * Call a tool and return its parsed JSON result. Throws on isError.
	 * Uses a generous 120s timeout: some ops (pause, snapshot, template build)
	 * exceed the MCP client's 60s default — a real integration note for hosts.
	 */
	async call(name, args = {}) {
		const res = await this.client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 120000 });
		const text = res.content?.find((c) => c.type === "text")?.text ?? "";
		if (res.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/** Expect a tool call to FAIL (negative test); returns the error message. */
	async expectError(name, args = {}) {
		try {
			await this.call(name, args);
		} catch (e) {
			return e?.message ?? String(e);
		}
		throw new Error(`${name} unexpectedly succeeded (expected an error)`);
	}

	track(kind, id) {
		if (id && this.resources[kind]) this.resources[kind].push(id);
		return id;
	}

	/** Create a sandbox and auto-track it for cleanup. */
	async createSandbox(args = {}) {
		const r = await this.call("tenki_create_sandbox", { cpu_cores: 1, memory_mb: 1024, max_duration_seconds: 600, idle_timeout_minutes: 5, wait_ready: false, ...args });
		const id = r.session?.id ?? r.session?.sessionId ?? r.sessionId;
		this.track("sandbox", id);
		return { ...r, sessionId: id };
	}

	/** Run a check; record pass/fail. */
	async check(name, fn) {
		try {
			await fn();
			this.results.push({ name, status: "pass" });
			console.log(`  ✓ ${name}`);
		} catch (e) {
			this.results.push({ name, status: "fail", error: (e?.message ?? String(e)).slice(0, 300) });
			console.log(`  ✗ ${name}\n      ${(e?.message ?? e).toString().replace(/\s+/g, " ").slice(0, 240)}`);
		}
	}

	/** Run a data-plane-dependent check; a data-plane outage is a SKIP, not a fail. */
	async checkData(name, fn) {
		try {
			await fn();
			this.results.push({ name, status: "pass" });
			console.log(`  ✓ ${name}`);
		} catch (e) {
			if (isDataPlaneOutage(e)) {
				this.results.push({ name, status: "skip", error: "data-plane endpoint unreachable" });
				console.log(`  … ${name} — skipped (data-plane unreachable)`);
			} else {
				this.results.push({ name, status: "fail", error: (e?.message ?? String(e)).slice(0, 300) });
				console.log(`  ✗ ${name}\n      ${(e?.message ?? e).toString().replace(/\s+/g, " ").slice(0, 240)}`);
			}
		}
	}

	/**
	 * Best-effort teardown of every tracked resource. Never throws.
	 * Order matters: terminate sandboxes FIRST — a snapshot used to boot a sandbox
	 * (or a volume attached to one) can't be deleted while that sandbox is alive
	 * ("snapshot is referenced by one or more resources"), which would leak it.
	 */
	async cleanup() {
		for (const id of this.resources.sandbox) await this.call("tenki_terminate_sandbox", { session_id: id }).catch(() => {});
		for (const id of this.resources.snapshot) await this.call("tenki_delete_snapshot", { snapshot_id: id }).catch(() => {});
		for (const id of this.resources.volume) await this.call("tenki_delete_volume", { volume_id: id }).catch(() => {});
		for (const id of this.resources.template) await this.call("tenki_delete_template", { template_id: id }).catch(() => {});
	}

	report() {
		const passed = this.results.filter((r) => r.status === "pass").length;
		const failed = this.results.filter((r) => r.status === "fail").length;
		const skipped = this.results.filter((r) => r.status === "skip").length;
		return { suite: this.suite, passed, failed, skipped, results: this.results };
	}

	async close() {
		try {
			await this.client.close();
		} catch {
			/* ignore */
		}
	}
}
