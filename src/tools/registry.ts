/**
 * tenki-mcp — Registry tools (custom sandbox images).
 *
 * The registry lets a workspace publish a sandbox snapshot/template as a reusable
 * custom image (`<workspace>/<artifact>[:tag]`), resolve refs, control visibility,
 * and share images across workspaces.
 *
 * Request shapes are LIVE-VERIFIED against api.tenki.cloud (2026-07-21). The API
 * is inconsistent about field names, so note the specifics:
 *   - most methods take `ref` (a bare `<ws>/<artifact>`; grants/unshare need it TAGLESS);
 *   - ShareImage uses `imageRef` + `targetWorkspaceId` (NOT `ref`);
 *   - version delete + grant revoke take UUIDs (`imageId`/`snapshotId`/`grantId`);
 *   - visibility + publish-kind are string ENUMS (`REGISTRY_VISIBILITY_*`, `REGISTRY_IMAGE_KIND_*`).
 * (The n8n reference this was first ported from marked all of these UNVERIFIED.)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

const VISIBILITY = { public: "REGISTRY_VISIBILITY_PUBLIC", private: "REGISTRY_VISIBILITY_PRIVATE" } as const;
const IMAGE_KIND = { snapshot: "REGISTRY_IMAGE_KIND_SNAPSHOT", template: "REGISTRY_IMAGE_KIND_TEMPLATE" } as const;

export function registerRegistry(server: McpServer, client: TenkiClient): void {
	// ── Publish ─────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_publish_image",
		"Publish a custom sandbox image into the workspace registry from a snapshot or a template.",
		{
			reference: z.string().describe("Target image reference <workspace>/<artifact>[:tag], e.g. myws/myimage:latest."),
			kind: z.enum(["snapshot", "template"]).describe("Source kind for the image contents."),
			snapshot_id: z.string().optional().describe("Snapshot id to publish (required when kind=snapshot)."),
			source_template_id: z.string().optional().describe("Template id to publish (required when kind=template)."),
			visibility: z.enum(["public", "private"]).optional().describe("public (resolvable by anyone) or private (default)."),
		},
		async ({ reference, kind, snapshot_id, source_template_id, visibility }) =>
			ok(
				await client.control("PublishRegistryImage", {
					ref: reference,
					kind: IMAGE_KIND[kind],
					...(snapshot_id !== undefined ? { snapshotId: snapshot_id } : {}),
					...(source_template_id !== undefined ? { sourceTemplateId: source_template_id } : {}),
					...(visibility !== undefined ? { visibility: VISIBILITY[visibility] } : {}),
				}),
			),
	);

	// ── Get ─────────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_get_image",
		"Retrieve one custom sandbox image from the registry by its reference.",
		{ reference: z.string().describe("Image reference <workspace>/<artifact>[:tag].") },
		async ({ reference }) => ok(await client.control("GetRegistryImage", { ref: reference })),
	);

	// ── List ────────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_list_images",
		"List custom sandbox images in the registry, optionally filtered to a single workspace.",
		{
			workspace_id: z.string().optional().describe("Optional workspace to filter the listed images by."),
			page_size: z.number().int().positive().optional().describe("Max images to return per page."),
			page_token: z.string().optional().describe("Pagination token from a previous response's nextPageToken."),
		},
		async ({ workspace_id, page_size, page_token }) =>
			ok(
				await client.control("ListRegistryImages", {
					...(workspace_id !== undefined ? { workspaceId: workspace_id } : {}),
					...(page_size !== undefined ? { pageSize: page_size } : {}),
					...(page_token !== undefined ? { pageToken: page_token } : {}),
				}),
			),
	);

	// ── Set visibility ────────────────────────────────────────────────────────────
	server.tool(
		"tenki_set_image_visibility",
		"Make a custom sandbox image public (publicly resolvable) or private (restricted to the workspace).",
		{
			reference: z.string().describe("Image reference <workspace>/<artifact>[:tag]."),
			visibility: z.enum(["public", "private"]).describe("Target visibility for the image."),
		},
		async ({ reference, visibility }) =>
			ok(await client.control("SetRegistryImageVisibility", { ref: reference, visibility: VISIBILITY[visibility] })),
	);

	// ── Delete (whole image by ref, or one version by ids) ─────────────────────────
	server.tool(
		"tenki_delete_image",
		"Delete a custom sandbox image (by reference), or delete a single version (by image_id + snapshot_id).",
		{
			reference: z.string().optional().describe("Image reference to delete the whole image."),
			image_id: z.string().optional().describe("Image UUID (with snapshot_id) to delete a single version."),
			snapshot_id: z.string().optional().describe("Snapshot UUID (with image_id) to delete a single version."),
		},
		async ({ reference, image_id, snapshot_id }) => {
			if (image_id !== undefined && snapshot_id !== undefined) {
				return ok(await client.control("DeleteRegistryImageVersion", { imageId: image_id, snapshotId: snapshot_id }));
			}
			if (reference !== undefined) return ok(await client.control("DeleteRegistryImage", { ref: reference }));
			throw new Error("Provide `reference` to delete an image, or `image_id`+`snapshot_id` to delete one version.");
		},
	);

	// ── Resolve ref ────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_resolve_image_ref",
		"Resolve a registry reference (tag or ref) to its concrete pinned digest/ref.",
		{ registry_ref: z.string().describe("The registry reference to resolve, e.g. myws/myimage:latest.") },
		async ({ registry_ref }) => {
			const owner = await client.resolveOwner();
			return ok(
				await client.control("ResolveRegistryRef", {
					ref: registry_ref,
					...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
				}),
			);
		},
	);

	// ── Share ──────────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_share_image",
		"Grant another workspace access to a custom sandbox image.",
		{
			reference: z.string().describe("Image reference <workspace>/<artifact>[:tag]."),
			grantee_workspace_id: z.string().describe("The workspace to grant access to."),
		},
		// ShareImage uses imageRef + targetWorkspaceId (not ref/granteeWorkspaceId).
		async ({ reference, grantee_workspace_id }) =>
			ok(await client.control("ShareImage", { imageRef: reference, targetWorkspaceId: grantee_workspace_id })),
	);

	// ── Unshare (revoke a share) ────────────────────────────────────────────────────
	server.tool(
		"tenki_unshare_image",
		"Revoke a previously-granted share on a custom sandbox image, by grant id or grantee workspace.",
		{
			reference: z.string().describe("Image reference (use the TAGLESS <workspace>/<artifact> form)."),
			grant_id: z.string().optional().describe("Specific share grant to revoke (preferred; provide this or grantee_workspace_id)."),
			grantee_workspace_id: z.string().optional().describe("Workspace whose access to revoke."),
		},
		async ({ reference, grant_id, grantee_workspace_id }) =>
			ok(
				await client.control("UnshareRegistryImage", {
					ref: reference,
					...(grant_id !== undefined ? { grantId: grant_id } : {}),
					...(grantee_workspace_id !== undefined ? { targetWorkspaceId: grantee_workspace_id } : {}),
				}),
			),
	);

	// ── List share grants ───────────────────────────────────────────────────────────
	server.tool(
		"tenki_list_image_share_grants",
		"List the share grants (workspaces granted access) on a custom sandbox image.",
		{
			reference: z.string().describe("Image reference to list grants for (use the TAGLESS <workspace>/<artifact> form)."),
			page_size: z.number().int().positive().optional().describe("Max grants to return per page."),
			page_token: z.string().optional().describe("Pagination token from a previous response's nextPageToken."),
		},
		async ({ reference, page_size, page_token }) =>
			ok(
				await client.control("ListRegistryShareGrants", {
					ref: reference,
					...(page_size !== undefined ? { pageSize: page_size } : {}),
					...(page_token !== undefined ? { pageToken: page_token } : {}),
				}),
			),
	);

	// ── Revoke a specific share grant (by grant id) ─────────────────────────────────
	server.tool(
		"tenki_revoke_image_share_grant",
		"Revoke a specific registry-image share grant by its grant id.",
		{ grant_id: z.string().describe("The share grant id (UUID) to revoke.") },
		async ({ grant_id }) => ok(await client.control("RevokeRegistryShareGrant", { grantId: grant_id })),
	);
}
