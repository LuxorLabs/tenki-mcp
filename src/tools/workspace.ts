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
		"Read a workspace's sandbox quotas and retention policy: max snapshots/templates/volumes/total bytes, max concurrent and sticky sessions, max preview URLs, and the pause/snapshot retention periods. These are workspace limits — there are no per-session defaults (idle timeout and max duration are set per sandbox at creation).",
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
		"Update a workspace's sandbox quotas and retention periods. Only the fields you pass change. Each quota has a matching clear_* flag to remove the override and fall back to the platform default; pass the value OR its clear flag, not both. There are no per-session defaults here — idle timeout and max duration are set per sandbox at creation.",
		{
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to update. Omit to use the API key's first workspace."),
			pause_retention_days: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("How long a paused sandbox's snapshot is kept before it becomes unresumable."),
			clear_pause_retention: z.boolean().optional().describe("Remove the pause-retention override (use the platform default)."),
			snapshot_retention_days: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("How long snapshots are kept before automatic cleanup."),
			clear_snapshot_retention: z
				.boolean()
				.optional()
				.describe("Remove the snapshot-retention override, i.e. keep snapshots indefinitely."),
			max_snapshots: z.number().int().positive().optional().describe("Maximum snapshots in the workspace."),
			max_templates: z.number().int().positive().optional().describe("Maximum templates in the workspace."),
			max_volumes: z.number().int().positive().optional().describe("Maximum volumes in the workspace."),
			max_total_bytes: z.number().int().positive().optional().describe("Maximum combined snapshot + volume storage in bytes."),
			max_concurrent_sessions: z.number().int().positive().optional().describe("Maximum simultaneously active sandboxes."),
			max_sticky_sessions: z.number().int().positive().optional().describe("Maximum sticky sandboxes."),
			max_preview_urls: z.number().int().positive().optional().describe("Maximum preview URLs in the workspace."),
		},
		async (a) => {
			const workspaceId = await resolveWorkspaceId(client, a.workspace_id);
			const body: Record<string, unknown> = { ...(workspaceId ? { workspaceId } : {}) };
			// Durations are protobuf Duration — JSON wants a seconds string ("2592000s").
			if (a.pause_retention_days !== undefined) body.pauseRetention = `${a.pause_retention_days * 86400}s`;
			if (a.clear_pause_retention) body.clearPauseRetention = true;
			if (a.snapshot_retention_days !== undefined) body.snapshotRetention = `${a.snapshot_retention_days * 86400}s`;
			if (a.clear_snapshot_retention) body.clearSnapshotRetention = true;
			if (a.max_snapshots !== undefined) body.maxSnapshots = a.max_snapshots;
			if (a.max_templates !== undefined) body.maxTemplates = a.max_templates;
			if (a.max_volumes !== undefined) body.maxVolumes = a.max_volumes;
			// int64 on the wire — send as a string so large values survive JSON.
			if (a.max_total_bytes !== undefined) body.maxTotalBytes = String(a.max_total_bytes);
			if (a.max_concurrent_sessions !== undefined) body.maxConcurrentSessions = a.max_concurrent_sessions;
			if (a.max_sticky_sessions !== undefined) body.maxStickySessions = a.max_sticky_sessions;
			// The per-project field is deprecated; the workspace alias is backed by the same quota.
			if (a.max_preview_urls !== undefined) body.maxPreviewUrlsPerWorkspace = a.max_preview_urls;
			if (Object.keys(body).length <= 1) {
				throw new Error(
					"tenki_update_workspace_settings: pass at least one setting to change. Nothing was sent — the API would have returned the unchanged settings, which reads like a successful update.",
				);
			}
			return ok(await client.control("UpdateWorkspaceSandboxSettings", body));
		},
	);

	server.tool(
		"tenki_get_snapshot_retention_settings",
		"Get the workspace's pause- and snapshot-retention periods. DEPRECATED upstream: this RPC is marked deprecated in the API — tenki_get_workspace_settings returns the same retention fields alongside the quotas. An empty response means no retention override, i.e. kept indefinitely.",
		{ workspace_id: z.string().optional().describe("Workspace (defaults to the key's first workspace).") },
		async ({ workspace_id }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(await client.control("GetWorkspaceSnapshotRetentionSettings", { ...(workspaceId ? { workspaceId } : {}) }));
		},
	);

	server.tool(
		"tenki_update_snapshot_retention_settings",
		"Update the workspace's snapshot-retention policy: how long snapshots are kept before automatic cleanup. Pass retention_days to set it, or clear_retention to keep snapshots indefinitely (the unset state) — exactly one of the two. DEPRECATED upstream: prefer tenki_update_workspace_settings, which sets the same retention (and pause retention) alongside the quotas.",
		{
			retention_days: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Days to retain snapshots before automatic cleanup. Omit and pass clear_retention to keep them indefinitely."),
			clear_retention: z
				.boolean()
				.optional()
				.describe("Remove the retention period so snapshots are kept indefinitely. Mutually exclusive with retention_days."),
			workspace_id: z.string().optional().describe("Workspace (defaults to the key's first workspace)."),
		},
		async ({ retention_days, clear_retention, workspace_id }) => {
			if ((retention_days === undefined) === (clear_retention !== true)) {
				throw new Error(
					"tenki_update_snapshot_retention_settings: pass exactly one of retention_days (to set a period) or clear_retention: true (to keep snapshots indefinitely).",
				);
			}
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control("UpdateWorkspaceSnapshotRetentionSettings", {
					...(workspaceId ? { workspaceId } : {}),
					// protobuf Duration on the wire, with a companion clear flag —
					// there is no `retentionDays` field (sending one is silently dropped).
					...(retention_days !== undefined ? { snapshotRetention: `${retention_days * 86400}s` } : {}),
					...(clear_retention ? { clearSnapshotRetention: true } : {}),
				}),
			);
		},
	);
}
