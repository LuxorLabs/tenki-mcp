#!/usr/bin/env node
/**
 * tenki-mcp — a Model Context Protocol server for Tenki Cloud.
 *
 * Exposes Tenki's sandbox platform (disposable microVMs for AI agents) as MCP
 * tools, so any agent — Claude, Codex, Cursor — can create sandboxes, run code,
 * manage files/snapshots/volumes/templates/images, run git, and expose preview URLs.
 *
 * Transports:
 *   - stdio (default) — for local MCP clients (Claude Desktop, Cursor, Claude Code).
 *   - HTTP/SSE — set TENKI_MCP_TRANSPORT=http (+ PORT, default 3000) to host it.
 *
 * Tools live in self-registering modules under ./tools; the server factory is in
 * ./server.ts. Auth: set TENKI_API_KEY (or TENKI_AUTH_TOKEN) in the environment.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TenkiClient } from "./client.js";
import { createServer } from "./server.js";
import { startHttp } from "./http.js";
import { readEnv } from "./env.js";

// A missing credential is NOT fatal: exiting here is reported by MCP clients as
// an opaque "server failed to start" with stderr usually swallowed, leaving the
// user with no idea a token is needed. Instead the server boots with only
// tenki_auth_status registered (see createServer), so an agent can ask what is
// wrong and relay the fix.
const token = readEnv("AUTH_TOKEN", "API_KEY");
const oauthHttp = Boolean(readEnv("MCP_OAUTH_ISSUER"));
if (!token && !oauthHttp) {
	console.error(
		"tenki-mcp: no credential — starting in unauthenticated mode (only tenki_auth_status is available). " +
			"Set TENKI_API_KEY (tk_…) or TENKI_AUTH_TOKEN (ory_st_…) in the server's env and restart, " +
			"e.g. claude mcp add tenki --env TENKI_API_KEY=tk_… -- npx -y @tenkicloud/mcp",
	);
}
const baseUrl = readEnv("API_ENDPOINT", "API_URL") || undefined;
/** Positive integer from env, or undefined so the client keeps its own default. */
const envMs = (suffix: string): number | undefined => {
	const n = Number.parseInt(readEnv(suffix) ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
};
const client = token
	? new TenkiClient(token, baseUrl, {
			timeoutMs: envMs("MCP_TIMEOUT_MS"),
			slowTimeoutMs: envMs("MCP_SLOW_TIMEOUT_MS"),
		})
	: null;

async function main() {
	if ((readEnv("MCP_TRANSPORT") || "stdio").toLowerCase() === "http") {
		const httpServer = startHttp(client, Number(process.env.PORT) || 3000);
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.on(sig, () => httpServer.close(() => process.exit(0)));
		}
		return;
	}
	const server = createServer(client);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("tenki-mcp running on stdio");
}

main().catch((err) => {
	console.error("tenki-mcp fatal:", err);
	process.exit(1);
});
