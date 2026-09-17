/**
 * Tenki MCP App server.
 *
 * Three MCP Apps the agent can open, each backed by real Tenki Sandboxes:
 *   run_code_in_sandbox  → Sandbox Console  (code, output, a live shell into the VM)
 *   launch_web_app       → Live Preview     (the app, served from the VM, framed in chat)
 *   show_sandbox_fleet   → Fleet            (every demo VM, with teardown)
 *
 * The widgets call back into the app-only tools below (visibility: ["app"]) —
 * hidden from the model, reachable only from the UI through the host's proxy.
 *
 * Streamable HTTP, stateless: a fresh McpServer per request, which is what
 * CopilotKit's MCP Apps middleware expects (it opens a connection per call).
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config as loadEnv } from "dotenv";
import type { Request, Response } from "express";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
	DEMO_TAG,
	FILE_FOR,
	SimulatedBackend,
	appPath,
	createBackend,
	isCapacityError,
	webPath,
	type Language,
	type RunOutput,
	type VmInfo,
} from "./tenki.ts";

loadEnv({ path: [path.join(import.meta.dirname, ".env"), path.join(import.meta.dirname, "..", ".env")], quiet: true });

const PORT = Number(process.env.MCP_PORT || 3108);
const PUBLIC_BASE = process.env.MCP_PUBLIC_URL || `http://localhost:${PORT}`;
const DIST = path.join(import.meta.dirname, "dist", "index.html");
const backend = createBackend(PUBLIC_BASE);
/** Warm pool use: "fallback" (default) when Tenki can't place a new VM, "prefer" to skip booting, "off". */
const POOL = (process.env.TENKI_POOL || "fallback").toLowerCase();
/** Listing sandboxes this demo didn't create is off by default: a shared workspace can hold other projects' VMs, and the fleet may be on a projector. */
const ALLOW_ALL = process.env.TENKI_FLEET_ALLOW_ALL === "1";

const VIEWS = {
	console: "ui://tenki/sandbox-console.html",
	preview: "ui://tenki/live-preview.html",
	fleet: "ui://tenki/fleet.html",
} as const;

// ─── helpers ────────────────────────────────────────────────────────────────

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24) || "app";
const vmName = (title: string) => `ck-${slug(title)}-${Math.random().toString(36).slice(2, 6)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more chars shown in the UI]` : s);

/** Refuse to touch a sandbox this demo did not create — the workspace may hold other people's VMs. */
async function demoVm(id: string): Promise<VmInfo> {
	const vm = await backend.get(id);
	if (!vm.demo) {
		throw new Error(`Sandbox ${id} was not created by this demo (no "${DEMO_TAG}" tag); refusing to run code in or destroy it.`);
	}
	return vm;
}

/** A tool result carrying both the widget's data and a compact text rendering for the model. */
function result(structured: Record<string, unknown>, text: string): CallToolResult {
	return { structuredContent: { mode: backend.mode, ...structured }, content: [{ type: "text", text }] };
}

function failure(kind: string, err: unknown, extra: Record<string, unknown> = {}): CallToolResult {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[tenki-mcp-app] ${kind} failed:`, message);
	return {
		isError: true,
		structuredContent: { kind, mode: backend.mode, error: message, ...extra },
		content: [{ type: "text", text: `${kind} failed: ${message}` }],
	};
}

function runText(r: RunOutput): string {
	return `exit ${r.exitCode} in ${(r.runMs / 1000).toFixed(2)}s\n--- stdout ---\n${clip(r.stdout, 3000) || "(empty)"}\n--- stderr ---\n${clip(r.stderr, 2000) || "(empty)"}`;
}

type Acquired = { vm: VmInfo; bootMs: number | null; reused: boolean; pooled: boolean; replaced?: string };

const poolLastUsed = new Map<string, number>();

/** The least recently used running warm VM, if any. */
async function takeWarmVm(): Promise<VmInfo | undefined> {
	const warm = (await backend.list(false)).filter((v) => v.warm && v.state.includes("RUNNING"));
	warm.sort((a, b) => (poolLastUsed.get(a.id) ?? 0) - (poolLastUsed.get(b.id) ?? 0));
	const vm = warm[0];
	if (vm) poolLastUsed.set(vm.id, Date.now());
	return vm;
}

/**
 * Reuse a sandbox if one was named and is still alive; otherwise boot a fresh
 * one. If Tenki can't place a new VM (capacity), fall back to the warm pool
 * that `npm run warm` pre-booted, so a capacity blip doesn't sink a live demo.
 */
async function acquire(opts: {
	title: string;
	sandboxId?: string;
	allowInbound: boolean;
	allowOutbound: boolean;
}): Promise<Acquired> {
	let replaced: string | undefined;
	if (opts.sandboxId) {
		try {
			const vm = await demoVm(opts.sandboxId);
			if (vm.state.includes("RUNNING")) return { vm, bootMs: null, reused: true, pooled: false };
			replaced = opts.sandboxId;
		} catch (err) {
			if (err instanceof Error && err.message.includes("refusing")) throw err;
			replaced = opts.sandboxId;
		}
	}
	if (POOL === "prefer") {
		const vm = await takeWarmVm();
		if (vm) return { vm, bootMs: null, reused: true, pooled: true, replaced };
	}
	try {
		const { vm, bootMs } = await backend.create({
			name: vmName(opts.title),
			cpuCores: 2,
			memoryMb: 4096,
			allowInbound: opts.allowInbound,
			allowOutbound: opts.allowOutbound,
		});
		return { vm, bootMs, reused: false, pooled: false, replaced };
	} catch (err) {
		if (POOL === "off" || !isCapacityError(err)) throw err;
		const vm = await takeWarmVm();
		if (!vm) {
			throw new Error(
				`Tenki has no capacity to place a new sandbox right now, and there is no warm pool to fall back to (run \`npm run warm\` while capacity is available). Details: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		console.warn(`[tenki-mcp-app] capacity unavailable — using warm pool VM ${vm.name}`);
		return { vm, bootMs: null, reused: true, pooled: true, replaced };
	}
}

const poolNote = (a: Acquired) => (a.pooled ? " (from the pre-booted warm pool)" : "");

// ─── server ─────────────────────────────────────────────────────────────────

const sandboxIdSchema = z.string().min(1).describe("Sandbox id returned by an earlier call.");

function createServer(): McpServer {
	const server = new McpServer({ name: "tenki-sandboxes", version: "0.1.0" });

	// Model-facing app: run code in a sandbox → Sandbox Console.
	registerAppTool(
		server,
		"run_code_in_sandbox",
		{
			title: "Run code in a Tenki Sandbox",
			description:
				"Run a Python, JavaScript (Node) or shell program in an isolated Tenki Sandbox (boots in ~2s) and open the interactive Sandbox Console: " +
				"the user sees the code, its output, timings, and gets a live shell into the same sandbox. " +
				"Pass sandbox_id from an earlier result to iterate in the same sandbox (files persist, no boot). " +
				"Standard libraries only unless allow_internet is true (then pip/npm installs work). Keep programs self-contained and print results to stdout.",
			inputSchema: {
				title: z.string().max(60).describe("Short human label for the run, e.g. 'Monte Carlo estimate of pi'."),
				language: z.enum(["python", "javascript", "shell"]).describe("Interpreter."),
				code: z.string().min(1).describe("The complete program."),
				sandbox_id: sandboxIdSchema.optional(),
				allow_internet: z.boolean().optional().describe("Give a NEW sandbox outbound internet (for package installs or APIs). Default false."),
				timeout_seconds: z.number().int().min(1).max(300).optional().describe("Max run time. Default 60."),
			},
			_meta: { ui: { resourceUri: VIEWS.console } },
		},
		async ({ title, language, code, sandbox_id, allow_internet, timeout_seconds }) => {
			const started = Date.now();
			try {
				const acquired = await acquire({
					title,
					sandboxId: sandbox_id,
					allowInbound: false,
					allowOutbound: Boolean(allow_internet),
				});
				const { vm, bootMs, reused, pooled, replaced } = acquired;
				const { file, command } = FILE_FOR[language as Language];
				const uploadMs = await backend.writeFiles(vm.id, [{ path: appPath(file), content: code }]);
				const run = await backend.exec(vm.id, command, timeout_seconds ?? 60);
				const timings = { bootMs, uploadMs, runMs: run.runMs, totalMs: Date.now() - started };
				return result(
					{ kind: "run", title, language, file, code, sandbox: vm, reused, pooled, replaced, timings, run: { ...run, command } },
					`${reused ? "Reused" : "Booted"} Tenki Sandbox ${vm.name}${poolNote(acquired)} (sandbox_id: ${vm.id})${replaced ? ` — the previous sandbox ${replaced} was gone, so a fresh one was booted` : ""}` +
						`${bootMs !== null ? `, boot ${(bootMs / 1000).toFixed(2)}s` : ""}. Ran \`${command}\`: ${runText(run)}\n` +
						`${backend.mode === "simulated" ? "NOTE: SIMULATED — no TENKI_API_KEY is configured, nothing actually ran. Tell the user.\n" : ""}` +
						"The user is looking at an interactive console for this sandbox with the code and full output; don't repeat the output verbatim.",
				);
			} catch (err) {
				return failure("run", err, { title, language, code });
			}
		},
	);

	// Model-facing app: serve a web app from a sandbox → Live Preview.
	registerAppTool(
		server,
		"launch_web_app",
		{
			title: "Launch a web app in a Tenki Sandbox",
			description:
				"Write files into a fresh Tenki Sandbox, start a web server, expose its port on a public preview URL, and show the running app live inside the chat. " +
				"For UIs, pass a single self-contained page (inline CSS/JS) as `html` — it becomes index.html, served by the default static server. " +
				"For an API or dynamic server, write it with the standard library (python http.server or node http) and pass start_command; the server must listen on 0.0.0.0 and the port given (also exported as $PORT). " +
				"Pass sandbox_id to redeploy into the same VM.",
			inputSchema: {
				title: z.string().max(60).describe("Short name of the app, e.g. 'Pomodoro timer'."),
				html: z.string().optional().describe("Full contents of index.html. Use this for single-page apps."),
				files: z
					.array(
						z.object({
							path: z.string().describe("Relative path, e.g. 'server.py' or 'static/app.js'."),
							content: z.string().describe("Full file contents."),
						}),
					)
					.optional()
					.describe("Other files to write into the app directory (a backend, extra assets)."),
				start_command: z
					.string()
					.optional()
					.describe("Command that starts the server (run from the app directory). Default: python3 -m http.server $PORT --bind 0.0.0.0"),
				port: z.number().int().min(1024).max(65535).optional().describe("Port the server listens on. Default 8080."),
				sandbox_id: sandboxIdSchema.optional(),
				allow_internet: z.boolean().optional().describe("Give a NEW sandbox outbound internet (for package installs). Default false."),
			},
			_meta: { ui: { resourceUri: VIEWS.preview } },
		},
		async ({ title, html, files: extra, start_command, port, sandbox_id, allow_internet }) => {
			const started = Date.now();
			// `html` is a top-level string so hosts can stream it into a live preview while the model writes it.
			const files = [...(html ? [{ path: "index.html", content: html }] : []), ...(extra ?? [])];
			let p = port ?? 8080;
			try {
				if (files.length === 0) throw new Error("Nothing to deploy: pass `html` (index.html contents) or `files`.");
				const acquired = await acquire({
					title,
					sandboxId: sandbox_id,
					allowInbound: true,
					allowOutbound: Boolean(allow_internet),
				});
				const { vm, bootMs, reused, pooled, replaced } = acquired;
				// A new app landing on a shared pool VM gets its own port (and so its own directory and URL).
				if (pooled && !port) p = 8100 + Math.floor(Math.random() * 800);
				const startCommand = start_command?.trim() || `python3 -m http.server ${p} --bind 0.0.0.0`;
				const resolved = files.map((f) => ({ path: webPath(p, f.path), content: f.content }));
				const uploadMs = await backend.writeFiles(vm.id, resolved);
				const t0 = Date.now();
				await backend.startServer(vm.id, startCommand, p);
				const listening = await backend.waitForPort(vm.id, p);
				const startMs = Date.now() - t0;
				if (!listening) {
					const log = await backend.readLog(vm.id, p).catch(() => "");
					return failure("preview", new Error(`The server did not start listening on port ${p} within 15s.\n--- server log ---\n${clip(log, 2500)}`), {
						title,
						sandbox: vm,
						port: p,
						startCommand,
						files: files.map((f) => f.path),
						log,
					});
				}
				const t1 = Date.now();
				const previewUrl = await backend.expose(vm.id, p);
				const exposeMs = Date.now() - t1;
				const log = await backend.readLog(vm.id, p).catch(() => "");
				const timings = { bootMs, uploadMs, startMs, exposeMs, totalMs: Date.now() - started };
				return result(
					{ kind: "preview", title, sandbox: vm, reused, pooled, replaced, port: p, previewUrl, startCommand, files: files.map((f) => f.path), log, timings },
					`${title} is live at ${previewUrl} — served from Tenki Sandbox ${vm.name}${poolNote(acquired)} (sandbox_id: ${vm.id}), port ${p}, command \`${startCommand}\`, ` +
						`${bootMs !== null ? `boot ${(bootMs / 1000).toFixed(2)}s, ` : ""}total ${((Date.now() - started) / 1000).toFixed(1)}s.\n` +
						`${backend.mode === "simulated" ? "NOTE: SIMULATED — no TENKI_API_KEY is configured; static files are served locally instead of from a sandbox. Tell the user.\n" : ""}` +
						"The user sees the running app embedded in the chat.",
				);
			} catch (err) {
				return failure("preview", err, { title, port: p, files: files.map((f) => f.path) });
			}
		},
	);

	// Model-facing app: the fleet dashboard.
	registerAppTool(
		server,
		"show_sandbox_fleet",
		{
			title: "Show Tenki sandbox fleet",
			description:
				"Open a live dashboard of the Tenki Sandboxes this demo has running (state, size, age) with one-click teardown. Use when the user asks what's running or wants to clean up.",
			inputSchema: {
				include_all: z.boolean().optional().describe("Also list workspace sandboxes this demo did not create (read-only; only if the server allows it)."),
			},
			_meta: { ui: { resourceUri: VIEWS.fleet } },
		},
		async ({ include_all }) => {
			try {
				const vms = await backend.list(ALLOW_ALL && Boolean(include_all));
				const lines = vms.map((v) => `- ${v.name || v.id} (${v.id}) ${v.state}, ${v.cpuCores} vCPU / ${v.memoryMb} MB${v.demo ? "" : " [not a demo VM]"}`);
				return result(
					{ kind: "fleet", includeAll: ALLOW_ALL && Boolean(include_all), allowAll: ALLOW_ALL, vms, tag: DEMO_TAG },
					`${vms.length} sandbox(es):\n${lines.join("\n") || "(none running)"}\nThe user sees a live fleet dashboard.`,
				);
			} catch (err) {
				return failure("fleet", err);
			}
		},
	);

	// ── app-only tools: called from the widgets, never offered to the model ──
	const appOnly = { ui: { visibility: ["app" as const] } };

	registerAppTool(
		server,
		"vm_exec",
		{
			description: "Run a shell command in a demo sandbox (from the console's terminal).",
			inputSchema: { sandbox_id: sandboxIdSchema, command: z.string().min(1), timeout_seconds: z.number().int().min(1).max(300).optional() },
			_meta: appOnly,
		},
		async ({ sandbox_id, command, timeout_seconds }) => {
			try {
				await demoVm(sandbox_id);
				const run = await backend.exec(sandbox_id, command, timeout_seconds ?? 60);
				return result({ kind: "exec", run }, runText(run));
			} catch (err) {
				return failure("exec", err);
			}
		},
	);

	registerAppTool(
		server,
		"vm_run_code",
		{
			description: "Overwrite the program in a demo sandbox and run it (the console's edit-and-rerun).",
			inputSchema: { sandbox_id: sandboxIdSchema, language: z.enum(["python", "javascript", "shell"]), code: z.string().min(1) },
			_meta: appOnly,
		},
		async ({ sandbox_id, language, code }) => {
			try {
				await demoVm(sandbox_id);
				const { file, command } = FILE_FOR[language as Language];
				const uploadMs = await backend.writeFiles(sandbox_id, [{ path: appPath(file), content: code }]);
				const run = await backend.exec(sandbox_id, command, 60);
				return result({ kind: "exec", uploadMs, run: { ...run, command } }, runText(run));
			} catch (err) {
				return failure("exec", err);
			}
		},
	);

	registerAppTool(
		server,
		"vm_status",
		{ description: "Current state of a sandbox.", inputSchema: { sandbox_id: sandboxIdSchema }, _meta: appOnly },
		async ({ sandbox_id }) => {
			try {
				const vm = await backend.get(sandbox_id);
				return result({ kind: "status", sandbox: vm }, `${vm.id} ${vm.state}`);
			} catch (err) {
				return failure("status", err, { sandboxId: sandbox_id });
			}
		},
	);

	registerAppTool(
		server,
		"vm_logs",
		{ description: "Tail a demo web app's server log.", inputSchema: { sandbox_id: sandboxIdSchema, port: z.number().int() }, _meta: appOnly },
		async ({ sandbox_id, port }) => {
			try {
				await demoVm(sandbox_id);
				const log = await backend.readLog(sandbox_id, port);
				return result({ kind: "logs", log }, log);
			} catch (err) {
				return failure("logs", err);
			}
		},
	);

	registerAppTool(
		server,
		"vm_destroy",
		{ description: "Terminate a demo sandbox.", inputSchema: { sandbox_id: sandboxIdSchema }, _meta: appOnly },
		async ({ sandbox_id }) => {
			try {
				await demoVm(sandbox_id);
				await backend.destroy(sandbox_id);
				return result({ kind: "destroyed", sandboxId: sandbox_id }, `Terminated ${sandbox_id}.`);
			} catch (err) {
				return failure("destroy", err);
			}
		},
	);

	registerAppTool(
		server,
		"fleet_list",
		{ description: "List sandboxes for the fleet dashboard.", inputSchema: { include_all: z.boolean().optional() }, _meta: appOnly },
		async ({ include_all }) => {
			try {
				const vms = await backend.list(ALLOW_ALL && Boolean(include_all));
				return result({ kind: "fleet", includeAll: ALLOW_ALL && Boolean(include_all), allowAll: ALLOW_ALL, vms, tag: DEMO_TAG }, `${vms.length} sandbox(es)`);
			} catch (err) {
				return failure("fleet", err);
			}
		},
	);

	registerAppTool(
		server,
		"fleet_destroy_all",
		{ description: "Terminate every sandbox this demo created, except the warm pool.", inputSchema: {}, _meta: appOnly },
		async () => {
			try {
				// The warm pool survives cleanup; drop it deliberately with `npm run warm -- --drop`.
				const vms = (await backend.list(false)).filter((v) => v.demo && !v.warm);
				const settled = await Promise.allSettled(vms.map((v) => backend.destroy(v.id)));
				const destroyed = settled.filter((s) => s.status === "fulfilled").length;
				return result({ kind: "destroyed-all", destroyed, attempted: vms.length }, `Terminated ${destroyed}/${vms.length} demo sandboxes.`);
			} catch (err) {
				return failure("destroy-all", err);
			}
		},
	);

	// One bundle, three views: the view is chosen by the resource URI the host fetched.
	for (const [view, uri] of Object.entries(VIEWS)) {
		registerAppResource(
			server,
			`tenki-${view}`,
			uri,
			{
				mimeType: RESOURCE_MIME_TYPE,
				description: `Tenki ${view} widget`,
				_meta: { ui: { prefersBorder: false, csp: { frameDomains: ["https://*.tenki.sh", PUBLIC_BASE], connectDomains: [] } } },
			},
			async () => {
				const html = await fs.readFile(DIST, "utf-8");
				const boot = `<script>window.__TENKI_VIEW__=${JSON.stringify(view)};</script>`;
				return {
					contents: [
						{
							uri,
							mimeType: RESOURCE_MIME_TYPE,
							text: html.replace("<head>", `<head>${boot}`),
							_meta: { ui: { prefersBorder: false, csp: { frameDomains: ["https://*.tenki.sh", PUBLIC_BASE] } } },
						},
					],
				};
			},
		);
	}

	return server;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

// No CORS: only the Copilot Runtime (server-side) talks to this endpoint. Allowing browser
// origins would let any page the presenter opens drive their Tenki account through localhost.
// MCP_HOST=0.0.0.0 (a hosted deployment) turns off the SDK's localhost DNS-rebinding guard,
// so MCP_TOKEN is what stands between the public internet and this Tenki account.
const HOST = process.env.MCP_HOST || "127.0.0.1";
const TOKEN = process.env.MCP_TOKEN || "";
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !TOKEN) {
	console.error("[tenki-mcp-app] refusing to bind a non-loopback host without MCP_TOKEN — anyone could then run code in this Tenki workspace.");
	process.exit(1);
}
const app = createMcpExpressApp({ host: HOST, ...(process.env.MCP_ALLOWED_HOSTS ? { allowedHosts: process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()) } : {}) });

/** Constant-time bearer check on /mcp when MCP_TOKEN is set. */
function authorized(req: Request): boolean {
	if (!TOKEN) return true;
	const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	const a = Buffer.from(given);
	const b = Buffer.from(TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

app.all("/mcp", async (req: Request, res: Response) => {
	if (!authorized(req)) {
		res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
		return;
	}
	const server = createServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		transport.close().catch(() => {});
		server.close().catch(() => {});
	});
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
	} catch (error) {
		console.error("[tenki-mcp-app] MCP error:", error);
		if (!res.headersSent) {
			res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
		}
	}
});

app.get("/healthz", (_req, res) => {
	res.json({ ok: true, mode: backend.mode, tag: DEMO_TAG });
});

// Simulated mode only: serve the static files the agent "deployed" so the preview still renders.
app.get("/simulated-preview/:id/:port/{*rest}", (req, res) => {
	if (!(backend instanceof SimulatedBackend)) {
		res.status(404).end();
		return;
	}
	const rest = (req.params as { rest?: string[] }).rest;
	const rel = rest?.join("/") ?? "";
	const body = backend.file(String(req.params.id), Number(req.params.port), rel);
	if (body === undefined) {
		res.status(404).type("text/plain").send("Not found (simulated preview)");
		return;
	}
	const ext = path.extname(rel || "index.html");
	const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
	res.type(types[ext] ?? "text/plain").send(body);
});

// Simulated rehearsal of a stage outage: TENKI_SIMULATE_WARM=2 pre-boots a simulated warm pool
// (pair with TENKI_SIMULATE_NO_CAPACITY=1 to watch the fallback kick in).
if (backend instanceof SimulatedBackend && Number(process.env.TENKI_SIMULATE_WARM) > 0) {
	for (let i = 0; i < Number(process.env.TENKI_SIMULATE_WARM); i++) {
		void backend.create({ name: `ck-warm-sim-${i + 1}`, cpuCores: 2, memoryMb: 4096, allowInbound: true, allowOutbound: true, warm: true });
	}
}

app.listen(PORT, (err?: Error) => {
	if (err) {
		console.error("[tenki-mcp-app] failed to start:", err);
		process.exit(1);
	}
	console.log(`[tenki-mcp-app] listening on http://localhost:${PORT}/mcp — mode: ${backend.mode.toUpperCase()}`);
	if (backend.mode === "simulated") {
		console.log("[tenki-mcp-app] no TENKI_API_KEY: SIMULATED mode, nothing will execute. Put the key in examples/copilotkit-mcp-apps/.env.");
	}
});
