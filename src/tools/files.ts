import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/** Filesystem I/O against a sandbox's data plane. */
export function registerFiles(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_read_file",
		"Read a UTF-8 text file from a sandbox (paths under /home/tenki).",
		{ session_id: z.string(), path: z.string() },
		async ({ session_id, path }) => ok({ path, content: await client.readTextFile(session_id, path) }),
	);

	server.tool(
		"tenki_write_file",
		"Write a UTF-8 text file to a sandbox (paths under /home/tenki).",
		{ session_id: z.string(), path: z.string(), content: z.string() },
		async ({ session_id, path, content }) => ok(await client.writeTextFile(session_id, path, content)),
	);

	server.tool(
		"tenki_list_files",
		"List a directory in a sandbox.",
		{ session_id: z.string(), path: z.string().describe("Directory path, e.g. /home/tenki") },
		async ({ session_id, path }) => ok(await client.data(session_id, "List", { path })),
	);
}
