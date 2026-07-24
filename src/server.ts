/**
 * Shared MCP server factory — builds a server with every tool module registered.
 * Used by both transports: stdio (index.ts) and HTTP (http.ts).
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

export const VERSION = "2.0.0-alpha.1";

/** Every tool module registers here. Add new domains to this list. */
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

/** Build a fresh MCP server instance with all tools registered against `client`. */
export function createServer(client: TenkiClient): McpServer {
	const server = new McpServer({ name: "tenki", version: VERSION });
	for (const register of modules) register(server, client);
	return server;
}
