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

const token = process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY;
if (!token) {
	console.error("tenki-mcp: set TENKI_API_KEY (or TENKI_AUTH_TOKEN) in the environment.");
	process.exit(1);
}
const baseUrl = process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || undefined;
const client = new TenkiClient(token, baseUrl);

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
