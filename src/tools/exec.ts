import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient, ExecResult } from "../client.js";
import { envSchema } from "./common.js";

/**
 * Structured result contract for tenki_exec. Mirrors ExecResult in client.ts —
 * the SDK validates every successful result against this, so the two must stay
 * in lockstep field-for-field.
 */
const execOutputSchema = {
	command: z.string().describe("The executable that was run."),
	args: z.array(z.string()).describe("Arguments the executable was invoked with."),
	stdout: z.string().describe("Captured standard output (empty when capture failed — see captureError)."),
	stderr: z.string().describe("Captured standard error (empty when capture failed — see captureError)."),
	exitCode: z.number().int().describe("Process exit code; 0 means success. (The API omits zero values; the server normalizes an absent code to 0.)"),
	ok: z.boolean().describe("True only when exitCode is 0 AND stdout/stderr capture succeeded."),
	captureError: z
		.string()
		.optional()
		.describe("Present when the command ran but its output could not be read back; stdout/stderr are unknown, not empty."),
};

/**
 * Render an ExecResult as plain text for clients that don't consume
 * structuredContent. Carries the FULL stdout/stderr — output capping is a
 * separate concern and must not silently drop data here.
 */
function execText(r: ExecResult): string {
	const head = `exit ${r.exitCode}${r.ok ? "" : " (failed)"}`;
	const capture = r.captureError ? `\ncapture error: ${r.captureError} — stdout/stderr may be incomplete` : "";
	return `${head}${capture}\n--- stdout (${r.stdout.length} chars) ---\n${r.stdout}\n--- stderr (${r.stderr.length} chars) ---\n${r.stderr}`;
}

/** Command execution inside an existing sandbox. */
export function registerExec(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_exec",
		{
			description: "Run a command in an existing sandbox and return stdout, stderr, and exit code inline.",
			inputSchema: {
				session_id: z.string(),
				command: z.string().describe("Executable, e.g. 'npm' or 'python3'."),
				args: z.array(z.string()).optional().describe("Arguments."),
				cwd: z.string().optional().describe("Working directory (honored in-script)."),
				env: envSchema,
				timeout_seconds: z.number().int().positive().optional(),
			},
			outputSchema: execOutputSchema,
		},
		async ({ session_id, command, args, cwd, env, timeout_seconds }) => {
			const result = await client.execCaptured(session_id, command, { args, cwd, env, timeoutSeconds: timeout_seconds });
			return {
				structuredContent: { ...result },
				content: [{ type: "text" as const, text: execText(result) }],
			};
		},
	);
}
