import { createHash } from "node:crypto";
import type http from "node:http";

const DEFAULT_SCOPE = "mcp";
const FETCH_TIMEOUT_MS = 8_000;
const TOKEN_CACHE_MS = 15_000;
const MAX_FORM_BYTES = 64 * 1024;

type JsonRecord = Record<string, any>;

export interface OAuthConfig {
	issuer: string;
	resource: string;
	publicUrl: string;
	metadataUrl: string;
	introspectionUrl: string;
	hydraAdminUrl: string;
	hydraPublicUrl: string;
	kratosWhoamiUrl: string;
	kratosBrowserLoginUrl: string;
	kratosSessionCookie: string;
	controlApiUrl: string;
	scope: string;
}

export interface DelegatedAuthorization {
	token: string;
	subject: string;
	workspaceId: string;
	clientId: string;
	scope: string[];
	expiresAt?: number;
}

function trimUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function loadOAuthConfig(): OAuthConfig | null {
	const issuer = trimUrl(process.env.TENKI_MCP_OAUTH_ISSUER || "");
	const introspectionUrl = trimUrl(process.env.TENKI_MCP_OAUTH_INTROSPECTION_URL || "");
	const publicUrl = trimUrl(process.env.TENKI_MCP_PUBLIC_URL || "");
	if (!issuer && !introspectionUrl && !publicUrl) return null;
	if (!issuer || !introspectionUrl || !publicUrl) {
		throw new Error("TENKI_MCP_OAUTH_ISSUER, TENKI_MCP_OAUTH_INTROSPECTION_URL, and TENKI_MCP_PUBLIC_URL must be set together.");
	}

	const resource = trimUrl(process.env.TENKI_MCP_OAUTH_RESOURCE || `${publicUrl}/mcp`);
	return {
		issuer,
		resource,
		publicUrl,
		metadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
		introspectionUrl,
		hydraAdminUrl: trimUrl(process.env.TENKI_MCP_HYDRA_ADMIN_URL || ""),
		hydraPublicUrl: trimUrl(process.env.TENKI_MCP_HYDRA_PUBLIC_URL || ""),
		kratosWhoamiUrl: trimUrl(process.env.TENKI_MCP_KRATOS_WHOAMI_URL || ""),
		kratosBrowserLoginUrl: trimUrl(process.env.TENKI_MCP_KRATOS_BROWSER_LOGIN_URL || ""),
		kratosSessionCookie: (process.env.TENKI_MCP_KRATOS_SESSION_COOKIE || "tenki_session").trim(),
		controlApiUrl: trimUrl(process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || "https://api.tenki.cloud"),
		scope: (process.env.TENKI_MCP_OAUTH_SCOPE || DEFAULT_SCOPE).trim(),
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
		throw new Error(`${url} returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok) {
		const detail = typeof body.error_description === "string" ? body.error_description : body.error;
		throw new Error(`${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}
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
			token,
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		Pragma: "no-cache",
	});
	res.end(JSON.stringify(body));
}

function html(res: http.ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
	res.end(body);
}

function redirect(res: http.ServerResponse, location: string): void {
	res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
	res.end();
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function page(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#07101f;color:#f8fafc;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(34rem,calc(100% - 3rem));background:#0f172a;border:1px solid #334155;border-radius:16px;padding:2rem;box-shadow:0 24px 80px #0008}h1{margin:0 0 .75rem;font-size:1.6rem}p{color:#cbd5e1;line-height:1.5}.choice{display:block;border:1px solid #475569;border-radius:10px;padding:.9rem;margin:.75rem 0}.choice:has(input:checked){border-color:#38bdf8;background:#082f49}button{width:100%;margin-top:1rem;padding:.8rem;border:0;border-radius:9px;background:#0ea5e9;color:white;font-weight:700;font-size:1rem}code{color:#7dd3fc}</style></head><body><main class="card">${content}</main></body></html>`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_FORM_BYTES) {
				reject(new Error("form too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
	return new URLSearchParams((await readBody(req)).toString("utf8"));
}

function cookieValue(header: string | undefined, name: string): string | null {
	for (const part of (header || "").split(";")) {
		const index = part.indexOf("=");
		if (index < 0 || part.slice(0, index).trim() !== name) continue;
		return part.slice(index + 1).trim() || null;
	}
	return null;
}

interface BrowserIdentity {
	id: string;
	email: string;
	cookie: string;
}

interface WorkspaceChoice {
	id: string;
	name: string;
}

export class OAuthBrowserFlow {
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
		if (url.pathname === "/oauth/login" && req.method === "GET") {
			await this.login(req, res, url);
			return true;
		}
		if (url.pathname === "/oauth/consent" && req.method === "GET") {
			await this.showConsent(req, res, url);
			return true;
		}
		if (url.pathname === "/oauth/consent" && req.method === "POST") {
			await this.acceptConsent(req, res);
			return true;
		}
		if (url.pathname === "/oauth/logout" && req.method === "GET") {
			await this.logout(res, url);
			return true;
		}
		if (url.pathname === "/oauth/error" && req.method === "GET") {
			this.oauthError(res, url);
			return true;
		}
		return false;
	}

	private requireUiConfig(): void {
		if (!this.config.hydraAdminUrl || !this.config.kratosWhoamiUrl || !this.config.kratosBrowserLoginUrl) {
			throw new Error("OAuth login UI endpoints are not configured.");
		}
	}

	private requireHydraConfig(): void {
		if (!this.config.hydraAdminUrl) throw new Error("Hydra admin endpoint is not configured.");
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

	private async browserIdentity(req: http.IncomingMessage): Promise<BrowserIdentity | null> {
		const value = cookieValue(req.headers.cookie, this.config.kratosSessionCookie);
		if (!value) return null;
		const cookie = `${this.config.kratosSessionCookie}=${value}`;
		try {
			const session = await fetchJson(this.config.kratosWhoamiUrl, { headers: { Cookie: cookie } });
			if (session.active !== true || !session.identity?.id) return null;
			return {
				id: String(session.identity.id),
				email: String(session.identity.traits?.email ?? ""),
				cookie,
			};
		} catch {
			return null;
		}
	}

	private async login(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		this.requireUiConfig();
		const challenge = url.searchParams.get("login_challenge") || "";
		if (!challenge) return this.error(res, 400, "Missing login challenge.");

		const identity = await this.browserIdentity(req);
		if (!identity) {
			const returnTo = `${this.config.publicUrl}/oauth/login?${new URLSearchParams({ login_challenge: challenge })}`;
			redirect(res, `${this.config.kratosBrowserLoginUrl}?${new URLSearchParams({ return_to: returnTo })}`);
			return;
		}

		try {
			await this.hydraRequest("login", challenge);
			const accepted = await this.hydraDecision("login", "accept", challenge, {
				subject: identity.id,
				remember: false,
			});
			redirect(res, String(accepted.redirect_to));
		} catch (error) {
			this.error(res, 502, (error as Error).message);
		}
	}

	private async eligibleWorkspaces(identity: BrowserIdentity): Promise<WorkspaceChoice[]> {
		const list = await this.control("tenki.cloud.workspace.v1beta1.WorkspaceService", "ListWorkspaces", {}, identity.cookie);
		const candidates = Array.isArray(list.workspaces) ? list.workspaces : [];
		const eligible = await Promise.all(
			candidates.map(async (workspace: JsonRecord) => {
				const id = String(workspace.workspaceId ?? workspace.id ?? "");
				if (!id) return null;
				const permissions = await this.control(
					"tenki.cloud.identity.v1beta1.IdentityService",
					"GetUserPermissions",
					{ workspaceId: id },
					identity.cookie,
				);
				return permissions.workspacePermission?.edit === true
					? { id, name: String(workspace.name ?? id) }
					: null;
			}),
		);
		return eligible.filter((workspace): workspace is WorkspaceChoice => workspace !== null);
	}

	private async showConsent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		this.requireUiConfig();
		const challenge = url.searchParams.get("consent_challenge") || "";
		if (!challenge) return this.error(res, 400, "Missing consent challenge.");
		const identity = await this.browserIdentity(req);
		if (!identity) {
			const returnTo = `${this.config.publicUrl}/oauth/consent?${new URLSearchParams({ consent_challenge: challenge })}`;
			redirect(res, `${this.config.kratosBrowserLoginUrl}?${new URLSearchParams({ return_to: returnTo })}`);
			return;
		}

		try {
			const request = await this.hydraRequest("consent", challenge);
			if (String(request.subject ?? "") !== identity.id) return this.error(res, 403, "Signed-in identity does not match the OAuth request.");
			const workspaces = await this.eligibleWorkspaces(identity);
			if (!workspaces.length) return this.error(res, 403, "No workspace with edit access is available.");
			const clientName = request.client?.client_name || request.client?.client_id || "Claude";
			const choices = workspaces
				.map(
					(workspace, index) => `<label class="choice"><input type="radio" name="workspace_id" value="${escapeHtml(workspace.id)}"${index === 0 ? " checked" : ""}> <strong>${escapeHtml(workspace.name)}</strong><br><small>${escapeHtml(workspace.id)}</small></label>`,
				)
				.join("");
			html(
				res,
				200,
				page(
					"Authorize Tenki MCP",
					`<h1>Connect ${escapeHtml(clientName)} to Tenki</h1><p>Signed in as <code>${escapeHtml(identity.email || identity.id)}</code>. Choose the workspace Claude may use to create and manage sandboxes.</p><form method="post" action="/oauth/consent"><input type="hidden" name="consent_challenge" value="${escapeHtml(challenge)}">${choices}<button type="submit">Authorize workspace</button></form>`,
				),
			);
		} catch (error) {
			this.error(res, 502, (error as Error).message);
		}
	}

	private async acceptConsent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this.requireUiConfig();
		if (req.headers.origin && req.headers.origin !== new URL(this.config.publicUrl).origin) {
			return this.error(res, 403, "Invalid request origin.");
		}
		const identity = await this.browserIdentity(req);
		if (!identity) return this.error(res, 401, "Sign in again before authorizing.");

		try {
			const form = await readForm(req);
			const challenge = form.get("consent_challenge") || "";
			const workspaceId = form.get("workspace_id") || "";
			if (!challenge || !workspaceId) return this.error(res, 400, "Missing consent selection.");

			const request = await this.hydraRequest("consent", challenge);
			if (String(request.subject ?? "") !== identity.id) return this.error(res, 403, "Signed-in identity does not match the OAuth request.");
			const workspaces = await this.eligibleWorkspaces(identity);
			if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
				return this.error(res, 403, "The selected workspace is not available.");
			}
			const requestedScopes = scopes(request.requested_scope);
			if (!requestedScopes.includes(this.config.scope)) return this.error(res, 400, "The OAuth request is missing the MCP scope.");
			const grantScopes = requestedScopes.filter((scope) =>
				[this.config.scope, "offline_access", "openid"].includes(scope),
			);
			const requestedAudience = audiences(request.requested_access_token_audience);
			if (!requestedAudience.includes(this.config.resource)) {
				return this.error(res, 400, "The OAuth request is not bound to this MCP resource.");
			}

			const accepted = await this.hydraDecision("consent", "accept", challenge, {
				grant_scope: grantScopes,
				grant_access_token_audience: [this.config.resource],
				remember: false,
				session: {
					access_token: { workspace_id: workspaceId, email: identity.email },
					id_token: { email: identity.email },
				},
			});
			redirect(res, String(accepted.redirect_to));
		} catch (error) {
			this.error(res, 502, (error as Error).message);
		}
	}

	private async logout(res: http.ServerResponse, url: URL): Promise<void> {
		this.requireHydraConfig();
		const challenge = url.searchParams.get("logout_challenge") || "";
		if (!challenge) return this.error(res, 400, "Missing logout challenge.");

		try {
			const query = new URLSearchParams({ logout_challenge: challenge });
			await fetchJson(`${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/logout?${query}`);
			const accepted = await fetchJson(
				`${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/logout/accept?${query}`,
				{ method: "PUT" },
			);
			redirect(res, String(accepted.redirect_to));
		} catch (error) {
			this.error(res, 502, (error as Error).message);
		}
	}

	private oauthError(res: http.ServerResponse, url: URL): void {
		const message =
			url.searchParams.get("error_description") ||
			url.searchParams.get("error") ||
			url.searchParams.get("hint") ||
			"The OAuth request could not be completed.";
		this.error(res, 400, message);
	}

	private hydraRequest(kind: "login" | "consent", challenge: string): Promise<JsonRecord> {
		const query = new URLSearchParams({ [`${kind}_challenge`]: challenge });
		return fetchJson(`${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/${kind}?${query}`);
	}

	private hydraDecision(kind: "login" | "consent", decision: "accept" | "reject", challenge: string, body: JsonRecord): Promise<JsonRecord> {
		const query = new URLSearchParams({ [`${kind}_challenge`]: challenge });
		return fetchJson(`${this.config.hydraAdminUrl}/admin/oauth2/auth/requests/${kind}/${decision}?${query}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	private control(service: string, method: string, body: JsonRecord, cookie: string): Promise<JsonRecord> {
		return fetchJson(`${this.config.controlApiUrl}/${service}/${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
				Cookie: cookie,
			},
			body: JSON.stringify(body),
		});
	}

	private error(res: http.ServerResponse, status: number, message: string): void {
		html(res, status, page("Tenki OAuth error", `<h1>Could not authorize Tenki</h1><p>${escapeHtml(message)}</p>`));
	}
}

export function bearerToken(header: string | undefined): string | null {
	const match = /^Bearer (.+)$/.exec(header ?? "");
	return match?.[1]?.trim() || null;
}

export function authorizationDigest(authorization: DelegatedAuthorization): string {
	return tokenDigest(authorization.token);
}
