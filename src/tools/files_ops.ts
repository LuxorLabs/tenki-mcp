import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, pathSchema, sessionIdSchema } from "./common.js";

/**
 * Filesystem metadata + mutation ops against a sandbox's data plane.
 *
 * Extends the basic read/write/list coverage in `files.ts` with `stat`, `mkdir`,
 * `remove`, and `move`. Stat/Mkdir/Remove are genuine unary data-plane RPCs
 * (`SandboxSessionDataPlaneService`). The data plane exposes no `Move` method, so
 * `tenki_move_path` is exec-backed (`mv`) — matching the live-verified n8n node.
 * Paths are rooted at /home/tenki (the server enforces the sandbox root).
 */
export function registerFilesOps(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_stat_path",
		{
			description:
				"Get metadata (size, mode, type, timestamps) for a file or directory in a sandbox. Use to check whether a path exists or inspect it before reading/removing.",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				path: pathSchema.describe(
					"Absolute path under /home/tenki, e.g. /home/tenki/output.txt",
				),
			}),
		},
		async ({ session_id, path }) =>
			ok(await client.data(session_id, "Stat", { path })),
	);

	server.registerTool(
		"tenki_make_dir",
		{
			description:
				"Create a directory in a sandbox. Set recursive to also create any missing parent directories (mkdir -p).",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				path: pathSchema.describe(
					"Directory path under /home/tenki, e.g. /home/tenki/project/out",
				),
				recursive: z
					.boolean()
					.optional()
					.describe("Create parent directories as needed (default false)."),
			}),
		},
		async ({ session_id, path, recursive }) =>
			ok(
				await client.data(session_id, "Mkdir", {
					path,
					...(recursive ? { recursive: true } : {}),
				}),
			),
	);

	server.registerTool(
		"tenki_remove_path",
		{
			description:
				"Delete a file or directory in a sandbox. Set recursive to remove a non-empty directory and its contents (rm -r).",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				path: pathSchema.describe("Path to delete under /home/tenki."),
				recursive: z
					.boolean()
					.optional()
					.describe("Remove a directory and its contents (default false)."),
			}),
		},
		async ({ session_id, path, recursive }) =>
			ok(
				await client.data(session_id, "Remove", {
					path,
					...(recursive ? { recursive: true } : {}),
				}),
			),
	);

	server.registerTool(
		"tenki_move_path",
		{
			description:
				"Move or rename a file or directory within a sandbox. Both paths are under /home/tenki.",
			inputSchema: z.object({
				session_id: sessionIdSchema,
				from: pathSchema.describe(
					"Source path under /home/tenki, e.g. /home/tenki/old.txt",
				),
				to: pathSchema.describe(
					"Destination path under /home/tenki, e.g. /home/tenki/new.txt",
				),
			}),
		},
		async ({ session_id, from, to }) => {
			// The data plane has no Move RPC (ReadFile/WriteFile/Stat/Mkdir/Remove/List only),
			// so relocate with an exec-backed `mv`, mirroring the live-verified n8n node.
			// `ok` keys off the exit code, NOT result.ok: the capture files are an
			// internal detail here — whether mv's (empty) output could be read back
			// says nothing about whether the file moved.
			// `--` so a path beginning with a hyphen is an operand, not an mv option.
			const result = await client.execCaptured(session_id, "mv", {
				args: ["--", from, to],
			});
			return ok({
				from,
				to,
				ok: result.exitCode === 0,
				exitCode: result.exitCode,
				...(result.stderr ? { stderr: result.stderr } : {}),
				...(result.captureError ? { captureError: result.captureError } : {}),
			});
		},
	);
}
