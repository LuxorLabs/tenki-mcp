import { createHash, createHmac, randomUUID } from "node:crypto";
import type http from "node:http";

const DEFAULT_SCOPE = "mcp";
const DEFAULT_DELEGATION_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8_000;
const TOKEN_CACHE_MS = 15_000;
const MAX_REGISTRATION_BYTES = 64 * 1024;

type JsonRecord = Record<string, any>;

export interface APIDelegationConfig {
	secret: string;
	issuer: string;
	audience: string;
	ttlSeconds: number;
}

export interface OAuthConfig {
	issuer: string;
	resource: string;
	publicUrl: string;
	metadataUrl: string;
	introspectionUrl: string;
	hydraPublicUrl: string;
	controlApiUrl: string;
	scope: string;
	delegation: APIDelegationConfig;
}

export interface DelegatedAuthorization {
	tokenDigest: string;
	subject: string;
	workspaceId: string;
	clientId: string;
	scope: string[];
	expiresAt?: number;
}

function trimUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function positiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}.`);
	return parsed;
}

export function loadOAuthConfig(): OAuthConfig | null {
	const issuer = trimUrl(process.env.TENKI_MCP_OAUTH_ISSUER || "");
	const introspectionUrl = trimUrl(process.env.TENKI_MCP_OAUTH_INTROSPECTION_URL || "");
	const publicUrl = trimUrl(process.env.TENKI_MCP_PUBLIC_URL || "");
	if (!issuer && !introspectionUrl && !publicUrl) return null;
	if (!issuer || !introspectionUrl || !publicUrl) {
		throw new Error("TENKI_MCP_OAUTH_ISSUER, TENKI_MCP_OAUTH_INTROSPECTION_URL, and TENKI_MCP_PUBLIC_URL must be set together.");
	}

	const controlApiUrl = trimUrl(process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || "https://api.tenki.cloud");
	const delegationSecret = process.env.TENKI_MCP_API_DELEGATION_SECRET || "";
	if (Buffer.byteLength(delegationSecret) < 32) {
		throw new Error("TENKI_MCP_API_DELEGATION_SECRET must contain at least 32 bytes when hosted OAuth is enabled.");
	}
	const ttlSeconds = positiveInteger(process.env.TENKI_MCP_API_DELEGATION_TTL_SECONDS, DEFAULT_DELEGATION_TTL_SECONDS);
	if (ttlSeconds > 300) throw new Error("TENKI_MCP_API_DELEGATION_TTL_SECONDS must not exceed 300 seconds.");

	const resource = trimUrl(process.env.TENKI_MCP_OAUTH_RESOURCE || `${publicUrl}/mcp`);
	return {
		issuer,
		resource,
		publicUrl,
		metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
		introspectionUrl,
		hydraPublicUrl: trimUrl(process.env.TENKI_MCP_HYDRA_PUBLIC_URL || ""),
		controlApiUrl,
		scope: (process.env.TENKI_MCP_OAUTH_SCOPE || DEFAULT_SCOPE).trim(),
		delegation: {
			secret: delegationSecret,
			issuer: trimUrl(process.env.TENKI_MCP_API_DELEGATION_ISSUER || publicUrl),
			audience: trimUrl(process.env.TENKI_MCP_API_DELEGATION_AUDIENCE || controlApiUrl),
			ttlSeconds,
		},
	};
}

function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function scopes(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function audiences(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return typeof value === "string" ? [value] : [];
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<JsonRecord> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	const text = await response.text();
	let body: JsonRecord = {};
	try {
		body = text ? (JSON.parse(text) as JsonRecord) : {};
	} catch {
		throw new Error(`upstream returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
	return body;
}

export class OAuthTokenVerifier {
	private readonly cache = new Map<string, { authorization: DelegatedAuthorization; cachedUntil: number }>();

	constructor(private readonly config: OAuthConfig) {}

	async verify(token: string): Promise<DelegatedAuthorization | null> {
		const digest = tokenDigest(token);
		const cached = this.cache.get(digest);
		if (cached && cached.cachedUntil > Date.now()) return cached.authorization;

		let body: JsonRecord;
		try {
			body = await fetchJson(this.config.introspectionUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token }),
			});
		} catch {
			return null;
		}
		if (body.active !== true) return null;

		const tokenScopes = scopes(body.scope);
		if (!tokenScopes.includes(this.config.scope)) return null;
		if (!audiences(body.aud).includes(this.config.resource)) return null;

		const ext = body.ext && typeof body.ext === "object" ? body.ext : {};
		const workspaceId = String(ext.workspace_id ?? ext.workspaceId ?? body.workspace_id ?? "").trim();
		const subject = String(body.sub ?? "").trim();
		const clientId = String(body.client_id ?? "").trim();
		if (!workspaceId || !subject || !clientId) return null;

		const expiresAt = Number.isFinite(Number(body.exp)) ? Number(body.exp) * 1000 : undefined;
		if (expiresAt !== undefined && expiresAt <= Date.now()) return null;
		const authorization: DelegatedAuthorization = {
			tokenDigest: digest,
			subject,
			workspaceId,
			clientId,
			scope: tokenScopes,
			...(expiresAt !== undefined ? { expiresAt } : {}),
		};
		this.cache.set(digest, {
			authorization,
			cachedUntil: Math.min(Date.now() + TOKEN_CACHE_MS, expiresAt ?? Number.POSITIVE_INFINITY),
		});
		return authorization;
	}
}

function base64url(value: string): string {
	return Buffer.from(value).toString("base64url");
}

export class APIDelegationSigner {
	constructor(private readonly config: APIDelegationConfig) {}

	sign(authorization: DelegatedAuthorization, nowMs = Date.now()): string {
		const issuedAt = Math.floor(nowMs / 1000);
		const sourceExpiry = authorization.expiresAt === undefined ? Number.POSITIVE_INFINITY : Math.floor(authorization.expiresAt / 1000);
		const expiresAt = Math.min(issuedAt + this.config.ttlSeconds, sourceExpiry);
		if (expiresAt <= issuedAt) throw new Error("The MCP access token expired before an API delegation could be issued.");

		const header = base64url(JSON.stringify({ alg: "HS256", typ: "tenki-mcp-delegation+jwt" }));
		const payload = base64url(
			JSON.stringify({
				iss: this.config.issuer,
				aud: this.config.audience,
				sub: authorization.subject,
				workspace_id: authorization.workspaceId,
				client_id: authorization.clientId,
				scope: authorization.scope.join(" "),
				iat: issuedAt,
				exp: expiresAt,
				jti: randomUUID(),
			}),
		);
		const signingInput = `${header}.${payload}`;
		const signature = createHmac("sha256", this.config.secret).update(signingInput).digest("base64url");
		return `${signingInput}.${signature}`;
	}
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		Pragma: "no-cache",
	});
	res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_REGISTRATION_BYTES) {
				fail(new Error("registration request too large"));
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks));
		});
		req.on("error", fail);
	});
}

export class OAuthCompatibilityRoutes {
	constructor(private readonly config: OAuthConfig) {}

	protectedResourceMetadata(): JsonRecord {
		return {
			resource: this.config.resource,
			authorization_servers: [this.config.issuer],
			scopes_supported: [this.config.scope, "offline_access"],
			bearer_methods_supported: ["header"],
			resource_name: "Tenki MCP",
		};
	}

	async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
			json(res, 200, this.protectedResourceMetadata());
			return true;
		}
		if (url.pathname === "/healthz") {
			json(res, 200, { status: "ok" });
			return true;
		}
		if (url.pathname === "/oauth/register" && req.method === "POST") {
			await this.registerClient(req, res);
			return true;
		}
		return false;
	}

	private async registerClient(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!this.config.hydraPublicUrl) {
			json(res, 503, { error: "temporarily_unavailable", error_description: "OAuth registration is not configured." });
			return;
		}

		try {
			const upstream = await fetch(`${this.config.hydraPublicUrl}/oauth2/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: (await readBody(req)).toString("utf8"),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const text = await upstream.text();
			let responseBody = text;
			if (upstream.ok && text) {
				const client = JSON.parse(text) as JsonRecord;
				for (const key of ["client_uri", "logo_uri", "policy_uri", "tos_uri"]) {
					if (!client[key]) delete client[key];
				}
				if (!Array.isArray(client.contacts)) delete client.contacts;
				for (const [key, value] of Object.entries(client)) {
					if (value === null) delete client[key];
				}
				responseBody = JSON.stringify(client);
			}
			res.writeHead(upstream.status, {
				"Content-Type": upstream.headers.get("content-type") || "application/json",
				"Cache-Control": "no-store",
				...(upstream.headers.get("location") ? { Location: upstream.headers.get("location")! } : {}),
			});
			res.end(responseBody);
		} catch {
			json(res, 502, { error: "temporarily_unavailable", error_description: "OAuth registration failed." });
		}
	}
}

export function bearerToken(header: string | undefined): string | null {
	const match = /^Bearer (.+)$/.exec(header ?? "");
	return match?.[1]?.trim() || null;
}

export function authorizationBinding(authorization: DelegatedAuthorization): string {
	return createHash("sha256")
		.update(JSON.stringify([authorization.subject, authorization.workspaceId, authorization.clientId]))
		.digest("hex");
}
