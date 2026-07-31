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

// A missing credential is NOT fatal: exiting here is reported by MCP clients as
// an opaque "server failed to start" with stderr usually swallowed, leaving the
// user with no idea a token is needed. Instead the server boots with only
// tenki_auth_status registered (see createServer), so an agent can ask what is
// wrong and relay the fix.
const token = process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY;
if (!token) {
	console.error(
		"tenki-mcp: no credential — starting in unauthenticated mode (only tenki_auth_status is available). " +
			"Set TENKI_API_KEY (tk_…) or TENKI_AUTH_TOKEN (ory_st_…) in the server's env and restart, " +
			"e.g. claude mcp add tenki --env TENKI_API_KEY=tk_… -- npx -y tenki-mcp",
	);
}
const baseUrl = process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || undefined;
const client = token ? new TenkiClient(token, baseUrl) : null;

async function main() {
	if ((process.env.TENKI_MCP_TRANSPORT || "stdio").toLowerCase() === "http") {
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
