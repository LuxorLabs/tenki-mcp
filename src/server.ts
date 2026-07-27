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
import { registerRegistry } from "./tools/registry.js";
import { registerWorkspace } from "./tools/workspace.js";
import { registerArtifacts } from "./tools/artifacts.js";
import { registerSsh } from "./tools/ssh.js";

export const VERSION = "2.0.0-alpha.0";

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
	registerRegistry,
	registerWorkspace,
	registerArtifacts,
	registerSsh,
];

type Cls = "read" | "write" | "destructive";
// Destroys/removes/revokes a resource → destructiveHint.
const DESTRUCTIVE = /^tenki_(terminate|delete|remove|unshare|revoke|detach|unexpose|unbind)/;
// Pure inspection, no state change / no spend → readOnlyHint.
const READ = /^tenki_(get|list|whoami|resolve|stat)/;

export function classifyTool(name: string): Cls {
	if (DESTRUCTIVE.test(name)) return "destructive";
	if (READ.test(name)) return "read";
	return "write";
}

interface GuardOpts {
	readonly: boolean;
	disabled: Set<string>;
	audit: boolean;
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

/**
 * Wrap a server so every `.tool(name, description, schema, handler)` from a module
 * is annotated + subject to the least-privilege env controls above. Non-`tool`
 * access passes through to the real server unchanged.
 */
function guard(server: McpServer, opts: GuardOpts): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			if (prop !== "tool") return Reflect.get(target, prop, receiver);
			return (name: string, description: string, schema: unknown, handler: (...a: unknown[]) => unknown) => {
				const cls = classifyTool(name);
				if (opts.disabled.has(name)) return; // explicit denylist
				if (opts.readonly && cls !== "read") return; // read-only posture: skip anything that mutates/spends
				const annotations = {
					readOnlyHint: cls === "read",
					destructiveHint: cls === "destructive",
					idempotentHint: cls === "read",
					openWorldHint: true, // every tool reaches the external Tenki API
				};
				const cb = opts.audit
					? async (args: unknown, extra: unknown) => {
							try {
								console.error(`[tenki-mcp audit] ${name}${auditKeys(args)}`);
							} catch {
								/* never let logging break a call */
							}
							return (handler as (a: unknown, e: unknown) => unknown)(args, extra);
						}
					: handler;
				return (target.tool as (...a: unknown[]) => unknown)(name, description, schema, annotations, cb);
			};
		},
	}) as McpServer;
}

/** Build a fresh MCP server instance with all tools registered against `client`. */
export function createServer(client: TenkiClient): McpServer {
	const server = new McpServer({ name: "tenki", version: VERSION });
	const opts = readGuardOpts();
	const guarded = guard(server, opts);
	for (const register of modules) register(guarded, client);
	if (opts.readonly) console.error("tenki-mcp: TENKI_MCP_READONLY — only read-only tools registered.");
	else if (opts.disabled.size) console.error(`tenki-mcp: disabled tools — ${[...opts.disabled].join(", ")}`);
	return server;
}
