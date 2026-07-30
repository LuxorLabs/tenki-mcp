import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, sessionIdSchema } from "./common.js";

/**
 * The API validates `operation` against exactly this list (GitOperationRequest's
 * buf.validate `in` constraint) and the engine implements exactly these four —
 * anything else (status/add/commit/push/...) is rejected server-side. For other
 * git commands, run `git ...` via tenki_exec.
 */
const GIT_OPERATIONS = ["clone", "checkout", "diff", "log"] as const;

/** Git operations inside a sandbox (one RPC dispatched by operation string). */
export function registerGit(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_git",
		"Run a git operation in a sandbox. Only clone, checkout, diff, and log are supported by the API — for any other git command (status, add, commit, push, ...) use tenki_exec with `git ...`. Arg keys per operation: " +
			"clone: repo (required, the URL), branch?, depth?, directory? — " +
			"checkout: ref (required; branch/tag/commit), create? ('true' creates the branch, i.e. -b) — " +
			"diff: range? (e.g. 'main..HEAD') or base?+head?, path? — " +
			"log: max_count?, range?, path?.",
		{
			session_id: sessionIdSchema,
			operation: z.enum(GIT_OPERATIONS).describe("One of: clone, checkout, diff, log (the API rejects anything else)."),
			args: z
				.record(z.string())
				.optional()
				.describe(
					"Operation args as a key→value object (all values strings). clone: {repo, branch?, depth?, directory?}; checkout: {ref, create?: 'true'}; diff: {range?} or {base?, head?}, {path?}; log: {max_count?, range?, path?}.",
				),
		},
		async ({ session_id, operation, args }) =>
			ok(await client.control("GitOperation", { sessionId: session_id, operation, ...(args ? { args } : {}) })),
	);
}
