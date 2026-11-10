import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { capText, ok, sessionIdSchema } from "./common.js";

/**
 * Git inside a sandbox, one tool per operation. The API exposes a single
 * GitOperation RPC whose `operation` must be clone, checkout, diff or log
 * (GitOperationRequest's buf.validate `in` list) with a string→string args map;
 * these tools give each operation typed arguments and an accurate read/write
 * classification (diff/log are reads, clone/checkout change the filesystem).
 * For any other git command (status, add, commit, push, ...) use tenki_exec.
 *
 * Arg keys are the ones the engine reads (tenki-app
 * backend/internal/domain/sandbox/service/git_operation.go, buildGitOperationArgs):
 * checkout/diff/log run `git -C <directory>` when `directory` is set — without
 * it they run in /home/tenki, which is not a repository unless one was cloned
 * there. Values are argv to the engine's command, never a shell string.
 *
 * The engine places repo, branch, directory, ref, range, base and head in
 * git's argv without `--end-of-options`, so a value starting with `-` would be
 * parsed as an option: `git diff --output=<file>` truncates a file and
 * `git clone --upload-pack=<cmd>` runs a command. Those values are refused
 * here — which is also what keeps tenki_git_diff / tenki_git_log read-only.
 * `path` is safe: the engine always puts it after `--`.
 */

// Inline output budget, matching tenki_exec and tenki_read_file.
const MAX_OUTPUT_BYTES = 65_536;

// The engine re-trims each value with Go's strings.TrimSpace, which also strips
// U+0085 (NEL) — JavaScript's trim() and \s do not — so "\u0085--output=x"
// would reach git as "--output=x". Refuse a '-' behind any such whitespace.
const noOption = (s: string) => !/^[\s\u0085]*-/.test(s);
const NO_OPTION_MSG = "must not start with '-' (git would read it as an option)";

/** A value the engine passes to git as a bare argument. */
const gitArg = (description: string) => z.string().trim().min(1).refine(noOption, NO_OPTION_MSG).describe(description);

const directorySchema = gitArg(
	"Repository directory in the sandbox, e.g. /home/tenki/myrepo (relative paths resolve from /home/tenki). Omit only if the repository is /home/tenki itself.",
).optional();

/** How to get less output, per operation (only diff/log take narrowing args). */
const NARROW: Record<string, string> = {
	diff: "Narrow it with path or range/base/head, or run git through tenki_exec and page its output.",
	log: "Narrow it with max_count, path or range, or run git through tenki_exec and page its output.",
};
const NARROW_DEFAULT = "Run git through tenki_exec to page the full output.";

async function gitOperation(client: TenkiClient, sessionId: string, operation: string, args: Record<string, string | number | boolean | undefined>) {
	const stringArgs = Object.fromEntries(
		Object.entries(args)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, String(v)]),
	);
	const resp = await client.control("GitOperation", { sessionId, operation, args: stringArgs });
	if (typeof resp?.output !== "string") return ok(resp);
	const capped = capText(resp.output, MAX_OUTPUT_BYTES);
	if (!capped.truncated) return ok(resp);
	return ok({
		...resp,
		output: capped.text,
		truncated: true,
		totalBytes: capped.totalBytes,
		note: `Output truncated to ${MAX_OUTPUT_BYTES} bytes. ${NARROW[operation] ?? NARROW_DEFAULT}`,
	});
}

export function registerGit(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_git_clone",
		"Clone a git repository into a sandbox and return git's output. The target directory must not already exist or must be empty. For other git commands (status, add, commit, push, ...) use tenki_exec with `git ...`.",
		{
			session_id: sessionIdSchema,
			repo: gitArg("Repository URL to clone, e.g. https://github.com/octocat/Hello-World."),
			branch: gitArg("Branch or tag to check out after cloning (git clone --branch).").optional(),
			depth: z.number().int().positive().optional().describe("Create a shallow clone with this many commits (git clone --depth)."),
			directory: gitArg("Directory to clone into, e.g. /home/tenki/myrepo. Defaults to the repository name under /home/tenki.").optional(),
		},
		async ({ session_id, repo, branch, depth, directory }) => gitOperation(client, session_id, "clone", { repo, branch, depth, directory }),
	);

	server.tool(
		"tenki_git_checkout",
		"Check out a branch, tag or commit in a repository inside a sandbox (git checkout), optionally creating a new branch. Changes the files in the working tree.",
		{
			session_id: sessionIdSchema,
			ref: gitArg("Branch, tag or commit to check out, or the name of the branch to create when create is true."),
			create: z.boolean().optional().describe("Create ref as a new branch from the current HEAD (git checkout -b). Default false."),
			directory: directorySchema,
		},
		async ({ session_id, ref, create, directory }) =>
			gitOperation(client, session_id, "checkout", { ref, create: create ? "true" : undefined, directory }),
	);

	server.tool(
		"tenki_git_diff",
		`Show a diff for a repository inside a sandbox (git diff): unstaged working-tree changes by default, or between refs. Read-only. Output over ${MAX_OUTPUT_BYTES} bytes is truncated.`,
		{
			session_id: sessionIdSchema,
			range: gitArg("Revision range, e.g. main..feature or HEAD~3. Cannot be combined with base/head.").optional(),
			base: gitArg("Base ref to diff from (with head: git diff base..head; alone: git diff base).").optional(),
			head: gitArg("Head ref to diff to (with base: git diff base..head; alone: git diff head).").optional(),
			path: z.string().trim().min(1).optional().describe("Limit the diff to this file or directory, relative to the repository root."),
			directory: directorySchema,
		},
		async ({ session_id, range, base, head, path, directory }) => {
			if (range !== undefined && (base !== undefined || head !== undefined)) {
				throw new Error("tenki_git_diff: pass either range or base/head, not both.");
			}
			return gitOperation(client, session_id, "diff", { range, base, head, path, directory });
		},
	);

	server.tool(
		"tenki_git_log",
		`Show commit history for a repository inside a sandbox (git log). Read-only. Output over ${MAX_OUTPUT_BYTES} bytes is truncated.`,
		{
			session_id: sessionIdSchema,
			max_count: z.number().int().positive().max(1000).optional().describe("Maximum number of commits to show (git log --max-count). Set this to keep output small."),
			range: gitArg("Revision range, e.g. main..feature.").optional(),
			path: z.string().trim().min(1).optional().describe("Only commits touching this file or directory, relative to the repository root."),
			directory: directorySchema,
		},
		async ({ session_id, max_count, range, path, directory }) => gitOperation(client, session_id, "log", { max_count, range, path, directory }),
	);
}
