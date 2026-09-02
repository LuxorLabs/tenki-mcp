import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema } from "./common.js";

/**
 * Snapshots — capture a sandbox's disk + memory as a reusable image.
 *
 * Restoring is deliberately NOT a tool here: booting a fresh sandbox from a
 * snapshot is `tenki_create_sandbox` with `snapshot_id` (CreateSession under the
 * hood). Attached volumes are NOT captured in a snapshot and must be re-attached
 * to the restored session separately.
 */
export function registerSnapshots(
	server: McpServer,
	client: TenkiClient,
): void {
	server.registerTool(
		"tenki_create_snapshot",
		{
			description:
				"Capture a running sandbox's disk and memory as a reusable snapshot (attached volumes are NOT captured); boot a new sandbox from it later with tenki_create_sandbox + snapshot_id.",
			inputSchema: z.object({
				session_id: sessionIdSchema.describe(
					"The sandbox session to snapshot.",
				),
				name: z
					.string()
					.optional()
					.describe("Human-readable name for the snapshot."),
				expires_at: z
					.string()
					.optional()
					.describe(
						"RFC-3339 / ISO-8601 timestamp at which the snapshot is auto-deleted. Omit to keep indefinitely.",
					),
				store_raw_image: z
					.boolean()
					.optional()
					.describe(
						"Also store the raw disk image alongside the snapshot (needed to download it later).",
					),
			}),
		},
		async ({ session_id, name, expires_at, store_raw_image }) =>
			ok(
				await client.control("CreateSnapshot", {
					sessionId: session_id,
					...(name ? { name } : {}),
					...(expires_at ? { expiresAt: expires_at } : {}),
					...(store_raw_image !== undefined
						? { storeRawImage: store_raw_image }
						: {}),
				}),
			),
	);

	server.registerTool(
		"tenki_get_snapshot",
		{
			description: "Fetch one snapshot's status and metadata by ID.",
			inputSchema: z.object({ snapshot_id: z.string() }),
		},
		async ({ snapshot_id }) =>
			ok(await client.control("GetSnapshot", { snapshotId: snapshot_id })),
	);

	server.registerTool(
		"tenki_list_snapshots",
		{
			description:
				"List the saved snapshots for the workspace (owner inferred from the API key).",
			inputSchema: z.object({
				page_size: z.number().int().positive().optional(),
				page_token: z.string().optional(),
			}),
		},
		async ({ page_size, page_token }) =>
			ok(
				await client.control("ListSnapshots", {
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.registerTool(
		"tenki_list_session_snapshots",
		{
			description:
				"List the snapshots captured from a specific sandbox session.",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				page_size: z.number().int().positive().optional(),
				page_token: z.string().optional(),
			}),
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

	server.registerTool(
		"tenki_list_dangling_snapshots",
		{
			description:
				"List dangling snapshots — those whose source session no longer exists — for the workspace, useful for cleanup.",
			inputSchema: z.object({
				page_size: z.number().int().positive().optional(),
				page_token: z.string().optional(),
			}),
		},
		async ({ page_size, page_token }) =>
			ok(
				await client.control("ListDanglingSnapshots", {
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.registerTool(
		"tenki_update_snapshot",
		{
			description: "Update a snapshot's mutable metadata (name and/or expiry).",
			inputSchema: z.object({
				snapshot_id: z.string(),
				name: z.string().optional().describe("New human-readable name."),
				expires_at: z
					.string()
					.optional()
					.describe("New RFC-3339 / ISO-8601 auto-delete timestamp."),
			}),
		},
		async ({ snapshot_id, name, expires_at }) =>
			ok(
				await client.control("UpdateSnapshot", {
					snapshotId: snapshot_id,
					...(name !== undefined ? { name } : {}),
					...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
				}),
			),
	);

	server.registerTool(
		"tenki_delete_snapshot",
		{
			description: "Permanently delete a snapshot by ID.",
			inputSchema: z.object({ snapshot_id: z.string() }),
		},
		async ({ snapshot_id }) =>
			ok(await client.control("DeleteSnapshot", { snapshotId: snapshot_id })),
	);

	server.registerTool(
		"tenki_get_snapshot_download_url",
		{
			description:
				"Get a short-lived, pre-signed URL to download a snapshot's raw disk image (requires the snapshot to have been created with store_raw_image).",
			inputSchema: z.object({ snapshot_id: z.string() }),
		},
		async ({ snapshot_id }) =>
			ok(
				await client.control("GetSnapshotDownloadURL", {
					snapshotId: snapshot_id,
				}),
			),
	);

	server.registerTool(
		"tenki_list_workspace_snapshots",
		{
			description:
				"List all snapshots in a workspace (defaults to the key's first workspace). Supports pagination.",
			inputSchema: z.object({
				workspace_id: z
					.string()
					.optional()
					.describe(
						"Workspace to list (defaults to the key's first workspace).",
					),
				page_size: z.number().int().positive().optional(),
				page_token: z.string().optional(),
			}),
		},
		async ({ workspace_id, page_size, page_token }) => {
			const workspaceId =
				workspace_id ?? (await client.resolveOwner()).workspaceId;
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
