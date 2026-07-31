import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/**
 * Resolve which workspace an op targets: honour an explicit id, else fall back
 * to the API key's first workspace (via WhoAmI, inside resolveOwner). Mirrors
 * the live-verified n8n node's `resolveWorkspaceId` helper.
 */
async function resolveWorkspaceId(client: TenkiClient, provided?: string): Promise<string | undefined> {
	if (provided && provided.trim()) return provided.trim();
	const owner = await client.resolveOwner();
	return owner.workspaceId;
}

/** Workspace-level sandbox usage + default settings (incl. snapshot retention). */
export function registerWorkspace(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_get_workspace_usage",
		"Get per-second sandbox billing and usage figures for a workspace — use this for cost visibility across all of the workspace's sandboxes.",
		{
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to report on. Omit to use the API key's first workspace."),
		},
		async ({ workspace_id }) => {
			const workspaceId = await resolveWorkspaceId(client, workspace_id);
			return ok(
				await client.control("GetWorkspaceSandboxUsage", {
					...(workspaceId ? { workspaceId } : {}),
				}),
			);
		},
	);

	server.tool(
		"tenki_get_workspace_settings",
		"Read a workspace's default sandbox settings — the defaults (e.g. idle timeout, max duration, snapshot-retention policy) applied to every newly created sandbox session in the workspace.",
		{
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to read. Omit to use the API key's first workspace."),
		},
		async ({ workspace_id }) => {
			const workspaceId = await resolveWorkspaceId(client, workspace_id);
			return ok(
				await client.control("GetWorkspaceSandboxSettings", {
					...(workspaceId ? { workspaceId } : {}),
				}),
			);
		},
	);

	server.tool(
		"tenki_update_workspace_settings",
		"Update a workspace's default sandbox settings — the defaults (idle timeout, max lifetime, snapshot retention) applied to newly created sandbox sessions. Only the fields you pass are changed.",
		{
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to update. Omit to use the API key's first workspace."),
			default_idle_timeout_minutes: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Default idle timeout in minutes for new sandboxes; 0 disables idle reaping."),
			default_max_duration_seconds: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Default hard lifetime cap in seconds for new sandboxes; 0 means no cap."),
			snapshot_retention_days: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Default snapshot-retention period in days for the workspace; 0 keeps snapshots indefinitely."),
		},
		async ({ workspace_id, default_idle_timeout_minutes, default_max_duration_seconds, snapshot_retention_days }) => {
			const workspaceId = await resolveWorkspaceId(client, workspace_id);
			return ok(
				await client.control("UpdateWorkspaceSandboxSettings", {
					...(workspaceId ? { workspaceId } : {}),
					...(default_idle_timeout_minutes !== undefined
						? { defaultIdleTimeoutMinutes: default_idle_timeout_minutes }
						: {}),
					...(default_max_duration_seconds !== undefined
						? { defaultMaxDurationSeconds: default_max_duration_seconds }
						: {}),
					...(snapshot_retention_days !== undefined
						? { snapshotRetentionDays: snapshot_retention_days }
						: {}),
				}),
			);
		},
	);

	server.tool(
		"tenki_get_snapshot_retention_settings",
		"Get the workspace's snapshot-retention policy (how long snapshots are kept before automatic cleanup).",
		{ workspace_id: z.string().optional().describe("Workspace (defaults to the key's first workspace).") },
		async ({ workspace_id }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(await client.control("GetWorkspaceSnapshotRetentionSettings", { ...(workspaceId ? { workspaceId } : {}) }));
		},
	);

	server.tool(
		"tenki_update_snapshot_retention_settings",
		"Update the workspace's snapshot-retention policy (days to keep snapshots before automatic cleanup).",
		{
			retention_days: z.number().int().positive().describe("Days to retain snapshots before automatic cleanup."),
			workspace_id: z.string().optional().describe("Workspace (defaults to the key's first workspace)."),
		},
		async ({ retention_days, workspace_id }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control("UpdateWorkspaceSnapshotRetentionSettings", {
					...(workspaceId ? { workspaceId } : {}),
					retentionDays: retention_days,
				}),
			);
		},
	);
}
