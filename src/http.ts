/**
 * HTTP/SSE transport for tenki-mcp (v2.0) — makes the server hostable, not just
 * local-stdio. Uses the MCP SDK's StreamableHTTPServerTransport with a stateful
 * per-session model: one server + transport per MCP session.
 *
 * Enable with TENKI_MCP_TRANSPORT=http. Config:
 *   PORT                   — listen port (default 3000)
 *   TENKI_MCP_HTTP_HOST    — bind host (default 127.0.0.1, loopback-only)
 *   TENKI_MCP_HTTP_TOKEN   — required Bearer token for the /mcp endpoint
 *
 * Security posture (the process holds one shared TENKI_API_KEY and exposes all
 * tools, incl. arbitrary code execution + credit spend, so the endpoint is a
 * capability): loopback-only by default; DNS-rebinding protection on (Host
 * allowlist); optional bearer auth; and it REFUSES to bind to a non-loopback
 * host without a token set. Per-session/global DoS caps are applied.
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { TenkiClient } from "./client.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 1 << 20; // 1 MiB — reject larger POST bodies
const MAX_SESSIONS = 256; // cap concurrent sessions (init-flood DoS guard)
const SESSION_IDLE_MS = 30 * 60 * 1000; // reap sessions idle longer than this

class BodyTooLarge extends Error {}
class BadJson extends Error {}

/** Read a JSON request body with a hard size cap (never throws un-typed). */
function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new BodyTooLarge());
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const s = Buffer.concat(chunks).toString("utf8");
			if (!s) return resolve(undefined);
			try {
				resolve(JSON.parse(s));
			} catch {
				reject(new BadJson());
			}
		});
		req.on("error", reject);
	});
}

/** Constant-time bearer-token check. No token configured → gate is open (loopback-only enforced at bind). */
function authOk(header: string | undefined, expected: string): boolean {
	if (!expected) return true;
	const m = /^Bearer (.+)$/.exec(header ?? "");
	if (!m) return false;
	const a = Buffer.from(m[1]);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function startHttp(client: TenkiClient, port: number): http.Server {
	const host = process.env.TENKI_MCP_HTTP_HOST || "127.0.0.1";
	const httpToken = process.env.TENKI_MCP_HTTP_TOKEN || "";
	const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

	// Refuse to expose an unauthenticated capability to the network.
	if (!isLoopback && !httpToken) {
		console.error(
			"tenki-mcp: refusing to bind HTTP to a non-loopback host without TENKI_MCP_HTTP_TOKEN " +
				"(the /mcp endpoint would be unauthenticated and can spend credits / run code). " +
				"Set TENKI_MCP_HTTP_TOKEN, or bind to 127.0.0.1.",
		);
		process.exit(1);
	}

	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; lastSeen: number }>();
	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [id, s] of sessions) {
			if (now - s.lastSeen > SESSION_IDLE_MS) {
				try {
					s.transport.close();
				} catch {
					/* ignore */
				}
				sessions.delete(id);
			}
		}
	}, 60_000);
	sweep.unref?.();

	const httpServer = http.createServer(async (req, res) => {
		try {
			if (!authOk(req.headers["authorization"], httpToken)) {
				res.writeHead(401, { "Content-Type": "text/plain" }).end("unauthorized");
				return;
			}
			const url = new URL(req.url || "/", `http://${host}`);
			if (url.pathname !== "/mcp") {
				res.writeHead(404, { "Content-Type": "text/plain" }).end("not found — MCP endpoint is /mcp");
				return;
			}
			const sid = req.headers["mcp-session-id"] as string | undefined;

			if (req.method === "POST") {
				let body: unknown;
				try {
					body = await readJson(req);
				} catch (e) {
					if (e instanceof BodyTooLarge) {
						res.writeHead(413, { "Content-Type": "text/plain" }).end("payload too large");
						return;
					}
					res
						.writeHead(400, { "Content-Type": "application/json" })
						.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
					return;
				}

				let entry = sid ? sessions.get(sid) : undefined;
				if (!entry && isInitializeRequest(body)) {
					if (sessions.size >= MAX_SESSIONS) {
						res.writeHead(503, { "Content-Type": "text/plain" }).end("too many sessions");
						return;
					}
					const transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						// DNS-rebinding defense: only accept these Host headers, so a rebound
						// attacker-domain request from a browser is rejected.
						enableDnsRebindingProtection: true,
						allowedHosts: [`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`],
						onsessioninitialized: (id) => {
							sessions.set(id, { transport, lastSeen: Date.now() });
						},
					});
					transport.onclose = () => {
						const id = transport.sessionId;
						if (id) sessions.delete(id);
					};
					await createServer(client).connect(transport);
					entry = { transport, lastSeen: Date.now() };
				}
				if (!entry) {
					res.writeHead(400, { "Content-Type": "application/json" }).end(
						JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send an initialize request first." }, id: null }),
					);
					return;
				}
				entry.lastSeen = Date.now();
				await entry.transport.handleRequest(req, res, body);
				return;
			}

			// GET opens the SSE stream; DELETE ends a session.
			if (req.method === "GET" || req.method === "DELETE") {
				const entry = sid ? sessions.get(sid) : undefined;
				if (!entry) {
					res.writeHead(400, { "Content-Type": "text/plain" }).end("No session for the given mcp-session-id.");
					return;
				}
				entry.lastSeen = Date.now();
				await entry.transport.handleRequest(req, res);
				return;
			}

			res.writeHead(405, { "Content-Type": "text/plain" }).end("method not allowed");
		} catch (e) {
			// Never echo internals to the client; log server-side only.
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("internal error");
			console.error("tenki-mcp http error:", (e as Error).message);
		}
	});

	httpServer.on("close", () => clearInterval(sweep));
	httpServer.listen(port, host, () => {
		console.error(
			`tenki-mcp running on http://${host}:${port}/mcp (Streamable HTTP)` +
				(httpToken ? " [bearer auth required]" : " [loopback only, no auth]"),
		);
	});
	return httpServer;
}
