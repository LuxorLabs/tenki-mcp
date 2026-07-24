/**
 * HTTP/SSE transport for tenki-mcp (v2.0) — makes the server hostable, not just
 * local-stdio. Uses the MCP SDK's StreamableHTTPServerTransport with a stateful
 * per-session model: one server + transport per MCP session (created on the
 * initialize request, torn down on close).
 *
 * Enable with TENKI_MCP_TRANSPORT=http and PORT (default 3000). Endpoint: /mcp.
 * v2.0.0-alpha uses a single shared TENKI_API_KEY from the environment for all
 * sessions; per-request auth (multi-tenant hosting) is a later, decision-gated step.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { TenkiClient } from "./client.js";
import { createServer } from "./server.js";

// MCP messages are small JSON documents. Bound unauthenticated input so a
// hosted endpoint cannot be forced to retain an arbitrarily large body.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {
	constructor() {
		super(`Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`);
		this.name = "RequestBodyTooLargeError";
	}
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const declaredLength = Number(req.headers["content-length"]);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
			req.resume();
			reject(new RequestBodyTooLargeError());
			return;
		}

		let data = "";
		let bytes = 0;
		let settled = false;

		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
		};
		const onData = (chunk: Buffer | string) => {
			bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
			if (bytes > MAX_REQUEST_BODY_BYTES) {
				settled = true;
				cleanup();
				req.resume();
				reject(new RequestBodyTooLargeError());
				return;
			}
			data += chunk;
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				resolve(data ? JSON.parse(data) : undefined);
			} catch (e) {
				reject(e);
			}
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
	});
}

export function startHttp(client: TenkiClient, port: number): http.Server {
	const transports: Record<string, StreamableHTTPServerTransport> = {};

	const httpServer = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", "http://localhost");
			if (url.pathname !== "/mcp") {
				res.writeHead(404, { "Content-Type": "text/plain" }).end("not found — MCP endpoint is /mcp");
				return;
			}
			const sessionId = req.headers["mcp-session-id"] as string | undefined;

			if (req.method === "POST") {
				const body = await readJson(req);
				let transport = sessionId ? transports[sessionId] : undefined;
				if (!transport && isInitializeRequest(body)) {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (id) => {
							transports[id] = transport as StreamableHTTPServerTransport;
						},
					});
					transport.onclose = () => {
						const id = transport?.sessionId;
						if (id) delete transports[id];
					};
					await createServer(client).connect(transport);
				}
				if (!transport) {
					res.writeHead(400, { "Content-Type": "application/json" }).end(
						JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send an initialize request first." }, id: null }),
					);
					return;
				}
				await transport.handleRequest(req, res, body);
				return;
			}

			// GET opens the SSE stream; DELETE ends a session.
			if (req.method === "GET" || req.method === "DELETE") {
				const transport = sessionId ? transports[sessionId] : undefined;
				if (!transport) {
					res.writeHead(400, { "Content-Type": "text/plain" }).end("No session for the given mcp-session-id.");
					return;
				}
				await transport.handleRequest(req, res);
				return;
			}

			res.writeHead(405, { "Content-Type": "text/plain" }).end("method not allowed");
		} catch (e) {
			if (e instanceof RequestBodyTooLargeError) {
				if (!res.headersSent) {
					res.writeHead(413, {
						"Content-Type": "application/json",
						Connection: "close",
					});
				}
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32001, message: e.message },
						id: null,
					}),
				);
				return;
			}
			if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
			res.end(`internal error: ${(e as Error).message}`);
		}
	});

	httpServer.listen(port, () => {
		console.error(`tenki-mcp running on http://localhost:${port}/mcp (Streamable HTTP)`);
	});
	return httpServer;
}
