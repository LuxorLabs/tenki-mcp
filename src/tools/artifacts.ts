/**
 * artifacts.ts — signed-URL binary transfer for tenki-mcp.
 *
 * The text file tools (read_file/write_file) round-trip UTF-8 over the data plane.
 * For binary payloads (datasets, wheels, images, build outputs) Tenki issues short-
 * lived signed URLs: GetArtifactUploadUrl to PUT a file into the sandbox, and
 * GetArtifactDownloadUrl to GET one out. These tools return the signed URL; the
 * caller performs the actual HTTP PUT/GET.
 *
 * GetArtifactUploadUrlRequest { sessionId, path, contentType } is verified from the
 * published Tenki API surface. GetArtifactDownloadUrl takes an artifactId only — the API
 * rejects a path (command stdout/stderr are surfaced as artifact ids).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema } from "./common.js";

export function registerArtifacts(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_get_upload_url",
		"Get a short-lived signed URL to upload (HTTP PUT) a binary file to a path inside a sandbox. Use for non-text payloads too large or binary for tenki_write_file.",
		{
			session_id: sessionIdSchema,
			path: z.string().describe("Destination path in the sandbox, e.g. /home/tenki/data.bin"),
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
		"Get a short-lived signed URL to download (HTTP GET) a command artifact from a sandbox by its artifact id (e.g. a command's stdout/stderr artifact). Note: the API supports download-by-artifact-id only, not download-by-path.",
		{
			session_id: sessionIdSchema,
			artifact_id: z.string().describe("Artifact id to download (e.g. a command's stdout/stderr artifact)."),
		},
		// GetArtifactDownloadUrl only accepts an artifact UUID; a `path` is rejected (live-verified).
		async ({ session_id, artifact_id }) =>
			ok(await client.control("GetArtifactDownloadUrl", { sessionId: session_id, artifactId: artifact_id })),
	);
}
