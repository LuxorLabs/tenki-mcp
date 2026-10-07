/**
 * artifacts.ts — signed-URL binary transfer for tenki-mcp.
 *
 * The text file tools (read_file/write_file) round-trip UTF-8 over the data plane.
 * For binary payloads (datasets, wheels, images, build outputs) Tenki issues short-
 * lived signed URLs: GetArtifactUploadUrl to PUT a file into the sandbox, and
 * GetArtifactDownloadUrl to GET one out. These tools return the signed URL; the
 * caller performs the actual HTTP PUT/GET.
 *
 * GetArtifactUploadUrlRequest is { session_id, path, content_type }.
 * GetArtifactDownloadUrlRequest is { artifact_id } ONLY — there is no session_id
 * field (the API discards unknown fields silently), so the tool no longer requires one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, pathSchema, sessionIdSchema } from "./common.js";

export function registerArtifacts(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_get_upload_url",
		"Get a short-lived signed URL to upload (HTTP PUT) a binary file to a path inside a sandbox. Use for non-text payloads too large or binary for tenki_write_file.",
		{
			session_id: sessionIdSchema,
			path: pathSchema.describe("Destination path in the sandbox, e.g. /home/tenki/data.bin"),
			content_type: z.string().optional().describe("MIME type of the upload, e.g. application/octet-stream."),
		},
		async ({ session_id, path, content_type }) =>
			ok(
				await client.control("GetArtifactUploadUrl", {
					sessionId: session_id,
					path,
					...(content_type ? { contentType: content_type } : {}),
				}),
			),
	);

	server.tool(
		"tenki_get_download_url",
		"Get a short-lived signed URL to download (HTTP GET) an artifact by its artifact id (e.g. the artifactId returned by tenki_get_upload_url, or a template build's buildLogArtifactId). The API supports download-by-artifact-id only, not download-by-path.",
		{
			artifact_id: z.string().describe("Artifact id (UUID) to download."),
			session_id: sessionIdSchema
				.optional()
				.describe("Ignored — kept for backwards compatibility; the API addresses artifacts by id alone."),
		},
		async ({ artifact_id }) => ok(await client.control("GetArtifactDownloadUrl", { artifactId: artifact_id })),
	);
}
