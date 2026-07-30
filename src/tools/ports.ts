import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, portSchema, sessionIdSchema, slugSchema } from "./common.js";

/** Port exposure / preview URLs. */
export function registerPorts(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_expose_port",
		"Expose a port from a sandbox and get a public preview URL. Useful when an agent starts a web server it wants to show.",
		{ session_id: sessionIdSchema, port: portSchema, slug: slugSchema.optional() },
		async ({ session_id, port, slug }) =>
			ok(await client.control("ExposePort", { sessionId: session_id, port, ...(slug ? { slug } : {}) })),
	);

	server.tool(
		"tenki_list_exposed_ports",
		"List the ports currently exposed from a sandbox.",
		{ session_id: sessionIdSchema },
		async ({ session_id }) => ok(await client.control("ListExposedPorts", { sessionId: session_id })),
	);
}
