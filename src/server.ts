/**
 * Shared MCP server factory — builds a server with every tool module registered.
 * Used by both transports: stdio (index.ts) and HTTP (http.ts).
 *
 * Security controls (see SECURITY.md; maps to CSA MCP Server Top-10 MCP-07
 * "excessive permissions"). Every tool is registered through a guard that:
 *   1. gives it a human-readable title (tools/titles.ts) and MCP annotations
 *      (readOnlyHint / destructiveHint / openWorldHint) so clients can surface
 *      or gate dangerous tools;
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
import { registerEgress } from "./tools/egress.js";
import { registerAuthStatus } from "./tools/auth_status.js";
import { readEnv } from "./env.js";
import { TOOL_TITLES } from "./tools/titles.js";

export const VERSION = "0.4.0";

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
	registerEgress,
	registerTemplates,
	registerWorkspace,
	registerArtifacts,
	registerSsh,
];

/**
 * Tool classes, mapped to MCP annotations by annotationsFor():
 *   read        → readOnlyHint: true. Pure inspection: no state change, no spend.
 *   additive    → readOnlyHint: false, destructiveHint: false. Only creates new
 *                 things or extends existing ones (a sandbox, a snapshot, more
 *                 lifetime, a keep-alive); never changes or removes what exists.
 *   destructive → readOnlyHint: false, destructiveHint: true. May overwrite,
 *                 modify, interrupt or delete existing state.
 *
 * Destructive is the DEFAULT for anything that is not a read: a non-read tool
 * is additive only when it is listed in ADDITIVE. MCP defines
 * `destructiveHint: false` as "performs only additive updates", and clients use
 * it to decide whether to ask before a call, so an unlisted new tool must fail
 * safe (prompt) rather than claim to be harmless.
 */
type Cls = "read" | "additive" | "destructive";
// Destroys/removes/revokes a resource. Checked first, so a name with one of
// these prefixes is destructive even if it is mistakenly listed in ADDITIVE.
const DESTRUCTIVE = /^tenki_(terminate|delete|remove|unshare|revoke|detach|unexpose|unbind)/;
// Pure inspection, no state change / no spend → readOnlyHint.
const READ = /^tenki_(get|list|whoami|resolve|stat|read)/;
// Names that match the READ prefix but are not reads. tenki_get_upload_url
// returns a signed URL for an HTTP PUT that can overwrite a file in the sandbox.
const NOT_READ = new Set(["tenki_get_upload_url"]);
// Pure reads that don't match the READ prefix. tenki_auth_status only inspects
// the ambient credential + probes WhoAmI, so it must stay available under
// TENKI_MCP_READONLY (it is how an operator diagnoses a credential problem in
// that posture). git diff/log only read the repository.
const READ_OVERRIDE = new Set(["tenki_auth_status", "tenki_git_diff", "tenki_git_log"]);
// Non-read tools that only add. Everything else that is not a read is
// destructive — see the class comment above for why that is the default.
const ADDITIVE = new Set([
	"tenki_run_code", // boots, uses and tears down its own throwaway sandbox
	"tenki_create_sandbox",
	"tenki_fork_sandbox", // the source keeps running; children are new sandboxes
	"tenki_resume_sandbox",
	"tenki_extend_sandbox",
	"tenki_report_sandbox_activity", // keep-alive
	"tenki_make_dir",
	"tenki_git_clone", // git refuses a non-empty target directory
	"tenki_expose_port",
	"tenki_create_preview_url",
	"tenki_touch_preview", // keep-alive
	"tenki_create_snapshot",
	"tenki_create_volume",
	"tenki_attach_volume",
	"tenki_create_egress_policy",
	"tenki_create_template",
	// Not tenki_build_template: a build with image_name publishes a new latest
	// version, which changes what an existing `workspace/name` reference boots.
	"tenki_issue_ssh_cert",
]);

export function classifyTool(name: string): Cls {
	if (DESTRUCTIVE.test(name)) return "destructive";
	if (!NOT_READ.has(name) && (READ_OVERRIDE.has(name) || READ.test(name))) return "read";
	if (ADDITIVE.has(name)) return "additive";
	return "destructive";
}

/** Title for a tool: the TOOL_TITLES entry, else one derived from the name so
 * a tool is never advertised without a title (the offline suite fails on a
 * missing entry, so the fallback only guards production). */
export function titleFor(name: string): string {
	return (
		TOOL_TITLES[name] ??
		name
			.replace(/^tenki_/, "")
			.split("_")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ")
	);
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
		(readEnv("MCP_DISABLED_TOOLS") || "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	return { readonly: truthy(readEnv("MCP_READONLY")), disabled, audit: truthy(readEnv("MCP_AUDIT")) };
}

/** Log a tool call's name + argument KEYS (never values/content/token) to stderr. */
function auditKeys(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const keys = Object.keys(args as Record<string, unknown>);
	return keys.length ? ` args=[${keys.join(",")}]` : "";
}

/** MCP annotations derived from a tool's classification. */
function annotationsFor(name: string, cls: Cls) {
	return {
		title: titleFor(name),
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
 * Wrap a server so every tool registration from a module is titled, annotated
 * and subject to the least-privilege env controls above. Both registration APIs
 * are guarded: the legacy `.tool(name, description, schema, handler)` form and
 * the modern `.registerTool(name, config, handler)` form (the only one that
 * accepts an outputSchema) — so neither path can bypass titles, annotations,
 * read-only mode, or the denylist. Legacy calls are re-issued as registerTool,
 * because the SDK's tool() overloads have no title parameter (MCP `Tool.title`
 * would be undefined). Other access passes through to the real server unchanged.
 */
function guard(server: McpServer, opts: GuardOpts): McpServer {
	const register = (target: McpServer, name: string, config: Record<string, unknown>, handler: (...a: unknown[]) => unknown) => {
		const cls = classifyTool(name);
		if (opts.disabled.has(name)) return noopToolHandle(); // explicit denylist
		if (opts.readonly && cls !== "read") return noopToolHandle(); // read-only posture: skip anything that mutates/spends
		if (opts.registered) opts.registered.count++;
		// Name-derived classification and title stay authoritative so a module
		// cannot soften the hints; other annotation fields pass through.
		const annotations = {
			...(config.annotations as Record<string, unknown> | undefined),
			...annotationsFor(name, cls),
		};
		return (target.registerTool as (...a: unknown[]) => unknown)(
			name,
			{ ...config, title: titleFor(name), annotations },
			withAudit(name, handler, opts.audit),
		);
	};
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop === "tool") {
				// Every module uses the four-argument form; a schema-less tool passes {}.
				return (name: string, description: string, schema: unknown, handler: (...a: unknown[]) => unknown) =>
					register(target, name, { description, inputSchema: schema }, handler);
			}
			if (prop === "registerTool") {
				return (name: string, config: Record<string, unknown>, handler: (...a: unknown[]) => unknown) =>
					register(target, name, config, handler);
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
 * that state would offer 82 tools that can only fail.
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
