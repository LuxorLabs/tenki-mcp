import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, portSchema, sessionIdSchema, slugSchema } from "./common.js";

/**
 * Port exposure. ExposePort / ListExposedPorts (and UnexposePort in previews.ts)
 * are marked deprecated upstream (tenki-app #5663, 2026-09-15) in favour of the
 * preview-URL RPCs; they still work — ExposePort now creates a preview URL and
 * auto-mints a slug when none is given, which CreatePreviewUrl cannot do (slug
 * is required there). Kept as the convenience path; descriptions steer callers
 * who already have a slug to tenki_create_preview_url.
 */
export function registerPorts(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_expose_port",
		"Expose a port from a sandbox and get a public preview URL (a slug is auto-generated unless you pass one). Useful when an agent starts a web server it wants to show. Requires allow_inbound. The API marks ExposePort deprecated in favour of CreatePreviewUrl — if you already have a slug, prefer tenki_create_preview_url; to take the URL down use tenki_unbind_preview_url / tenki_delete_preview_url with the returned previewUrlId.",
		{
			session_id: sessionIdSchema,
			port: portSchema,
			slug: slugSchema.optional(),
			expires_at: z
				.string()
				.optional()
				.describe("Optional RFC-3339 timestamp at which the preview URL auto-expires. Omit to keep it until the sandbox ends."),
		},
		async ({ session_id, port, slug, expires_at }) =>
			ok(
				await client.control("ExposePort", {
					sessionId: session_id,
					port,
					...(slug ? { slug } : {}),
					...(expires_at !== undefined ? { expiresAt: expires_at } : {}),
				}),
			),
	);

	server.tool(
		"tenki_list_exposed_ports",
		"List the ports currently exposed from a sandbox. DEPRECATED upstream (ListExposedPorts): prefer tenki_list_preview_urls with session_id, which lists the same bindings with their ids, slugs and expiry.",
		{ session_id: sessionIdSchema },
		async ({ session_id }) => ok(await client.control("ListExposedPorts", { sessionId: session_id })),
	);
}
