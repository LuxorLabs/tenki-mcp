/**
 * TenkiClient — a dependency-free client for the Tenki Cloud API.
 *
 * Tenki's API is ConnectRPC (JSON over HTTP/1.1), not REST. Every control-plane
 * call is `POST {baseUrl}/tenki.sandbox.v1.SandboxService/{Method}` with a
 * lowerCamelCase JSON body and a JSON response. Per-session file I/O runs on a
 * separate data-plane endpoint returned at session-create time, authenticated
 * with a short-lived session certificate.
 *
 * The wire details here (headers, the control/data-plane split, and capturing
 * command stdout/stderr via an `sh -c` redirect + data-plane ReadFile) are
 * ported from the live-verified n8n community node
 * (github.com/opencolin/n8n-nodes-tenki).
 */

const CONTROL_SERVICE = "tenki.sandbox.v1.SandboxService";
const DATA_SERVICE = "tenki.sandbox.v1.SandboxSessionDataPlaneService";
const DEFAULT_BASE_URL = "https://api.tenki.cloud";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;
// Rate-limit rejections happen before the server does any work, so they are
// safe to retry for EVERY method.
const RATE_LIMIT_CODES = new Set(["rate_limited", "ratelimited", "resource_exhausted", "resourceexhausted"]);
// `unavailable` can arrive after the server partially applied a call, so it is
// retried only for idempotent (read-shaped) methods — retrying a half-applied
// CreateSession would boot and bill a second sandbox.
const IDEMPOTENT_METHOD = /^(Get|List|WhoAmI|Resolve|Wait|Stat)/;
const RETRY_AFTER_CAP_MS = 30_000;

// Every fetch carries a timeout so a hung connection fails the tool call with a
// clear error instead of blocking it forever (see TenkiClientOptions).
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 630_000; // runCode's 600s hard cap + margin
const EXEC_TIMEOUT_MARGIN_MS = 30_000; // headroom over a command's own timeout

// Session-credential cache lifetime handling: a credential whose expiry the API
// omits (or that we cannot parse) is assumed valid only briefly — never forever —
// and a known expiry is refreshed early so an in-flight call cannot straddle it.
const DEFAULT_CRED_TTL_MS = 60_000;
const CRED_EXPIRY_SKEW_MS = 30_000;
const MIN_CRED_TTL_MS = 5_000; // floor for the skewed expiry of a short-lived credential

/** Home directory of the sandbox's `tenki` user; run-code scripts and capture files live here. */
const SANDBOX_HOME = "/home/tenki";

export type Language = "shell" | "python" | "javascript";

export interface ExecResult {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	ok: boolean;
	captureError?: string;
}

interface CachedCredential {
	endpoint: string;
	token: string;
	/** Epoch ms after which the entry is considered stale (always finite). */
	expiresAt: number;
}

export interface TenkiClientOptions {
	/** Timeout for unary control/data-plane calls (default 30s). */
	timeoutMs?: number;
	/** Timeout for ExecuteCommand when the command itself has no timeout (default 630s). */
	execTimeoutMs?: number;
	/** Assumed session-credential lifetime when the API returns no parseable expiry (default 60s). */
	credTtlMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeJson(text: string): Record<string, unknown> | undefined {
	try {
		const p: unknown = JSON.parse(text);
		return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** POSIX single-quote a string for safe use inside `sh -c`. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Tenki's auth header is chosen by token prefix (verbatim from the SDK's auth.ts):
 * `tk_` → Bearer, `ory_st_` → X-Session-Token, otherwise a `tenki_session` cookie.
 */
function authHeaders(token: string): Record<string, string> {
	const t = token.trim();
	if (t.startsWith("tk_")) return { Authorization: `Bearer ${t}` };
	if (t.startsWith("ory_st_")) return { "X-Session-Token": t };
	return { Cookie: `tenki_session=${t}` };
}

function interpreterFor(language: Language): { file: string; command: string; args: string[] } {
	switch (language) {
		case "python":
			return { file: `${SANDBOX_HOME}/main.py`, command: "python3", args: [`${SANDBOX_HOME}/main.py`] };
		case "javascript":
			return { file: `${SANDBOX_HOME}/main.js`, command: "node", args: [`${SANDBOX_HOME}/main.js`] };
		case "shell":
		default:
			return { file: `${SANDBOX_HOME}/main.sh`, command: "sh", args: [`${SANDBOX_HOME}/main.sh`] };
	}
}

export class TenkiClient {
	private readonly baseUrl: string;
	private readonly credCache = new Map<string, CachedCredential>();
	private readonly timeoutMs: number;
	private readonly execTimeoutMs: number;
	private readonly credTtlMs: number;

	constructor(private readonly token: string, baseUrl: string = DEFAULT_BASE_URL, opts: TenkiClientOptions = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.execTimeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
		this.credTtlMs = opts.credTtlMs ?? DEFAULT_CRED_TTL_MS;
	}

	/**
	 * ExecuteCommand blocks until the command finishes, so its timeout follows
	 * the command's own timeout (plus margin) instead of the unary default.
	 */
	private timeoutFor(method: string, body: Record<string, unknown>): number {
		if (method !== "ExecuteCommand") return this.timeoutMs;
		const t = typeof body.timeout === "string" ? Number.parseInt(body.timeout, 10) : Number.NaN; // "30s"
		return Number.isFinite(t) && t > 0 ? t * 1000 + EXEC_TIMEOUT_MARGIN_MS : this.execTimeoutMs;
	}

	/** fetch with a hard timeout and a readable error instead of a bare AbortError. */
	private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
		try {
			return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		} catch (e) {
			const name = (e as Error)?.name;
			if (name === "TimeoutError" || name === "AbortError") {
				throw new Error(`Tenki ${what} timed out after ${timeoutMs}ms with no response.`);
			}
			throw e;
		}
	}

	/** Retry policy: rate limits always; `unavailable` only for idempotent methods. */
	private shouldRetry(method: string, status: number, code: string): boolean {
		if (status === 429 || RATE_LIMIT_CODES.has(code)) return true;
		return code === "unavailable" && IDEMPOTENT_METHOD.test(method);
	}

	/** Exponential backoff with half-jitter; a Retry-After header (seconds) wins, capped. */
	private backoffMs(attempt: number, retryAfter: string | null): number {
		const ra = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN;
		if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
		const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
		return base / 2 + Math.random() * (base / 2);
	}

	/**
	 * Unary control-plane call. Every attempt carries a timeout. Rate-limit
	 * rejections retry with jittered backoff (honoring Retry-After); transient
	 * `unavailable` errors AND transport-level failures (timeout, connection
	 * reset, DNS) retry only for idempotent methods, because a non-idempotent
	 * call (CreateSession) may have partially applied.
	 * `service` defaults to SandboxService; pass another fully-qualified ConnectRPC
	 * service (e.g. the SSH gateway service) for methods hosted elsewhere.
	 */
	async control(method: string, body: Record<string, unknown> = {}, service: string = CONTROL_SERVICE): Promise<Record<string, any>> {
		const url = `${this.baseUrl}/${service}/${method}`;
		const timeoutMs = this.timeoutFor(method, body ?? {});
		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await this.fetchWithTimeout(
					url,
					{
						method: "POST",
						headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", ...authHeaders(this.token) },
						body: JSON.stringify(body ?? {}),
					},
					timeoutMs,
					method,
				);
			} catch (e) {
				// Transport failure: the request may or may not have reached the
				// server, so only idempotent methods are safe to retry.
				if (attempt < MAX_RETRIES && IDEMPOTENT_METHOD.test(method)) {
					await sleep(this.backoffMs(attempt, null));
					continue;
				}
				throw e;
			}
			if (res.ok) return (await res.json()) as Record<string, any>;

			const text = await res.text();
			const parsed = safeJson(text);
			const code = typeof parsed?.code === "string" ? parsed.code.toLowerCase() : "";
			if (attempt < MAX_RETRIES && this.shouldRetry(method, res.status, code)) {
				await sleep(this.backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			const msg = (parsed?.message as string) || text || res.statusText;
			throw new Error(`Tenki ${method} failed (${res.status}${code ? ` ${code}` : ""}): ${msg}`);
		}
	}

	/**
	 * Mint (and cache per session) the data-plane endpoint + session certificate.
	 * A credential with no parseable expiry is cached for credTtlMs — never
	 * forever — and a known expiry is shortened by a skew so an in-flight call
	 * can't straddle the real expiry.
	 */
	private async credentialFor(sessionId: string): Promise<CachedCredential> {
		const cached = this.credCache.get(sessionId);
		if (cached && cached.expiresAt > Date.now()) return cached;

		const resp = await this.control("CreateSessionCredential", { sessionId });
		const cred = (resp.credential as Record<string, any>) ?? resp;
		const token = (cred.credential ?? cred.token) as string;
		const endpoint = (resp.dataPlaneEndpoint ?? resp.data_plane_endpoint ?? resp.routeStatus?.endpoint) as
			| string
			| undefined;

		let expiresAt = Date.now() + this.credTtlMs;
		const raw = cred.expiresAt ?? cred.expires_at;
		if (typeof raw === "string") {
			const p = Date.parse(raw);
			// Floor the skewed expiry so a short-lived credential (< skew) is still
			// cached briefly instead of the cache being disabled outright; a cert
			// that expires server-side anyway is recovered by the 401 re-mint path.
			if (!Number.isNaN(p)) expiresAt = Math.max(p - CRED_EXPIRY_SKEW_MS, Date.now() + MIN_CRED_TTL_MS);
		}
		const entry: CachedCredential = { endpoint: endpoint ?? "", token, expiresAt };
		this.credCache.set(sessionId, entry);
		return entry;
	}

	/**
	 * Unary data-plane call. The inner request is wrapped as
	 * `{ request: { sessionId, ...request } }`. An auth failure invalidates the
	 * cached session certificate (it may have expired server-side regardless of
	 * what its stated expiry said) and retries once with a fresh one.
	 */
	async data(
		sessionId: string,
		method: string,
		request: Record<string, unknown> = {},
		retriedAuth = false,
	): Promise<Record<string, any>> {
		const cred = await this.credentialFor(sessionId);
		if (!cred.endpoint) {
			throw new Error(`Could not resolve the data-plane endpoint for session ${sessionId}.`);
		}
		const url = `${cred.endpoint.replace(/\/+$/, "")}/${DATA_SERVICE}/${method}`;
		const res = await this.fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Connect-Protocol-Version": "1",
					"x-tenki-session-cert": cred.token,
				},
				body: JSON.stringify({ request: { sessionId, ...request } }),
			},
			this.timeoutMs,
			`data ${method}`,
		);
		if (!res.ok) {
			const text = await res.text();
			const parsed = safeJson(text);
			const code = typeof parsed?.code === "string" ? parsed.code.toLowerCase() : "";
			const authFailure = res.status === 401 || res.status === 403 || code === "unauthenticated" || code === "permission_denied";
			if (authFailure && !retriedAuth) {
				this.credCache.delete(sessionId);
				return this.data(sessionId, method, request, true);
			}
			throw new Error(`Tenki data ${method} failed (${res.status}): ${(parsed?.message as string) || text}`);
		}
		const wrapped = (await res.json()) as Record<string, any>;
		return (wrapped.response as Record<string, any>) ?? wrapped;
	}

	/**
	 * Resolve the calling identity + a default workspace/project for CreateSession
	 * (which requires a projectId). Picks the first workspace that has a project so
	 * the (workspace, project) pair stays consistent.
	 *
	 * CreateSession validates owner_type ∈ {SERVICE, USER} and requires a
	 * non-empty owner_id, but derives the real owner from the authenticated
	 * identity server-side. WhoAmI can return other owner types (e.g. WORKSPACE
	 * for workspace-scoped keys), which the validator rejects — so for those we
	 * send the same placeholder the first-party SDKs hardcode ("SERVICE"/"self").
	 */
	async resolveOwner(): Promise<{ ownerType?: string; ownerId?: string; workspaceId?: string; projectId?: string }> {
		const resp = await this.control("WhoAmI", {});
		const workspaces: any[] = Array.isArray(resp.workspaces) ? resp.workspaces : [];
		const ws = workspaces.find((w) => Array.isArray(w?.projects) && w.projects.length > 0) ?? workspaces[0];
		const proj = Array.isArray(ws?.projects) ? ws.projects[0] : undefined;
		let ownerType = resp.ownerType as string | undefined;
		let ownerId = resp.ownerId as string | undefined;
		// Substitute the placeholder only when WhoAmI returned a type CreateSession
		// rejects. When ownerType is absent entirely, leave it absent — callers omit
		// the owner fields and the server derives the owner from the identity.
		if (ownerType && ownerType !== "USER" && ownerType !== "SERVICE") {
			ownerType = "SERVICE";
			ownerId = "self";
		}
		return {
			ownerType,
			ownerId,
			workspaceId: ws?.workspaceId ?? ws?.id,
			projectId: proj?.projectId ?? proj?.id,
		};
	}

	/** Poll GetSession until it reaches (or passes into) the target state. */
	async waitForState(
		sessionId: string,
		target = "RUNNING",
		{ timeoutMs = 180000, intervalMs = 1000 }: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<Record<string, any>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const resp = await this.control("GetSession", { sessionId });
			const session = (resp.session as Record<string, any>) ?? resp;
			const state = String(session.state ?? "");
			if (state.includes(target)) return session;
			if (["TERMINATED", "ERROR", "FAILED"].some((s) => state.includes(s))) {
				throw new Error(`Session ${sessionId} entered ${state} while waiting for ${target}.`);
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for session ${sessionId} to reach ${target} (last state: ${state}).`);
			}
			await sleep(intervalMs);
		}
	}

	async readTextFile(sessionId: string, path: string): Promise<string> {
		const resp = await this.data(sessionId, "ReadFile", { path });
		const content = (resp.content ?? resp.data ?? resp.file?.content ?? "") as string;
		return content ? Buffer.from(content, "base64").toString("utf8") : "";
	}

	async writeTextFile(sessionId: string, path: string, text: string): Promise<Record<string, any>> {
		const content = Buffer.from(text, "utf8").toString("base64");
		return this.data(sessionId, "WriteFile", { path, content });
	}

	/**
	 * Run a command in a session and return stdout/stderr inline.
	 *
	 * We wrap the command in `sh -c '<cmd> > out 2> err'`, then read the capture
	 * files back over the data plane, so output is available through a plain-HTTP
	 * client. Capture-read failures degrade gracefully into `captureError` rather
	 * than losing the run — but the result is marked NOT ok, because empty
	 * stdout/stderr next to a zero exit code would otherwise read as a clean,
	 * silent success.
	 */
	async execCaptured(
		sessionId: string,
		command: string,
		opts: { args?: string[]; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } = {},
	): Promise<ExecResult> {
		const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const outPath = `${SANDBOX_HOME}/.mcp-exec-${suffix}.out`;
		const errPath = `${SANDBOX_HOME}/.mcp-exec-${suffix}.err`;

		const execLine = [command, ...(opts.args ?? [])].map(shellQuote).join(" ");
		const cd = opts.cwd && opts.cwd.trim() ? `cd ${shellQuote(opts.cwd.trim())} && ` : "";
		const script = `${cd}${execLine} > ${outPath} 2> ${errPath}`;

		const body: Record<string, unknown> = { sessionId, command: "sh", args: ["-c", script] };
		if (opts.env && Object.keys(opts.env).length) body.env = opts.env;
		if (opts.timeoutSeconds && opts.timeoutSeconds > 0) body.timeout = `${opts.timeoutSeconds}s`;

		const resp = await this.control("ExecuteCommand", body);
		const execution = (resp.execution as Record<string, any>) ?? resp;
		// proto3 omits zero-valued fields: an absent exitCode means 0 (success).
		// A non-numeric shape coerces to NaN, which the exec outputSchema rejects,
		// failing the whole call and discarding the run's output — normalize an
		// unparseable code to -1 so the user still gets their stdout/stderr.
		const rawExit = typeof execution.exitCode === "number" ? execution.exitCode : Number(execution.exitCode ?? 0);
		const exitCode = Number.isFinite(rawExit) ? Math.trunc(rawExit) : -1;

		let stdout = "";
		let stderr = "";
		let captureError: string | undefined;
		try {
			stdout = await this.readTextFile(sessionId, outPath);
			stderr = await this.readTextFile(sessionId, errPath);
		} catch (e) {
			captureError = (e as Error).message;
		}
		try {
			await this.control("ExecuteCommand", { sessionId, command: "rm", args: ["-f", outPath, errPath] });
		} catch {
			// Session may have gone away; capture files die with it.
		}

		return {
			command,
			args: opts.args ?? [],
			stdout,
			stderr,
			exitCode,
			ok: exitCode === 0 && !captureError,
			...(captureError ? { captureError } : {}),
		};
	}

	/**
	 * One-shot: boot a throwaway sandbox, run code (shell / python / javascript),
	 * return its output, and terminate the sandbox. Cost-guarded (1 vCPU, 1 GB,
	 * 10-min cap, 5-min idle) so an ephemeral run can never leak a billing session.
	 */
	async runCode(
		language: Language,
		code: string,
		opts: { env?: Record<string, string>; timeoutSeconds?: number } = {},
	): Promise<ExecResult & { sessionId: string; language: Language }> {
		const owner = await this.resolveOwner();
		const create = await this.control("CreateSession", {
			cpuCores: 1,
			memoryMb: 1024,
			maxDuration: "600s",
			idleTimeoutMinutes: 5,
			...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
			...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
			...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
			...(owner.projectId ? { projectId: owner.projectId } : {}),
			...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
		});
		const session = (create.session as Record<string, any>) ?? create;
		const sessionId = (session.id ?? create.sessionId ?? create.id) as string;
		if (!sessionId) throw new Error("runCode: could not read the created session id from CreateSession.");

		try {
			await this.waitForState(sessionId, "RUNNING");
			const { file, command, args } = interpreterFor(language);
			await this.writeTextFile(sessionId, file, code);
			const result = await this.execCaptured(sessionId, command, {
				args,
				env: opts.env,
				timeoutSeconds: opts.timeoutSeconds,
			});
			return { sessionId, language, ...result };
		} finally {
			try {
				await this.control("TerminateSession", { sessionId });
			} catch {
				// Best-effort teardown; the idle/max-duration guards reap it regardless.
			}
		}
	}
}
