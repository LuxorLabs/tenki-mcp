import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/**
 * Extended sandbox (session) admin ops on the control plane: wall-clock lifetime
 * extension, mutable-field updates, bulk termination, activity heartbeats, and
 * workspace/project-scoped listing. The lifecycle basics
 * (create/get/list/terminate/pause/resume) live in sandboxes.ts.
 */
export function registerSessionsAdmin(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_extend_sandbox",
		"Extend a running sandbox's wall-clock lifetime by N seconds so it isn't auto-terminated at its max-duration cap.",
		{
			session_id: z.string().describe("The sandbox/session ID to extend."),
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
		"Update mutable fields on an existing sandbox — its name, tags, idle timeout, or max duration.",
		{
			session_id: z.string().describe("The sandbox/session ID to update."),
			name: z.string().optional().describe("New human-readable name."),
			tags: z.array(z.string()).optional().describe("Replacement tag list (send [] to clear all tags)."),
			idle_timeout_minutes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Auto-pause after this many idle minutes (cost-safety cap)."),
			max_duration_seconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("New hard lifetime cap in seconds (sent as a Duration string, e.g. 3600s)."),
		},
		async ({ session_id, name, tags, idle_timeout_minutes, max_duration_seconds }) =>
			ok(
				await client.control("UpdateSession", {
					sessionId: session_id,
					...(name !== undefined ? { name } : {}),
					...(tags !== undefined ? { tags } : {}),
					...(idle_timeout_minutes !== undefined ? { idleTimeoutMinutes: idle_timeout_minutes } : {}),
					...(max_duration_seconds !== undefined ? { maxDuration: `${max_duration_seconds}s` } : {}),
				}),
			),
	);

	server.tool(
		"tenki_terminate_sandboxes",
		"Terminate MULTIPLE sandboxes in one call (bulk). IRREVERSIBLE — every listed sandbox and its filesystem is destroyed. Use tenki_terminate_sandbox for a single one.",
		{
			session_ids: z.array(z.string()).min(1).describe("The sandbox/session IDs to terminate."),
		},
		async ({ session_ids }) => ok(await client.control("TerminateSessions", { sessionIds: session_ids })),
	);

	server.tool(
		"tenki_report_sandbox_activity",
		"Report client-side activity on a sandbox to reset its idle timer and keep it from being reaped as idle (a keep-alive heartbeat).",
		{ session_id: z.string().describe("The sandbox/session ID to mark as active.") },
		async ({ session_id }) => ok(await client.control("ReportSessionActivity", { sessionId: session_id })),
	);

	server.tool(
		"tenki_list_workspace_sandboxes",
		"List every sandbox belonging to a specific workspace (defaults to the API key's workspace) — useful for spotting leaked, still-billing sandboxes across the workspace.",
		{
			workspace_id: z.string().optional().describe("Workspace to list (defaults to the key's first workspace)."),
			include_terminated: z.boolean().optional().describe("Include terminated sandboxes (default false)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ workspace_id, include_terminated, page_size, page_token }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control("ListWorkspaceSandboxes", {
					...(workspaceId ? { workspaceId } : {}),
					...(include_terminated ? { includeTerminated: true } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);

	server.tool(
		"tenki_list_project_sandboxes",
		"List every sandbox belonging to a specific project (defaults to the API key's default project).",
		{
			project_id: z.string().optional().describe("Project to list (defaults to the key's first project)."),
			include_terminated: z.boolean().optional().describe("Include terminated sandboxes (default false)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ project_id, include_terminated, page_size, page_token }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("ListProjectSandboxes", {
					...(projectId ? { projectId } : {}),
					...(include_terminated ? { includeTerminated: true } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);
}
