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
		"Run a git operation in a sandbox. Only clone, checkout, diff, and log are supported by the API — for any other git command (status, add, commit, push, ...) use tenki_exec with `git ...`. " +
			"clone arg keys: repo (required, the URL), branch?, depth?, directory?. " +
			"CAVEAT (live-verified): checkout/diff/log run in the session's working directory (/home/tenki), which is not a repository and has no directory arg — so on a repo cloned into a subdirectory they fail with 'not a git repository'. Use tenki_exec with `git -C <directory> ...` instead (e.g. `git -C /home/tenki/hw log -n 2`). " +
			"For reference, their arg keys are — checkout: ref (required), create? ('true' = -b); diff: range? or base?+head?, path?; log: max_count?, range?, path?.",
		{
			session_id: sessionIdSchema,
			operation: z.enum(GIT_OPERATIONS).describe("One of: clone, checkout, diff, log (the API rejects anything else)."),
			// The wire type is map<string,string>, but the values models most want
			// to send as numbers or booleans (depth, max_count, create) are
			// accepted here and coerced — a client-side rejection of `create: true`
			// for a call that would serialize identically helps nobody.
			args: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe(
					"Operation args as a key→value object (values are sent as strings; numbers/booleans are coerced). clone: {repo, branch?, depth?, directory?}; checkout: {ref, create?: 'true'}; diff: {range?} or {base?, head?}, {path?}; log: {max_count?, range?, path?}.",
				),
		},
		async ({ session_id, operation, args }) => {
			const stringArgs = args ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) : undefined;
			return ok(
				await client.control("GitOperation", { sessionId: session_id, operation, ...(stringArgs ? { args: stringArgs } : {}) }),
			);
		},
	);
}
