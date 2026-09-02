/**
 * HTTP/SSE transport for tenki-mcp (v2.0) — makes the server hostable, not just
 * local-stdio. Keeps stateful sessions for 2025-era clients and serves the
 * 2026-07-28 protocol through the SDK's stateless per-request handler.
 *
 * Enable with TENKI_MCP_TRANSPORT=http. Config:
 *   PORT                   — listen port (default 3000)
 *   TENKI_MCP_HTTP_HOST    — bind host (default 127.0.0.1, loopback-only)
 *   TENKI_MCP_HTTP_TOKEN   — required Bearer token for the /mcp endpoint
 *   TENKI_MCP_ALLOWED_ORIGINS — optional comma-separated browser Origin hosts
 *
 * Security posture: loopback-only by default; DNS-rebinding protection on
 * (Host allowlist); static bearer auth or OAuth required for non-loopback
 * binds; and per-session/global DoS caps are applied.
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
	createMcpHandler,
	isInitializeRequest,
	isLegacyRequest,
	type AuthInfo,
} from "@modelcontextprotocol/server";
import {
	hostHeaderValidation,
	NodeStreamableHTTPServerTransport,
	originValidation,
	toNodeHandler,
	toWebRequest,
} from "@modelcontextprotocol/node";
import { TenkiClient } from "./client.js";
import {
	APIDelegationSigner,
	OAuthCompatibilityRoutes,
	OAuthTokenVerifier,
	type DelegatedAuthorization,
	authorizationBinding,
	bearerToken,
	loadOAuthConfig,
} from "./oauth.js";
import { createServer } from "./server.js";

const MAX_BODY_BYTES = 1 << 20; // 1 MiB — reject larger POST bodies (memory-DoS guard)
const MAX_SESSIONS = 256; // cap concurrent sessions (init-flood DoS guard)
const SESSION_IDLE_MS = 30 * 60 * 1000; // reap sessions idle longer than this

class BodyTooLarge extends Error {
	constructor() {
		super(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
		this.name = "BodyTooLarge";
	}
}
class BadJson extends Error {}

/**
 * Read a JSON request body with a hard size cap (never throws un-typed).
 * Rejects early on an oversized Content-Length, and independently enforces the
 * cap while streaming, so a lying or absent Content-Length can't slip past the
 * byte counter. Listeners are always removed on the first settle.
 */
function readJson(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			req.resume(); // drain so the socket can close cleanly
			reject(new BodyTooLarge());
			return;
		}

		let size = 0;
		const chunks: Buffer[] = [];
		let settled = false;
		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
		};
		const onData = (c: Buffer) => {
			if (settled) return;
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				cleanup();
				req.resume();
				reject(new BodyTooLarge());
				return;
			}
			chunks.push(c);
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			const s = Buffer.concat(chunks).toString("utf8");
			if (!s) return resolve(undefined);
			try {
				resolve(JSON.parse(s));
			} catch {
				reject(new BadJson());
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

/** Constant-time bearer-token check. No token configured → gate is open (loopback-only enforced at bind). */
function authOk(header: string | undefined, expected: string): boolean {
	if (!expected) return true;
	const m = /^Bearer (.+)$/.exec(header ?? "");
	if (!m) return false;
	const a = Buffer.from(m[1]);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Host:port values the DNS-rebinding guard accepts: the configured host plus the
 * loopback aliases, at BOTH the configured port and the port actually bound (so
 * an ephemeral `port: 0` bind still accepts its own address). Anything else —
 * e.g. a rebound attacker domain — is rejected by the transport.
 */
function allowedHostsFor(
	server: http.Server,
	host: string,
	port: number,
	publicUrl?: string,
): string[] {
	const addr = server.address();
	const bound = addr && typeof addr === "object" ? addr.port : port;
	const ports = Array.from(new Set([port, bound]));
	const hosts = Array.from(
		new Set([host, "127.0.0.1", "localhost", "[::1]", "::1"]),
	);
	const configured = (process.env.TENKI_MCP_ALLOWED_HOSTS || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (publicUrl) {
		const url = new URL(publicUrl);
		configured.push(url.host, url.hostname);
	}
	return Array.from(
		new Set([
			...hosts.flatMap((h) => ports.map((p) => `${h}:${p}`)),
			...configured,
		]),
	);
}

function allowedHostnamesFor(host: string, publicUrl?: string): string[] {
	const configured = (process.env.TENKI_MCP_ALLOWED_HOSTS || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => {
			try {
				return new URL(`http://${value}`).hostname;
			} catch {
				return value;
			}
		});
	const hostnames = [host, "127.0.0.1", "localhost", "[::1]", ...configured];
	if (publicUrl) hostnames.push(new URL(publicUrl).hostname);
	return Array.from(new Set(hostnames));
}

function allowedOriginHostnamesFor(host: string, publicUrl?: string): string[] {
	const configured = (process.env.TENKI_MCP_ALLOWED_ORIGINS || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => {
			try {
				return new URL(value.includes("://") ? value : `https://${value}`)
					.hostname;
			} catch {
				return value;
			}
		});
	return configured.length
		? Array.from(new Set(configured))
		: allowedHostnamesFor(host, publicUrl);
}

function oauthUnauthorized(
	res: http.ServerResponse,
	metadataUrl: string,
	scope: string,
): void {
	res
		.writeHead(401, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`,
		})
		.end(JSON.stringify({ error: "unauthorized" }));
}

export function startHttp(
	client: TenkiClient | null,
	port: number,
): http.Server {
	const host = process.env.TENKI_MCP_HTTP_HOST || "127.0.0.1";
	const httpToken = process.env.TENKI_MCP_HTTP_TOKEN || "";
	const isLoopback =
		host === "127.0.0.1" || host === "::1" || host === "localhost";
	const oauthConfig = loadOAuthConfig();
	const oauthVerifier = oauthConfig
		? new OAuthTokenVerifier(oauthConfig)
		: null;
	const oauthRoutes = oauthConfig
		? new OAuthCompatibilityRoutes(oauthConfig)
		: null;
	const delegationSigner = oauthConfig
		? new APIDelegationSigner(oauthConfig.delegation)
		: null;
	const apiBaseUrl =
		process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || undefined;

	const modernHandler = createMcpHandler(
		({ authInfo }) => {
			const delegated = authInfo?.extra?.delegatedAuthorization as
				DelegatedAuthorization | undefined;
			if (oauthConfig && (!delegated || !delegationSigner)) {
				throw new Error(
					"Hosted OAuth identity was not supplied to the MCP handler.",
				);
			}
			const requestClient =
				delegated && delegationSigner
					? new TenkiClient("", apiBaseUrl, {
							workspaceId: delegated.workspaceId,
							bearerTokenProvider: () => delegationSigner.sign(delegated),
						})
					: client;
			return createServer(requestClient);
		},
		{
			legacy: "reject",
			onerror: (error) =>
				console.error("tenki-mcp modern protocol error:", error.message),
		},
	);
	const serveModern = toNodeHandler(modernHandler, {
		onerror: (error) =>
			console.error("tenki-mcp modern HTTP adapter error:", error.message),
	});
	const validateHost = hostHeaderValidation(
		allowedHostnamesFor(host, oauthConfig?.publicUrl),
	);
	const validateOrigin = originValidation(
		allowedOriginHostnamesFor(host, oauthConfig?.publicUrl),
	);

	// Refuse to expose an unauthenticated capability to the network.
	if (!isLoopback && !httpToken && !oauthConfig) {
		console.error(
			"tenki-mcp: refusing to bind HTTP to a non-loopback host without TENKI_MCP_HTTP_TOKEN " +
				"or OAuth configuration (the /mcp endpoint would be unauthenticated and can spend credits / run code).",
		);
		process.exit(1);
	}

	const sessions = new Map<
		string,
		{
			transport: NodeStreamableHTTPServerTransport;
			lastSeen: number;
			authorizationBinding?: string;
		}
	>();
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
			if (!validateHost(req, res) || !validateOrigin(req, res)) return;
			const url = new URL(req.url || "/", `http://${host}`);
			if (oauthRoutes && (await oauthRoutes.handle(req, res, url))) return;
			if (url.pathname !== "/mcp") {
				res
					.writeHead(404, { "Content-Type": "text/plain" })
					.end("not found — MCP endpoint is /mcp");
				return;
			}

			let delegated: DelegatedAuthorization | null | undefined;
			let authInfo: AuthInfo | undefined;
			if (oauthConfig && oauthVerifier) {
				const token = bearerToken(req.headers["authorization"]);
				delegated = token ? await oauthVerifier.verify(token) : null;
				if (!delegated) {
					oauthUnauthorized(res, oauthConfig.metadataUrl, oauthConfig.scope);
					return;
				}
				authInfo = {
					token: token!,
					clientId: delegated.clientId,
					scopes: delegated.scope,
					...(delegated.expiresAt !== undefined
						? { expiresAt: Math.floor(delegated.expiresAt / 1000) }
						: {}),
					resource: new URL(oauthConfig.resource),
					extra: { delegatedAuthorization: delegated },
				};
			} else if (!authOk(req.headers["authorization"], httpToken)) {
				res
					.writeHead(401, { "Content-Type": "text/plain" })
					.end("unauthorized");
				return;
			}
			const sid = req.headers["mcp-session-id"] as string | undefined;
			const existingEntry = sid ? sessions.get(sid) : undefined;
			if (
				existingEntry?.authorizationBinding &&
				delegated &&
				existingEntry.authorizationBinding !== authorizationBinding(delegated)
			) {
				oauthUnauthorized(res, oauthConfig!.metadataUrl, oauthConfig!.scope);
				return;
			}

			if (req.method === "POST") {
				let body: unknown;
				try {
					body = await readJson(req);
				} catch (e) {
					if (e instanceof BodyTooLarge) {
						res
							.writeHead(413, {
								"Content-Type": "application/json",
								Connection: "close",
							})
							.end(
								JSON.stringify({
									jsonrpc: "2.0",
									error: { code: -32001, message: e.message },
									id: null,
								}),
							);
						return;
					}
					res.writeHead(400, { "Content-Type": "application/json" }).end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: { code: -32700, message: "Parse error" },
							id: null,
						}),
					);
					return;
				}

				const webRequest = await toWebRequest(req, body);
				if (!(await isLegacyRequest(webRequest, body))) {
					const authenticatedRequest = req as http.IncomingMessage & {
						auth?: AuthInfo;
					};
					if (authInfo) authenticatedRequest.auth = authInfo;
					await serveModern(authenticatedRequest, res, body);
					return;
				}

				let entry = existingEntry;
				if (!entry && isInitializeRequest(body)) {
					if (sessions.size >= MAX_SESSIONS) {
						res
							.writeHead(503, { "Content-Type": "text/plain" })
							.end("too many sessions");
						return;
					}
					const transport = new NodeStreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						// DNS-rebinding defense: only accept these Host headers, so a rebound
						// attacker-domain request from a browser is rejected.
						enableDnsRebindingProtection: true,
						allowedHosts: allowedHostsFor(
							httpServer,
							host,
							port,
							oauthConfig?.publicUrl,
						),
						onsessioninitialized: (id) => {
							sessions.set(id, {
								transport,
								lastSeen: Date.now(),
								...(delegated
									? { authorizationBinding: authorizationBinding(delegated) }
									: {}),
							});
						},
					});
					transport.onclose = () => {
						const id = transport.sessionId;
						if (id) sessions.delete(id);
					};
					const sessionClient =
						delegated && delegationSigner
							? new TenkiClient("", apiBaseUrl, {
									workspaceId: delegated.workspaceId,
									bearerTokenProvider: () => delegationSigner.sign(delegated),
								})
							: client;
					await createServer(sessionClient).connect(transport);
					entry = {
						transport,
						lastSeen: Date.now(),
						...(delegated
							? { authorizationBinding: authorizationBinding(delegated) }
							: {}),
					};
				}
				if (!entry) {
					res.writeHead(400, { "Content-Type": "application/json" }).end(
						JSON.stringify({
							jsonrpc: "2.0",
							error: {
								code: -32000,
								message: "No valid session; send an initialize request first.",
							},
							id: null,
						}),
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
					res
						.writeHead(400, { "Content-Type": "text/plain" })
						.end("No session for the given mcp-session-id.");
					return;
				}
				entry.lastSeen = Date.now();
				await entry.transport.handleRequest(req, res);
				return;
			}

			res
				.writeHead(405, { "Content-Type": "text/plain" })
				.end("method not allowed");
		} catch (e) {
			// Never echo internals to the client; log server-side only.
			if (!res.headersSent)
				res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("internal error");
			console.error("tenki-mcp http error:", (e as Error).message);
		}
	});

	httpServer.on("close", () => {
		clearInterval(sweep);
		void modernHandler.close();
	});
	httpServer.listen(port, host, () => {
		console.error(
			`tenki-mcp running on http://${host}:${port}/mcp (Streamable HTTP)` +
				(oauthConfig
					? " [OAuth required]"
					: httpToken
						? " [bearer auth required]"
						: " [loopback only, no auth]"),
		);
	});
	return httpServer;
}
