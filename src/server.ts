/**
 * Shared MCP server factory — builds a server with every tool module registered.
 * Used by both transports: stdio (index.ts) and HTTP (http.ts).
 *
 * Security controls (see SECURITY.md; maps to CSA MCP Server Top-10 MCP-07
 * "excessive permissions"). Every tool is registered through a guard that:
 *   1. tags it with MCP annotations (readOnlyHint / destructiveHint / openWorldHint)
 *      so clients can surface or gate dangerous tools;
 *   2. enforces least-privilege via env:
 *        TENKI_MCP_READONLY=1        → register ONLY read tools (no create/run/delete/spend)
 *        TENKI_MCP_DISABLED_TOOLS=a,b → skip these named tools
 *   3. optionally audit-logs each call name to stderr: TENKI_MCP_AUDIT=1
 *      (tool name + argument KEYS only — never values, content, or the token).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { TenkiClient } from "./client.js";
import { registerIdentity } from "./tools/identity.js";
import { registerRun } from "./tools/run.js";
import { registerSandboxes } from "./tools/sandboxes.js";
import { registerSessionsAdmin } from "./tools/sessions_admin.js";
import { registerExec } from "./tools/exec.js";
import { registerFiles } from "./tools/files.js";
import { registerFilesOps } from "./tools/files_ops.js";
import { registerGit } from "./tools/git.js";
import { registerPorts } from "./tools/ports.js";
import { registerPreviews } from "./tools/previews.js";
import { registerSnapshots } from "./tools/snapshots.js";
import { registerVolumes } from "./tools/volumes.js";
import { registerTemplates } from "./tools/templates.js";
import { registerWorkspace } from "./tools/workspace.js";
import { registerArtifacts } from "./tools/artifacts.js";
import { registerSsh } from "./tools/ssh.js";
import { registerAuthStatus } from "./tools/auth_status.js";

export const VERSION = "0.1.0";

const modules = [
	registerIdentity,
	registerRun,
	registerSandboxes,
	registerSessionsAdmin,
	registerExec,
	registerFiles,
	registerFilesOps,
	registerGit,
	registerPorts,
	registerPreviews,
	registerSnapshots,
	registerVolumes,
	registerTemplates,
	registerWorkspace,
	registerArtifacts,
	registerSsh,
];

type Cls = "read" | "write" | "destructive";
// Destroys/removes/revokes a resource → destructiveHint.
const DESTRUCTIVE = /^tenki_(terminate|delete|remove|unshare|revoke|detach|unexpose|unbind)/;
// Named exceptions that match the READ prefix below but actually grant a
// write/spend capability, so they must never be treated as read-only.
// tenki_get_upload_url returns a signed URL for an arbitrary PUT into the sandbox.
const WRITE_OVERRIDE = new Set(["tenki_get_upload_url"]);
// Named exceptions that are pure reads but don't match the READ prefix below.
// tenki_auth_status only inspects the ambient credential + probes WhoAmI, so it
// must stay available under TENKI_MCP_READONLY (it is how an operator diagnoses
// a credential problem in that posture).
const READ_OVERRIDE = new Set(["tenki_auth_status"]);
// Pure inspection, no state change / no spend → readOnlyHint.
const READ = /^tenki_(get|list|whoami|resolve|stat|read)/;

export function classifyTool(name: string): Cls {
	if (DESTRUCTIVE.test(name)) return "destructive";
	if (WRITE_OVERRIDE.has(name)) return "write";
	if (READ_OVERRIDE.has(name) || READ.test(name)) return "read";
	return "write";
}

interface GuardOpts {
	readonly: boolean;
	disabled: Set<string>;
	audit: boolean;
	/** Incremented for every tool the guard actually registers (skips excluded). */
	registered?: { count: number };
}

function readGuardOpts(): GuardOpts {
	const truthy = (v?: string) => v === "1" || (v ?? "").toLowerCase() === "true";
	const disabled = new Set(
		(process.env.TENKI_MCP_DISABLED_TOOLS || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	return { readonly: truthy(process.env.TENKI_MCP_READONLY), disabled, audit: truthy(process.env.TENKI_MCP_AUDIT) };
}

/** Log a tool call's name + argument KEYS (never values/content/token) to stderr. */
function auditKeys(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const keys = Object.keys(args as Record<string, unknown>);
	return keys.length ? ` args=[${keys.join(",")}]` : "";
}

/** MCP annotations derived from a tool's classification. */
function annotationsFor(cls: Cls) {
	return {
		readOnlyHint: cls === "read",
		destructiveHint: cls === "destructive",
		idempotentHint: cls === "read",
		openWorldHint: true, // every tool reaches the external Tenki API
	};
}

/** Wrap a handler so TENKI_MCP_AUDIT=1 logs the call name + argument keys. */
function withAudit(name: string, handler: (...a: unknown[]) => unknown, audit: boolean) {
	if (!audit) return handler;
	return async (args: unknown, extra: unknown) => {
		try {
			// A tool registered WITHOUT an input schema is invoked as (extra) —
			// one argument — so the first param would be the request context, not
			// tool args. Log arg keys only for the two-argument (args, extra) shape.
			console.error(`[tenki-mcp audit] ${name}${extra === undefined ? "" : auditKeys(args)}`);
		} catch {
			/* never let logging break a call */
		}
		return (handler as (a: unknown, e: unknown) => unknown)(args, extra);
	};
}

/**
 * Handle returned for a tool the guard skipped (denylist / read-only posture).
 * The real registration APIs return a RegisteredTool handle; a module that
 * calls .enable()/.remove() on its registration must not crash only in
 * read-only or denylist mode, so skipped registrations get an inert stand-in.
 */
function noopToolHandle() {
	return {
		enabled: false,
		enable() {},
		disable() {},
		update() {},
		remove() {},
	};
}

/**
 * Wrap a server so every tool registration from a module is annotated + subject
 * to the least-privilege env controls above. Both registration APIs are guarded:
 * the legacy `.tool(name, description, schema, handler)` form and the modern
 * `.registerTool(name, config, handler)` form (the only one that accepts an
 * outputSchema) — so neither path can bypass annotations, read-only mode, or
 * the denylist. Other access passes through to the real server unchanged.
 */
function guard(server: McpServer, opts: GuardOpts): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "tool") {
				return (name: string, description: string, schema: unknown, handler: (...a: unknown[]) => unknown) => {
					const cls = classifyTool(name);
					if (opts.disabled.has(name)) return noopToolHandle(); // explicit denylist
					if (opts.readonly && cls !== "read") return noopToolHandle(); // read-only posture: skip anything that mutates/spends
					if (opts.registered) opts.registered.count++;
					return (target.tool as (...a: unknown[]) => unknown)(
						name,
						description,
						schema,
						annotationsFor(cls),
						withAudit(name, handler, opts.audit),
					);
				};
			}
			if (prop === "registerTool") {
				return (name: string, config: Record<string, unknown>, handler: (...a: unknown[]) => unknown) => {
					const cls = classifyTool(name);
					if (opts.disabled.has(name)) return noopToolHandle(); // explicit denylist
					if (opts.readonly && cls !== "read") return noopToolHandle(); // read-only posture: skip anything that mutates/spends
					// Name-derived classification stays authoritative for the four hints so
					// a module cannot soften them; other annotation fields pass through.
					if (opts.registered) opts.registered.count++;
					const annotations = {
						...(config.annotations as Record<string, unknown> | undefined),
						...annotationsFor(cls),
					};
					return (target.registerTool as (...a: unknown[]) => unknown)(
						name,
						{ ...config, annotations },
						withAudit(name, handler, opts.audit),
					);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as McpServer;
}

/**
 * Build a fresh MCP server instance with all tools registered against `client`.
 *
 * `client` is null when no credential was supplied. Rather than refusing to
 * start — which MCP clients report as an opaque "server failed to start" —
 * the server boots with ONLY tenki_auth_status registered, so an agent can
 * discover and explain the missing credential. Registering the other tools in
 * that state would offer 70 tools that can only fail.
 */
export function createServer(client: TenkiClient | null): McpServer {
	const server = new McpServer({ name: "tenki", version: VERSION });
	const opts = { ...readGuardOpts(), registered: { count: 0 } };
	const guarded = guard(server, opts);
	if (client) for (const register of modules) register(guarded, client);
	// Registered last, through the same guard as everything else, so its
	// toolsRegistered figure counts the tools above it (+1 for itself).
	// READ_OVERRIDE keeps it available under TENKI_MCP_READONLY;
	// TENKI_MCP_DISABLED_TOOLS can still drop it.
	registerAuthStatus(guarded, client, opts.registered.count + 1);
	if (!client) console.error("tenki-mcp: no credential — only tenki_auth_status registered. Set TENKI_API_KEY or TENKI_AUTH_TOKEN and restart.");
	if (opts.readonly) console.error("tenki-mcp: TENKI_MCP_READONLY — only read-only tools registered.");
	else if (opts.disabled.size) console.error(`tenki-mcp: disabled tools — ${[...opts.disabled].join(", ")}`);
	return server;
}
