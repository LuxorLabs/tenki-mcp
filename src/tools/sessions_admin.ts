import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema, tagsPatch, tagsSchema } from "./common.js";

/**
 * Extended sandbox (session) admin ops on the control plane: wall-clock lifetime
 * extension, mutable-field updates, bulk termination, activity heartbeats, and
 * workspace-scoped listing. The lifecycle basics
 * (create/get/list/terminate/pause/resume) live in sandboxes.ts.
 */
export function registerSessionsAdmin(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_extend_sandbox",
		"Extend a running sandbox's wall-clock lifetime by N seconds so it isn't auto-terminated at its max-duration cap.",
		{
			session_id: sessionIdSchema.describe("The sandbox/session ID to extend."),
			additional_duration_seconds: z
				.number()
				.int()
				.positive()
				.describe("Extra lifetime to add, in seconds (sent as a Duration string, e.g. 3600s)."),
		},
		async ({ session_id, additional_duration_seconds }) =>
			ok(
				await client.control("ExtendSession", {
					sessionId: session_id,
					additionalDuration: `${additional_duration_seconds}s`,
				}),
			),
	);

	server.tool(
		"tenki_update_sandbox",
		"Update mutable fields on an existing sandbox: name, tags, sticky flag, or max duration. The idle timeout is NOT updatable after creation (UpdateSession has no such field). max_duration_seconds requires an explicit sticky value on the wire — when you pass it without `sticky`, sticky=false is sent for you; sticky=true discards max_duration with a warning. The response carries any `warnings` the API returned.",
		{
			session_id: sessionIdSchema.describe("The sandbox/session ID to update."),
			name: z.string().max(64).optional().describe("New human-readable name (max 64 chars)."),
			tags: tagsSchema.describe("Replacement tag list. Pass [] (or clear_tags) to remove all tags."),
			clear_tags: z.boolean().optional().describe("Remove all tags from the sandbox."),
			sticky: z
				.boolean()
				.optional()
				.describe("true = keep the sandbox alive with no hard lifetime cap (not allowed for service credentials). false = ordinary lifetime: pass max_duration_seconds with it, otherwise the API resets the cap to the workspace default duration from now."),
			max_duration_seconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("New hard lifetime cap in seconds (sent as a Duration string, e.g. 3600s). Implies sticky=false unless sticky is given."),
		},
		async ({ session_id, name, tags, clear_tags, sticky, max_duration_seconds }) => {
			const tagPatch = tagsPatch(tags, clear_tags);
			if (name === undefined && sticky === undefined && max_duration_seconds === undefined && !Object.keys(tagPatch).length) {
				throw new Error("tenki_update_sandbox: pass at least one field to change — nothing was sent (the API would return the unchanged sandbox, which reads like a successful update).");
			}
			// The API rejects max_duration without an explicit sticky value; false is
			// the only combination in which the duration is actually applied.
			const stickyValue = sticky ?? (max_duration_seconds !== undefined ? false : undefined);
			return ok(
				await client.control("UpdateSession", {
					sessionId: session_id,
					...(name !== undefined ? { name } : {}),
					...tagPatch,
					...(stickyValue !== undefined ? { sticky: stickyValue } : {}),
					...(max_duration_seconds !== undefined ? { maxDuration: `${max_duration_seconds}s` } : {}),
				}),
			);
		},
	);

	server.tool(
		"tenki_terminate_sandboxes",
		"Terminate MULTIPLE sandboxes in one call (bulk, max 100 per call). IRREVERSIBLE — every listed sandbox and its filesystem is destroyed. The response lists `sessions` that were terminated and `failures` with a reason per id that was not. Use tenki_terminate_sandbox for a single one.",
		{
			session_ids: z.array(sessionIdSchema).min(1).max(100).describe("The sandbox/session IDs to terminate (1-100)."),
		},
		async ({ session_ids }) => ok(await client.control("TerminateSessions", { sessionIds: session_ids })),
	);

	server.tool(
		"tenki_report_sandbox_activity",
		"Report client-side activity on a sandbox to reset its idle timer and keep it from being reaped as idle (a keep-alive heartbeat).",
		{ session_id: sessionIdSchema.describe("The sandbox/session ID to mark as active.") },
		async ({ session_id }) => ok(await client.control("ReportSessionActivity", { sessionId: session_id })),
	);

	server.tool(
		"tenki_list_workspace_sandboxes",
		"List every sandbox belonging to a specific workspace (defaults to the API key's workspace), optionally filtered by state, tags, or stickiness — useful for spotting leaked, still-billing sandboxes across the workspace. NOTE: the underlying RPC (ListWorkspaceSandboxes) is deprecated upstream in favour of the credential-scoped tenki_list_sandboxes; prefer that unless you need an explicit workspace_id.",
		{
			workspace_id: z.string().optional().describe("Workspace to list (defaults to the key's first workspace)."),
			include_terminated: z.boolean().optional().describe("Include terminated sandboxes (default false)."),
			state: z
				.enum(["CREATING", "RUNNING", "PAUSING", "PAUSED", "RESUMING", "TERMINATING", "TERMINATED", "USER_SHUTDOWN"])
				.optional()
				.describe("Only sandboxes in this state."),
			tags: z.array(z.string()).optional().describe("Only sandboxes carrying all of these tags."),
			sticky: z.boolean().optional().describe("Only sticky (true) or only non-sticky (false) sandboxes."),
			page_size: z.number().int().min(1).max(100).optional(),
			page_token: z.string().optional(),
		},
		async ({ workspace_id, include_terminated, state, tags, sticky, page_size, page_token }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control("ListWorkspaceSandboxes", {
					...(workspaceId ? { workspaceId } : {}),
					...(include_terminated ? { includeTerminated: true } : {}),
					...(state ? { state: `SESSION_STATE_${state}` } : {}),
					...(tags && tags.length ? { tags } : {}),
					...(sticky !== undefined ? { sticky } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);
}
