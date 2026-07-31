/**
 * previews.ts — port preview-URL tools for tenki-mcp.
 *
 * Covers the preview / exposure-teardown half of Tenki's Port resource:
 * removing an inbound exposure (UnexposePort) and the preview-URL lifecycle
 * (CreatePreviewUrl, OpenPreview, ListPreviewUrls). Port *exposure* itself
 * (ExposePort / ListExposedPorts) lives in ports.ts and is not re-implemented here.
 *
 * All control-plane ConnectRPC calls on tenki.sandbox.v1.SandboxService.
 *
 * LIVE-VERIFIED shapes (2026-07-20): the preview-URL methods are PROJECT-scoped —
 * the server rejects them with `project_id: value is empty` unless a projectId is
 * sent, and CreatePreviewUrl additionally requires a `slug` (>=3 chars, [a-z0-9-]).
 * projectId defaults to the API key's first project; override with project_id.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, portSchema, sessionIdSchema, slugSchema } from "./common.js";

export function registerPreviews(server: McpServer, client: TenkiClient): void {
	// ── Unexpose a port (tear down its exposure + preview) ────────────────────────
	server.tool(
		"tenki_unexpose_port",
		"Remove an inbound port exposure from a sandbox, taking its public URL/preview offline. Use this to un-publish a port previously exposed with tenki_expose_port.",
		{
			session_id: sessionIdSchema.describe("The sandbox session whose port to unexpose."),
			port: portSchema.describe("The TCP port inside the sandbox to unexpose (1-65535)."),
		},
		async ({ session_id, port }) => ok(await client.control("UnexposePort", { sessionId: session_id, port })),
	);

	// ── Create a shareable preview URL for a port ─────────────────────────────────
	server.tool(
		"tenki_create_preview_url",
		"Create a shareable public preview URL for a port in a sandbox. The sandbox must have inbound networking enabled (create it with allow_inbound). Project-scoped; defaults to the key's first project.",
		{
			session_id: sessionIdSchema.describe("The sandbox session serving the port."),
			port: portSchema.describe("The TCP port inside the sandbox to create a preview URL for (1-65535)."),
			slug: slugSchema,
			project_id: z.string().optional().describe("Project the preview URL belongs to (defaults to the key's first project)."),
			expires_at: z
				.string()
				.optional()
				.describe("Optional RFC-3339 timestamp at which the preview URL auto-expires. Omit to keep it until the sandbox ends."),
		},
		async ({ session_id, port, slug, project_id, expires_at }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("CreatePreviewUrl", {
					sessionId: session_id,
					port,
					slug,
					...(projectId ? { projectId } : {}),
					...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
				}),
			);
		},
	);

	// ── Open (get) a live preview for a port ──────────────────────────────────────
	server.tool(
		"tenki_open_preview",
		"Open (get) a live preview for a port in a sandbox and return its preview URL. The sandbox must have inbound networking enabled (allow_inbound).",
		{
			session_id: sessionIdSchema.describe("The sandbox session serving the port."),
			port: portSchema.describe("The TCP port inside the sandbox to open a preview for (1-65535)."),
			project_id: z.string().optional().describe("Project scope (defaults to the key's first project)."),
			expires_at: z
				.string()
				.optional()
				.describe("Optional RFC-3339 timestamp at which the preview auto-expires. Omit to keep it until the sandbox ends."),
		},
		async ({ session_id, port, project_id, expires_at }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("OpenPreview", {
					sessionId: session_id,
					port,
					...(projectId ? { projectId } : {}),
					...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
				}),
			);
		},
	);

	// ── List the preview URLs bound to a sandbox / project ────────────────────────
	server.tool(
		"tenki_list_preview_urls",
		"List preview URLs in a project (defaults to the key's first project), optionally filtered to one sandbox.",
		{
			session_id: sessionIdSchema.optional().describe("Optional: filter to preview URLs for this sandbox session."),
			project_id: z.string().optional().describe("Project to list (defaults to the key's first project)."),
		},
		async ({ session_id, project_id }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("ListPreviewUrls", {
					...(projectId ? { projectId } : {}),
					...(session_id ? { sessionId: session_id } : {}),
				}),
			);
		},
	);

	// ── Get / delete a specific preview URL ───────────────────────────────────────
	server.tool(
		"tenki_get_preview_url",
		"Fetch a specific preview URL's details by id (project-scoped).",
		{
			preview_url_id: z.string().describe("The preview URL id."),
			project_id: z.string().optional().describe("Project scope (defaults to the key's first project)."),
		},
		async ({ preview_url_id, project_id }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(await client.control("GetPreviewUrl", { previewUrlId: preview_url_id, ...(projectId ? { projectId } : {}) }));
		},
	);

	server.tool(
		"tenki_delete_preview_url",
		"Delete a preview URL by id, taking it permanently offline (project-scoped).",
		{
			preview_url_id: z.string().describe("The preview URL id to delete."),
			project_id: z.string().optional().describe("Project scope (defaults to the key's first project)."),
		},
		async ({ preview_url_id, project_id }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(await client.control("DeletePreviewUrl", { previewUrlId: preview_url_id, ...(projectId ? { projectId } : {}) }));
		},
	);

	// ── Touch (keep-alive) a preview ──────────────────────────────────────────────
	server.tool(
		"tenki_touch_preview",
		"Refresh (keep-alive) a live preview by its preview token so it isn't torn down as idle.",
		{ preview_token: z.string().describe("The preview token (from create_preview_url / open_preview).") },
		// TouchPreview takes a previewToken, not session/port (live-verified).
		async ({ preview_token }) => ok(await client.control("TouchPreview", { previewToken: preview_token })),
	);

	// ── Bind / unbind a named preview URL to a session+port ───────────────────────
	// Advanced routing primitives (shapes SDK-name-verified; not exercised end-to-end here).
	server.tool(
		"tenki_bind_preview_url",
		"Bind a named preview URL to a sandbox session and port (advanced routing).",
		{
			preview_url_id: z.string().describe("The preview URL id to bind."),
			session_id: sessionIdSchema,
			port: portSchema.describe("The port to route the preview URL to."),
		},
		async ({ preview_url_id, session_id, port }) =>
			ok(await client.control("BindPreviewUrl", { previewUrlId: preview_url_id, sessionId: session_id, port })),
	);

	server.tool(
		"tenki_unbind_preview_url",
		"Unbind a named preview URL from its current session/port (advanced routing).",
		{ preview_url_id: z.string().describe("The preview URL id to unbind.") },
		async ({ preview_url_id }) => ok(await client.control("UnbindPreviewUrl", { previewUrlId: preview_url_id })),
	);

	server.tool(
		"tenki_resolve_preview_token",
		"Resolve a preview token to the sandbox/port it points at (advanced).",
		{ token: z.string().describe("The preview token to resolve.") },
		async ({ token }) => ok(await client.control("ResolvePreviewToken", { token })),
	);
}
