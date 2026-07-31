/**
 * Volume tools — workspace-scoped persistent block storage for Tenki sandboxes.
 *
 * Volumes are durable disks that outlive any single sandbox: create one in a
 * workspace, then attach it into a running session at a mount path. All calls
 * here are control-plane (tenki.sandbox.v1.SandboxService). Method names and
 * request field shapes are ported from the live-verified n8n community node
 * (github.com/opencolin/n8n-nodes-tenki) and its endpoint research:
 *   CreateVolume · GetVolume · ListVolumes · UpdateVolume · DeleteVolume ·
 *   ResizeVolume · AttachVolume · DetachVolume
 *
 * CreateVolumeRequest is flat: { workspaceId, name, sizeBytes (int64), projectId? }.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/** Volume size bounds the control plane accepts: 1 MiB … 100 GiB, in bytes. */
const MIN_VOLUME_BYTES = 1_048_576; // 1 MiB
const MAX_VOLUME_BYTES = 107_374_182_400; // 100 GiB

/** Shared size-in-bytes schema for create + resize, range-checked before the call. */
const sizeBytesSchema = z
	.number()
	.int()
	.min(MIN_VOLUME_BYTES)
	.max(MAX_VOLUME_BYTES)
	.describe("Volume size in bytes. Must be between 1 MiB (1048576) and 100 GiB (107374182400).");

export function registerVolumes(server: McpServer, client: TenkiClient): void {
	// ── Create ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_create_volume",
		"Create a workspace-scoped persistent volume — durable block storage that survives sandbox teardown. Defaults the workspace and project to the API key's first; override with workspace_id/project_id.",
		{
			name: z.string().describe("Human-readable name for the volume."),
			size_bytes: sizeBytesSchema,
			workspace_id: z.string().optional().describe("Workspace to create the volume in (defaults to the key's first workspace)."),
			project_id: z.string().optional().describe("Project to associate the volume with (defaults to the key's first project)."),
		},
		async ({ name, size_bytes, workspace_id, project_id }) => {
			const owner = await client.resolveOwner();
			const workspaceId = workspace_id ?? owner.workspaceId;
			const projectId = project_id ?? owner.projectId;
			return ok(
				await client.control("CreateVolume", {
					...(workspaceId ? { workspaceId } : {}),
					name,
					sizeBytes: size_bytes,
					...(projectId ? { projectId } : {}),
				}),
			);
		},
	);

	// ── Get ───────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_get_volume",
		"Fetch a single volume's metadata and current state by its id.",
		{ volume_id: z.string().describe("The volume id, e.g. vol_….") },
		async ({ volume_id }) => ok(await client.control("GetVolume", { volumeId: volume_id })),
	);

	// ── List ──────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_list_volumes",
		"List persistent volumes in a workspace (defaults to the key's first workspace). Supports pagination.",
		{
			workspace_id: z.string().optional().describe("Workspace to list volumes from (defaults to the key's first workspace)."),
			page_size: z.number().int().positive().optional().describe("Max volumes to return per page."),
			page_token: z.string().optional().describe("Page token from a previous response's nextPageToken."),
		},
		async ({ workspace_id, page_size, page_token }) => {
			const owner = await client.resolveOwner();
			const workspaceId = workspace_id ?? owner.workspaceId;
			return ok(
				await client.control("ListVolumes", {
					...(workspaceId ? { workspaceId } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);

	// ── Update ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_update_volume",
		"Rename a volume (update its human-readable name). To change a volume's size use tenki_resize_volume instead.",
		{
			volume_id: z.string().describe("The volume id to update."),
			name: z.string().describe("New human-readable name for the volume."),
		},
		async ({ volume_id, name }) => ok(await client.control("UpdateVolume", { volumeId: volume_id, name })),
	);

	// ── Delete ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_delete_volume",
		"Permanently delete a volume and destroy its data. Fails with VolumeInUse if the volume is still attached to a session — detach it first.",
		{ volume_id: z.string().describe("The volume id to delete.") },
		async ({ volume_id }) => ok(await client.control("DeleteVolume", { volumeId: volume_id })),
	);

	// ── Resize ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_resize_volume",
		"Grow a volume to a new size in bytes (1 MiB … 100 GiB). Volumes can grow but not shrink.",
		{
			volume_id: z.string().describe("The volume id to resize."),
			size_bytes: sizeBytesSchema,
		},
		async ({ volume_id, size_bytes }) =>
			ok(await client.control("ResizeVolume", { volumeId: volume_id, newSizeBytes: size_bytes })),
	);

	// ── Attach ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_attach_volume",
		"Mount a volume into a running sandbox at an absolute path. Set read_only to mount without write access.",
		{
			session_id: z.string().describe("The sandbox session to attach the volume to."),
			volume_id: z.string().describe("The volume id to attach."),
			mount_path: z.string().describe("Absolute path inside the sandbox to mount at, e.g. /mnt/data."),
			read_only: z.boolean().optional().describe("Mount the volume read-only (default false = read-write)."),
		},
		async ({ session_id, volume_id, mount_path, read_only }) =>
			ok(
				// AttachVolumeRequest nests the target under a `volume` sub-message
				// (live-verified: a flat volumeId is rejected "volume: value is required").
				await client.control("AttachVolume", {
					sessionId: session_id,
					volume: {
						volumeId: volume_id,
						mountPath: mount_path,
						...(read_only !== undefined ? { readOnly: read_only } : {}),
					},
				}),
			),
	);

	// ── Detach ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_detach_volume",
		"Unmount a volume from a sandbox session.",
		{
			session_id: z.string().describe("The sandbox session to detach the volume from."),
			volume_id: z.string().describe("The volume id to detach."),
		},
		async ({ session_id, volume_id }) =>
			ok(await client.control("DetachVolume", { sessionId: session_id, volumeId: volume_id })),
	);

	// ── List (project-scoped) ─────────────────────────────────────────────────────
	server.tool(
		"tenki_list_project_volumes",
		"List persistent volumes in a project (defaults to the key's first project). Supports pagination.",
		{
			project_id: z.string().optional().describe("Project to list volumes from (defaults to the key's first project)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ project_id, page_size, page_token }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("ListProjectVolumes", {
					...(projectId ? { projectId } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);
}