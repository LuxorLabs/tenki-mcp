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

/**
 * Workspace-level sandbox usage + wildcard preview domains.
 *
 * The workspace quota/retention settings RPCs (Get/UpdateWorkspaceSandboxSettings,
 * Get/UpdateWorkspaceSnapshotRetentionSettings) were REMOVED from the API
 * (tenki-app #5007, 2026-08-07; they 404 on staging and production), so their
 * tools are gone. Quotas now come from the workspace plan and are read-only
 * through tenki_get_workspace_usage.
 */
export function registerWorkspace(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_get_workspace_usage",
		"Get a workspace's sandbox usage against its plan limits (concurrent sandboxes, snapshots, templates, volumes, storage bytes, preview URLs) — each row has current + max. Use this for quota and cost visibility; the limits themselves come from the plan and are not editable through the API.",
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
		"tenki_get_workspace_preview_domains",
		"Read whether wildcard preview domains are enabled for a workspace, the per-region wildcard hostnames and their certificate readiness, and how many existing preview URLs use the wildcard scheme. Explains the `wildcard`/`wildcardStatus` fields on expose/preview responses.",
		{
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to read. Omit to use the API key's first workspace."),
		},
		async ({ workspace_id }) => {
			const workspaceId = await resolveWorkspaceId(client, workspace_id);
			return ok(await client.control("GetWorkspacePreviewDomains", { ...(workspaceId ? { workspaceId } : {}) }));
		},
	);

	server.tool(
		"tenki_update_workspace_preview_domains",
		"Enable or disable wildcard preview domains for a workspace. Enabling provisions one wildcard certificate per region and is limited to Pro-tier workspaces. DISABLING releases the certificates and existing wildcard-scheme preview URLs stop serving with a valid certificate — check wildcardPreviewUrlCount via tenki_get_workspace_preview_domains first.",
		{
			enabled: z.boolean().describe("true to enable wildcard preview domains, false to disable them."),
			workspace_id: z
				.string()
				.optional()
				.describe("Workspace to update. Omit to use the API key's first workspace."),
		},
		async ({ enabled, workspace_id }) => {
			const workspaceId = await resolveWorkspaceId(client, workspace_id);
			return ok(
				await client.control("UpdateWorkspacePreviewDomains", {
					...(workspaceId ? { workspaceId } : {}),
					enabled,
				}),
			);
		},
	);
}
