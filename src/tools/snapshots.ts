import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema, tagsPatch, tagsSchema } from "./common.js";

/**
 * Snapshots — capture a sandbox's disk + memory as a reusable image.
 *
 * Restoring is deliberately NOT a tool here: booting a fresh sandbox from a
 * snapshot is `tenki_create_sandbox` with `snapshot_id` (CreateSession under the
 * hood). Attached volumes are NOT captured in a snapshot and must be re-attached
 * to the restored session separately.
 */
export function registerSnapshots(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_create_snapshot",
		"Capture a running sandbox's disk and memory as a reusable snapshot (attached volumes are NOT captured); boot a new sandbox from it later with tenki_create_sandbox + snapshot_id.",
		{
			session_id: sessionIdSchema.describe("The sandbox session to snapshot."),
			name: z.string().optional().describe("Human-readable name for the snapshot."),
			expires_at: z
				.string()
				.optional()
				.describe("RFC-3339 / ISO-8601 timestamp at which the snapshot is auto-deleted. Omit to keep indefinitely."),
			store_raw_image: z
				.boolean()
				.optional()
				.describe("Also store the raw disk image alongside the snapshot (needed to download it later)."),
			async: z
				.boolean()
				.optional()
				.describe("Return as soon as the snapshot row exists and poll tenki_get_snapshot for READY, instead of blocking until the capture finishes (default false)."),
		},
		async ({ session_id, name, expires_at, store_raw_image, async: isAsync }) =>
			ok(
				await client.control("CreateSnapshot", {
					sessionId: session_id,
					...(name ? { name } : {}),
					...(expires_at ? { expiresAt: expires_at } : {}),
					...(store_raw_image !== undefined ? { storeRawImage: store_raw_image } : {}),
					...(isAsync ? { async: true } : {}),
				}),
			),
	);

	server.tool(
		"tenki_get_snapshot",
		"Fetch one snapshot's status and metadata by ID.",
		{ snapshot_id: z.string() },
		async ({ snapshot_id }) => ok(await client.control("GetSnapshot", { snapshotId: snapshot_id })),
	);

	server.tool(
		"tenki_list_snapshots",
		"List the saved snapshots for the workspace (owner inferred from the API key).",
		{
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ page_size, page_token }) =>
			ok(
				await client.control("ListSnapshots", {
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.tool(
		"tenki_list_session_snapshots",
		"List the snapshots captured from a specific sandbox session.",
		{
			session_id: sessionIdSchema,
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ session_id, page_size, page_token }) =>
			ok(
				await client.control("ListSessionSnapshots", {
					sessionId: session_id,
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.tool(
		"tenki_list_dangling_snapshots",
		"List dangling snapshots — those whose source session no longer exists — for the workspace, useful for cleanup.",
		{
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ page_size, page_token }) =>
			ok(
				await client.control("ListDanglingSnapshots", {
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.tool(
		"tenki_update_snapshot",
		"Update a snapshot's mutable metadata: name, expiry (set or clear), and tags.",
		{
			snapshot_id: z.string(),
			name: z.string().max(64).optional().describe("New human-readable name (max 64 chars)."),
			expires_at: z
				.string()
				.optional()
				.describe("New RFC-3339 / ISO-8601 auto-delete timestamp."),
			clear_expires_at: z.boolean().optional().describe("Remove the expiry so the snapshot is kept indefinitely."),
			tags: tagsSchema.describe("Replacement tag list. Pass [] (or clear_tags) to remove all tags."),
			clear_tags: z.boolean().optional().describe("Remove all tags from the snapshot."),
		},
		async ({ snapshot_id, name, expires_at, clear_expires_at, tags, clear_tags }) => {
			const tagPatch = tagsPatch(tags, clear_tags);
			if (name === undefined && expires_at === undefined && !clear_expires_at && !Object.keys(tagPatch).length) {
				throw new Error("tenki_update_snapshot: pass at least one field to change — nothing was sent.");
			}
			return ok(
				await client.control("UpdateSnapshot", {
					snapshotId: snapshot_id,
					...(name !== undefined ? { name } : {}),
					...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
					...(clear_expires_at ? { clearExpiresAt: true } : {}),
					...tagPatch,
				}),
			);
		},
	);

	server.tool(
		"tenki_delete_snapshot",
		"Permanently delete a snapshot by ID.",
		{ snapshot_id: z.string() },
		async ({ snapshot_id }) => ok(await client.control("DeleteSnapshot", { snapshotId: snapshot_id })),
	);

	server.tool(
		"tenki_get_snapshot_download_url",
		"Get a short-lived, pre-signed URL to download a snapshot's raw disk image (requires the snapshot to have been created with store_raw_image).",
		{ snapshot_id: z.string() },
		async ({ snapshot_id }) => ok(await client.control("GetSnapshotDownloadURL", { snapshotId: snapshot_id })),
	);

	server.tool(
		"tenki_list_workspace_snapshots",
		"List all snapshots in a workspace (defaults to the key's first workspace). Supports pagination. NOTE: the underlying RPC (ListWorkspaceSnapshots) is deprecated upstream in favour of the credential-scoped tenki_list_snapshots; prefer that unless you need an explicit workspace_id.",
		{
			workspace_id: z.string().optional().describe("Workspace to list (defaults to the key's first workspace)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ workspace_id, page_size, page_token }) => {
			const workspaceId = workspace_id ?? (await client.resolveOwner()).workspaceId;
			return ok(
				await client.control("ListWorkspaceSnapshots", {
					...(workspaceId ? { workspaceId } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);

}