import { createHash } from "node:crypto";
import type http from "node:http";

const DEFAULT_SCOPE = "mcp";
const FETCH_TIMEOUT_MS = 8_000;
const TOKEN_CACHE_MS = 15_000;
const EXCHANGE_PROCEDURE =
	"/tenki.cloud.identity.private.v1beta1.IdentityPrivateService/ExchangeMcpOAuthToken";

type JsonRecord = Record<string, any>;

export interface OAuthConfig {
	issuer: string;
	resource: string;
	publicUrl: string;
	metadataUrl: string;
	identityUrl: string;
	identityServiceToken: string;
	scope: string;
}

export interface DelegatedAuthorization {
	tokenDigest: string;
	subject: string;
	workspaceId: string;
	clientId: string;
	scope: string[];
	expiresAt?: number;
	apiDelegationToken: string;
}

function trimUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function loadOAuthConfig(): OAuthConfig | null {
	const issuer = trimUrl(process.env.TENKI_MCP_OAUTH_ISSUER || "");
	const identityUrl = trimUrl(process.env.TENKI_MCP_IDENTITY_URL || "");
	const identityServiceToken = (process.env.TENKI_MCP_IDENTITY_SERVICE_TOKEN || "").trim();
	const publicUrl = trimUrl(process.env.TENKI_MCP_PUBLIC_URL || "");
	if (!issuer && !identityUrl && !identityServiceToken && !publicUrl) return null;
	if (!issuer || !identityUrl || !identityServiceToken || !publicUrl) {
		throw new Error(
			"TENKI_MCP_OAUTH_ISSUER, TENKI_MCP_IDENTITY_URL, TENKI_MCP_IDENTITY_SERVICE_TOKEN, and TENKI_MCP_PUBLIC_URL must be set together.",
		);
	}

	const resource = trimUrl(process.env.TENKI_MCP_OAUTH_RESOURCE || `${publicUrl}/mcp`);
	return {
		issuer,
		resource,
		publicUrl,
		metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
		identityUrl,
		identityServiceToken,
		scope: (process.env.TENKI_MCP_OAUTH_SCOPE || DEFAULT_SCOPE).trim(),
	};
}

function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
			body = await fetchJson(`${this.config.identityUrl}${EXCHANGE_PROCEDURE}`, {
				method: "POST",
				headers: {
					"X-Service-Token": this.config.identityServiceToken,
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
				},
				body: JSON.stringify({ accessToken: token }),
			});
		} catch {
			return null;
		}

		const subject = typeof body.subject === "string" ? body.subject.trim() : "";
		const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		const apiDelegationToken =
			typeof body.apiDelegationToken === "string" ? body.apiDelegationToken.trim() : "";
		const scope = stringArray(body.scopes);
		const expiresAtUnix = Number(body.expiresAtUnix);
		const expiresAt = Number.isFinite(expiresAtUnix) ? expiresAtUnix * 1000 : undefined;
		if (
			!subject ||
			!workspaceId ||
			!clientId ||
			!apiDelegationToken ||
			!scope.includes(this.config.scope) ||
			(expiresAt !== undefined && expiresAt <= Date.now())
		) {
			return null;
		}

		const authorization: DelegatedAuthorization = {
			tokenDigest: digest,
			subject,
			workspaceId,
			clientId,
			scope,
			...(expiresAt !== undefined ? { expiresAt } : {}),
			apiDelegationToken,
		};
		this.cache.set(digest, {
			authorization,
			cachedUntil: Math.min(Date.now() + TOKEN_CACHE_MS, expiresAt ?? Number.POSITIVE_INFINITY),
		});
		return authorization;
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

export class OAuthResourceRoutes {
	constructor(private readonly config: OAuthConfig) {}

	async handle(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
			json(res, 200, {
				resource: this.config.resource,
				authorization_servers: [this.config.issuer],
				scopes_supported: [this.config.scope, "offline_access"],
				bearer_methods_supported: ["header"],
				resource_name: "Tenki MCP",
			});
			return true;
		}
		if (url.pathname === "/healthz") {
			json(res, 200, { status: "ok" });
			return true;
		}
		return false;
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
