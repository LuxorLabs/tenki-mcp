import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/** Git operations inside a sandbox (one RPC dispatched by operation string). */
export function registerGit(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_git",
		"Run a git operation in a sandbox (clone, checkout, diff, log, status, add, commit, pull, push, fetchPR). Args are passed as a key→value map.",
		{
			session_id: z.string(),
			operation: z.string().describe("e.g. 'clone', 'checkout', 'commit', 'push', 'fetchPR'."),
			args: z.record(z.string()).optional().describe("Operation args as a key→value object."),
		},
		async ({ session_id, operation, args }) =>
			ok(await client.control("GitOperation", { sessionId: session_id, operation, ...(args ? { args } : {}) })),
	);
}
