import type { McpServer } from "@modelcontextprotocol/server";
import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";
import { z } from "zod";

/** Identity / credential tools. */
export function registerIdentity(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_whoami",
		{
			description:
				"Return the identity and workspaces for the current API key. Cheap credential test.",
			inputSchema: z.object({}),
		},
		async () => ok(await client.control("WhoAmI", {})),
	);
}
