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

const tenkiMark = `<svg viewBox="0 0 31 32" role="img" aria-label="Tenki"><path d="M23.0501 10.0904 14.7539 4.65703c-.8249-.54024-.7734-1.76746.0939-2.23639L18.9798.186532c.4198-.226983.93-.205482 1.3293.05602l9.4763 6.206188c.368.24104.5895.65207.5887 1.09254l-.0204 11.34092c-.0009.4778-.2629.9168-.6827 1.1438l-4.132 2.2341c-.8673.469-1.9198-.1613-1.918-1.1485l.0179-9.9287c.0008-.4404-.2207-.8515-.5888-1.0925Z"/><path d="m12.1862 17.4882-.0237 13.1749c-.0018.9872 1.0508 1.6175 1.918 1.1485l5.8372-3.156c.4198-.227.6818-.666.6827-1.1439l.0262-14.5871c.0008-.4404-.2207-.8515-.5887-1.0925L7.84912 3.84947c-.39929-.26151-.90947-.28301-1.32928-.05602L.682712 6.94949c-.867289.46893-.918838 1.69615-.093938 2.23639L11.5975 16.3957c.368.241.5895.6521.5887 1.0925Z"/><path d="M4.65476 20.6463c-.0007.3854.19503.7451.52013.956l4.05117 2.6278c.17295.1122.27704.3035.27666.5085l-.0075 4.0899c-.00089.4813-.53944.7697-.94542.5063l-8.016264-5.2c-.32513-.2109-.520829-.5706-.520129-.956l.017251-10.036c.000878-.4812.539426-.7697.945409-.5052L4.3867 14.8489c.17294.1122.27703.3035.27665.5085l-.00859 5.2889Z"/></svg>`;

function page(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000a15"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark;--tenki-blue:#047bff;--tenki-blue-dark:#00369f;--background:#000a15;--surface:#07111f;--surface-raised:#0b1626;--border:#1b3048;--border-active:#4c9dff;--text:#f8fafc;--muted:#8b97a7;--soft:#c8d2df}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(70rem 34rem at 50% -8%,#073a724d 0%,transparent 62%),var(--background);color:var(--text);font:15px/1.5 Geist,Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;padding:2rem 1rem}
.shell{width:min(35rem,100%)}
.brand{display:flex;align-items:center;gap:.7rem;margin:0 0 1.25rem .25rem;color:#fff;font-size:1.05rem;font-weight:700;letter-spacing:-.02em}
.brand svg{width:25px;height:26px;fill:var(--tenki-blue);filter:drop-shadow(0 0 12px #047bff55)}
.card{position:relative;overflow:hidden;background:linear-gradient(145deg,#0b1626f5,#06101df7);border:1px solid var(--border);border-radius:20px;padding:2rem;box-shadow:0 28px 80px #0009,0 1px 0 #ffffff0a inset}
.card:before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,#4c9dff88,transparent)}
.eyebrow{display:flex;align-items:center;gap:.5rem;margin-bottom:.8rem;color:#72b5ff;font-size:.75rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--tenki-blue);box-shadow:0 0 12px #047bff}
h1{margin:0;color:#fff;font-size:clamp(1.65rem,5vw,2rem);line-height:1.18;letter-spacing:-.035em}
.lead{margin:.8rem 0 0;color:var(--soft);font-size:1rem}
.identity{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1.35rem 0 1.25rem;padding:.8rem .9rem;background:#ffffff08;border:1px solid #ffffff0d;border-radius:10px}
.identity span{color:var(--muted);font-size:.8rem}
.identity strong{overflow:hidden;color:#d9e9fb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;text-overflow:ellipsis;white-space:nowrap}
.section-label{margin-bottom:.65rem;color:#dce8f5;font-size:.8rem;font-weight:650}
.workspace-list{display:grid;gap:.65rem}
.choice{display:grid;grid-template-columns:20px minmax(0,1fr);gap:.75rem;align-items:center;padding:.9rem;background:#ffffff05;border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
.choice:hover{border-color:#315578;background:#0c1c30;transform:translateY(-1px)}
.choice:has(input:checked){border-color:var(--border-active);background:linear-gradient(90deg,#047bff1f,#047bff0a);box-shadow:0 0 0 1px #047bff22 inset}
.choice input{appearance:none;width:18px;height:18px;margin:0;border:1.5px solid #58718e;border-radius:50%;display:grid;place-items:center}
.choice input:before{content:"";width:8px;height:8px;border-radius:50%;background:#fff;transform:scale(0);transition:transform .12s}
.choice input:checked{border:5px solid var(--tenki-blue);background:#fff}
.choice input:checked:before{transform:scale(1)}
.workspace-name{display:block;color:#f8fbff;font-weight:650}
.workspace-id{display:block;overflow:hidden;margin-top:.15rem;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;text-overflow:ellipsis;white-space:nowrap}
.permission{display:flex;gap:.75rem;margin:1rem 0 0;padding:.8rem .9rem;background:#047bff0c;border:1px solid #047bff1f;border-radius:10px;color:#9fb0c3;font-size:.8rem}
.permission svg{flex:0 0 auto;width:17px;height:17px;color:#72b5ff}
.permission strong{display:block;margin-bottom:.1rem;color:#cfdeef;font-weight:650}
button{width:100%;margin-top:1.25rem;padding:.82rem 1rem;border:1px solid #3b94f5;border-radius:10px;background:linear-gradient(180deg,#1687ff,var(--tenki-blue-dark));box-shadow:0 8px 24px #047bff2b;color:#fff;font:inherit;font-weight:700;cursor:pointer;transition:filter .15s,transform .15s,box-shadow .15s}
button:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 10px 28px #047bff40}
button:focus-visible,.choice:has(input:focus-visible){outline:2px solid #89c4ff;outline-offset:3px}
.error-symbol{display:grid;width:42px;height:42px;margin-bottom:1rem;border:1px solid #f8717140;border-radius:12px;background:#ef444418;color:#fca5a5;place-items:center;font-size:1.25rem;font-weight:700}
.error-note{margin-top:1.25rem;padding:.8rem .9rem;background:#ffffff07;border:1px solid #ffffff0d;border-radius:10px;color:var(--muted);font-size:.82rem}
.footer{margin:1rem 0 0;color:#5f7187;text-align:center;font-size:.72rem}
@media(max-width:520px){body{padding:1rem}.card{padding:1.35rem}.identity{align-items:flex-start;flex-direction:column;gap:.2rem}}
</style></head><body><div class="shell"><header class="brand">${tenkiMark}<span>tenki</span></header><main class="card">${content}</main><p class="footer">Secure authorization powered by Tenki</p></div></body></html>`;
}

export function requestOriginAllowed(origin: string | undefined, publicUrl: string): boolean {
	if (!origin) return true;
	try {
		return new URL(origin).origin === new URL(publicUrl).origin;
	} catch {
		return false;
	}
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
					(workspace, index) => `<label class="choice"><input type="radio" name="workspace_id" value="${escapeHtml(workspace.id)}"${index === 0 ? " checked" : ""}><span><span class="workspace-name">${escapeHtml(workspace.name)}</span><span class="workspace-id">${escapeHtml(workspace.id)}</span></span></label>`,
				)
				.join("");
			html(
				res,
				200,
				page(
					"Authorize Tenki MCP",
					`<div class="eyebrow">MCP authorization</div><h1>Connect ${escapeHtml(clientName)} to Tenki</h1><p class="lead">Choose the workspace this connection may use.</p><div class="identity"><span>Signed in as</span><strong>${escapeHtml(identity.email || identity.id)}</strong></div><form method="post" action="/oauth/consent"><input type="hidden" name="consent_challenge" value="${escapeHtml(challenge)}"><div class="section-label">Workspace access</div><div class="workspace-list">${choices}</div><div class="permission"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/><path d="m9.2 12 1.8 1.8 3.8-4"/></svg><span><strong>Workspace-scoped access</strong>${escapeHtml(clientName)} can create and manage sandboxes only in the workspace you authorize.</span></div><button type="submit">Authorize workspace</button></form>`,
				),
			);
		} catch (error) {
			this.error(res, 502, (error as Error).message);
		}
	}

	private async acceptConsent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this.requireUiConfig();
		if (!requestOriginAllowed(req.headers.origin, this.config.publicUrl)) {
			console.warn(`tenki-mcp: rejected OAuth consent origin ${JSON.stringify(req.headers.origin)}`);
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
		html(
			res,
			status,
			page(
				"Tenki OAuth error",
				`<div class="error-symbol" aria-hidden="true">!</div><div class="eyebrow">Authorization stopped</div><h1>Could not connect to Tenki</h1><p class="lead">${escapeHtml(message)}</p><div class="error-note">Return to Claude Code and run <strong>claude mcp login</strong> again. If the problem continues, contact your Tenki administrator.</div>`,
			),
		);
	}
}

export function bearerToken(header: string | undefined): string | null {
	const match = /^Bearer (.+)$/.exec(header ?? "");
	return match?.[1]?.trim() || null;
}

export function authorizationDigest(authorization: DelegatedAuthorization): string {
	return tokenDigest(authorization.token);
}
