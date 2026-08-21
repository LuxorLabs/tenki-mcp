/**
 * auth_status.ts — the one tool that works without a credential.
 *
 * Without this, a user who installs the server before setting a token gets a
 * process that exits 1; MCP clients surface that as "server failed to start"
 * and usually swallow stderr, so the actual cause (no token) is invisible. The
 * server therefore boots credential-less with ONLY this tool registered, so an
 * agent can ask what's wrong and get an actionable answer.
 *
 * It reports status; it does NOT log in. Obtaining a token is out of scope for
 * the server (see `tenki login`), and nothing here opens a browser or writes
 * credentials anywhere.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";

/** How a credential was supplied, derived from the token's prefix. */
export type CredentialKind = "none" | "api_key" | "oauth_session_token" | "session_cookie";

export interface CredentialInfo {
	kind: CredentialKind;
	/** Env var the token came from, or undefined when there is none. */
	source?: "TENKI_AUTH_TOKEN" | "TENKI_API_KEY";
}

/**
 * Classify the ambient credential WITHOUT returning any of its material.
 * Mirrors the header selection in client.ts (`tk_` → Bearer API key,
 * `ory_st_` → OAuth/Ory session token, anything else → session cookie) and
 * index.ts's precedence (TENKI_AUTH_TOKEN wins over TENKI_API_KEY).
 */
export function describeCredential(env: NodeJS.ProcessEnv = process.env): CredentialInfo {
	const fromToken = env.TENKI_AUTH_TOKEN?.trim();
	const fromKey = env.TENKI_API_KEY?.trim();
	const raw = fromToken || fromKey;
	if (!raw) return { kind: "none" };
	const source = fromToken ? "TENKI_AUTH_TOKEN" : "TENKI_API_KEY";
	if (raw.startsWith("tk_")) return { kind: "api_key", source };
	if (raw.startsWith("ory_st_")) return { kind: "oauth_session_token", source };
	return { kind: "session_cookie", source };
}

const CREDENTIAL_HELP: Record<CredentialKind, string> = {
	none: "No credential found. Set TENKI_API_KEY (a tk_… API key) or TENKI_AUTH_TOKEN (an ory_st_… session token) in the server's environment, then restart it — MCP clients pass env through their server config, e.g. `claude mcp add tenki --env TENKI_API_KEY=tk_… -- npx -y @tenkicloud/mcp`, or the \"env\" block in claude_desktop_config.json / .cursor/mcp.json.",
	api_key: "Authenticated with a tk_… API key (Authorization: Bearer).",
	oauth_session_token: "Authenticated with an ory_st_… session token (X-Session-Token). Session tokens expire; an API key is the stabler choice for a long-running server.",
	session_cookie: "Authenticated with a session cookie (the token matched neither the tk_ nor ory_st_ prefix, so it is sent as a tenki_session cookie). If that is not what you intended, check the value.",
};

const authOutputSchema = {
	authenticated: z.boolean().describe("True only when a credential is present AND a live identity probe succeeded."),
	credential: z
		.enum(["none", "api_key", "oauth_session_token", "session_cookie"])
		.describe("Kind of credential the server is running with, derived from its prefix. Never includes the token itself."),
	source: z
		.string()
		.optional()
		.describe("Environment variable the credential came from (TENKI_AUTH_TOKEN takes precedence over TENKI_API_KEY)."),
	endpoint: z.string().describe("Control-plane base URL the server is pointed at."),
	toolsRegistered: z
		.number()
		.int()
		.describe("How many tools this server registered. Without a credential only this one is registered."),
	identity: z
		.object({
			ownerType: z.string().optional(),
			ownerId: z.string().optional(),
			workspaces: z.number().int().optional(),
		})
		.optional()
		.describe("Identity returned by the live probe, when it succeeded."),
	error: z.string().optional().describe("Why the probe failed, when a credential is present but unusable (expired, revoked, wrong endpoint)."),
	detail: z.string().describe("Human-readable status plus, when unauthenticated, how to supply a credential."),
};

/**
 * Report authentication status. `client` is null when the server booted without
 * a credential; `toolsRegistered` lets the caller see it is in that degraded
 * single-tool mode rather than guessing from a short tools/list.
 */
export function registerAuthStatus(server: McpServer, client: TenkiClient | null, toolsRegistered: number): void {
	server.registerTool(
		"tenki_auth_status",
		{
			description:
				"Report whether the server has a usable Tenki credential, which kind (API key vs OAuth session token), and the endpoint it targets — verified with a live identity probe. Call this first when other tools fail with auth errors, or when this is the only tool available (which means no credential is configured). Reports status only; it does not log in and never returns the token.",
			inputSchema: {},
			outputSchema: authOutputSchema,
		},
		async () => {
			const cred = describeCredential();
			const endpoint = process.env.TENKI_API_ENDPOINT || process.env.TENKI_API_URL || "https://api.tenki.cloud";
			const base = {
				credential: cred.kind,
				...(cred.source ? { source: cred.source } : {}),
				endpoint,
				toolsRegistered,
			};

			if (!client || cred.kind === "none") {
				const result = {
					...base,
					authenticated: false,
					detail: CREDENTIAL_HELP.none,
				};
				return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
			}

			try {
				const resp = await client.control("WhoAmI", {});
				const workspaces = Array.isArray(resp.workspaces) ? resp.workspaces.length : undefined;
				const result = {
					...base,
					authenticated: true,
					identity: {
						...(typeof resp.ownerType === "string" ? { ownerType: resp.ownerType } : {}),
						...(typeof resp.ownerId === "string" ? { ownerId: resp.ownerId } : {}),
						...(workspaces !== undefined ? { workspaces } : {}),
					},
					detail: CREDENTIAL_HELP[cred.kind],
				};
				return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
			} catch (e) {
				const result = {
					...base,
					authenticated: false,
					error: (e as Error).message,
					detail: `A ${cred.kind === "api_key" ? "tk_… API key" : "credential"} is set (from ${cred.source}) but the identity probe failed — it may be expired, revoked, or the endpoint may be wrong. ${CREDENTIAL_HELP.none}`,
				};
				return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
			}
		},
	);
}
