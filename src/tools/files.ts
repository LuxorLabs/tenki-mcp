import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, pathSchema, sessionIdSchema, utf8CharEnd, utf8CharStart } from "./common.js";

// Inline read budget, matching tenki_exec's per-stream default. The data
// plane's ReadFile has no range support, so the whole file still crosses the
// wire to this process; the cap bounds what is returned to the model.
const DEFAULT_READ_BYTES = 65_536;
const MAX_READ_BYTES = 1_048_576;

/** Filesystem I/O against a sandbox's data plane. */
export function registerFiles(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_read_file",
		"Read a UTF-8 text file from a sandbox (paths under /home/tenki). Returns at most max_bytes (default 65536) starting at offset, plus the file's totalBytes; when more remains the response has truncated: true and nextOffset — pass it as offset to read the next part.",
		{
			session_id: sessionIdSchema,
			path: pathSchema,
			offset: z.number().int().min(0).optional().describe("Byte offset to start reading at (default 0). Use nextOffset from a truncated response."),
			max_bytes: z
				.number()
				.int()
				.min(1024)
				.max(MAX_READ_BYTES)
				.optional()
				.describe(`Maximum bytes of content to return (default ${DEFAULT_READ_BYTES}, max ${MAX_READ_BYTES}). Cuts never split a UTF-8 character.`),
		},
		async ({ session_id, path, offset, max_bytes }) => {
			const buf = await client.readFileBytes(session_id, path);
			const totalBytes = buf.length;
			const requested = offset ?? 0;
			if (requested > totalBytes) {
				throw new Error(`offset ${requested} is past the end of ${path} (${totalBytes} bytes).`);
			}
			const start = utf8CharStart(buf, requested);
			const end = utf8CharEnd(buf, start, start + (max_bytes ?? DEFAULT_READ_BYTES));
			const truncated = end < totalBytes;
			return ok({
				path,
				content: buf.subarray(start, end).toString("utf8"),
				totalBytes,
				...(start > 0 || truncated ? { offset: start, bytesReturned: end - start } : {}),
				...(truncated ? { truncated: true, nextOffset: end } : {}),
			});
		},
	);

	server.tool(
		"tenki_write_file",
		"Write a UTF-8 text file to a sandbox (paths under /home/tenki), creating it or replacing its entire contents.",
		{ session_id: sessionIdSchema, path: pathSchema, content: z.string().describe("Full text to write; an existing file is overwritten.") },
		async ({ session_id, path, content }) => ok(await client.writeTextFile(session_id, path, content)),
	);

	server.tool(
		"tenki_list_files",
		"List a directory in a sandbox, including dotfiles (.git, .env, .gitignore) by default — set include_hidden false to omit them.",
		{
			session_id: sessionIdSchema,
			path: pathSchema.describe("Directory path, e.g. /home/tenki"),
			include_hidden: z
				.boolean()
				.optional()
				.describe("Include dot-prefixed entries (default true). The data plane omits them unless asked, which hides .git/.env from a listing."),
		},
		async ({ session_id, path, include_hidden }) => {
			// Default TRUE, inverting the wire default: a listing that silently omits
			// .git/.env/.gitignore leads an agent to conclude they do not exist.
			const resp = await client.data(session_id, "List", { path, includeHidden: include_hidden !== false });
			// proto3 omits an empty repeated field, so an empty directory comes back
			// as {} — indistinguishable from a malformed call. Normalize it.
			return ok({ path, entries: Array.isArray(resp.entries) ? resp.entries : [] });
		},
	);
}
