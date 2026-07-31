import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/** Identity / credential tools. */
export function registerIdentity(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_whoami",
		"Return the identity and workspaces for the current API key. Cheap credential test.",
		{},
		async () => ok(await client.control("WhoAmI", {})),
	);
}
