import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, pathSchema, sessionIdSchema } from "./common.js";

/** Filesystem I/O against a sandbox's data plane. */
export function registerFiles(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_read_file",
		"Read a UTF-8 text file from a sandbox (paths under /home/tenki).",
		{ session_id: sessionIdSchema, path: pathSchema },
		async ({ session_id, path }) => ok({ path, content: await client.readTextFile(session_id, path) }),
	);

	server.tool(
		"tenki_write_file",
		"Write a UTF-8 text file to a sandbox (paths under /home/tenki).",
		{ session_id: sessionIdSchema, path: pathSchema, content: z.string() },
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
