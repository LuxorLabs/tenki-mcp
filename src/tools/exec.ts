import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient, ExecResult } from "../client.js";
import { envSchema, sessionIdSchema } from "./common.js";

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
	stdoutTruncated: z
		.boolean()
		.optional()
		.describe("Present (true) when stdout exceeded the output cap and carries only a head+tail preview."),
	stderrTruncated: z
		.boolean()
		.optional()
		.describe("Present (true) when stderr exceeded the output cap and carries only a head+tail preview."),
	stdoutPath: z
		.string()
		.optional()
		.describe("Sandbox path holding the FULL stdout, present only when truncated — page through it with tenki_exec (e.g. sed -n / tail -c)."),
	stderrPath: z
		.string()
		.optional()
		.describe("Sandbox path holding the FULL stderr, present only when truncated — page through it with tenki_exec (e.g. sed -n / tail -c)."),
};

/**
 * Field drift between execOutputSchema and ExecResult must fail the build, not
 * the tool call — at runtime the SDK rejects a mismatched result outright and
 * the command's output is lost.
 */
const execOutput = z.object(execOutputSchema);
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _execSchemaLockstep: MutuallyAssignable<z.infer<typeof execOutput>, ExecResult> = true;
void _execSchemaLockstep;

/**
 * Sandbox output is untrusted (SECURITY.md). Neutralize characters that can
 * misrepresent output in a terminal or transcript — C0 controls except \n and
 * \t (ANSI sequences, CR line-overwrite spoofing), DEL, C1 controls (0x80–0x9F
 * are single-character equivalents: U+009B is CSI), bidi controls
 * (U+202A–U+202E, U+2066–U+2069 reorder displayed text), and zero-width/
 * invisible marks (U+200B–U+200F, U+FEFF) — into visible \xNN / \uNNNN
 * escapes. The previous JSON.stringify rendering escaped controls implicitly;
 * a raw text rendering must do it explicitly. structuredContent keeps the raw
 * strings — JSON encoding neutralizes them on the wire, and typed consumers
 * need unmodified data.
 */
function sanitizeForTerminal(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (c) => {
		const code = c.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/**
 * Render an ExecResult as plain text for clients that don't consume
 * structuredContent. Carries the streams as returned (control chars escaped);
 * any capping happened upstream in execCaptured, which marks it explicitly —
 * a truncated stream carries an inline marker and its full-output path.
 */
function execText(r: ExecResult): string {
	const head = `exit ${r.exitCode}${r.ok ? "" : " (failed)"}`;
	const capture = r.captureError
		? `\ncapture error: ${sanitizeForTerminal(r.captureError)} — stdout/stderr may be incomplete`
		: "";
	const stdout = sanitizeForTerminal(r.stdout);
	const stderr = sanitizeForTerminal(r.stderr);
	const outTag = r.stdoutTruncated ? ", TRUNCATED — full output at " + r.stdoutPath : "";
	const errTag = r.stderrTruncated ? ", TRUNCATED — full output at " + r.stderrPath : "";
	return `${head}${capture}\n--- stdout (${r.stdout.length} chars, control chars escaped${outTag}) ---\n${stdout}\n--- stderr (${r.stderr.length} chars, control chars escaped${errTag}) ---\n${stderr}`;
}

/** Command execution inside an existing sandbox. */
export function registerExec(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_exec",
		{
			description:
				"Run a command in an existing sandbox and return stdout, stderr, and exit code inline. Streams over max_output_bytes (default 64KB) come back as a head+tail preview with the full output retained at stdoutPath/stderrPath in the sandbox.",
			inputSchema: {
				session_id: sessionIdSchema,
				command: z.string().describe("Executable, e.g. 'npm' or 'python3'."),
				args: z.array(z.string()).optional().describe("Arguments."),
				cwd: z.string().optional().describe("Working directory (honored in-script)."),
				env: envSchema,
				timeout_seconds: z.number().int().positive().optional(),
				max_output_bytes: z
					.number()
					.int()
					.min(1024)
					.max(10_000_000)
					.optional()
					.describe("Per-stream inline output cap in bytes (default 65536). Larger output is truncated head+tail and kept in the sandbox at stdoutPath/stderrPath."),
			},
			outputSchema: execOutputSchema,
		},
		async ({ session_id, command, args, cwd, env, timeout_seconds, max_output_bytes }) => {
			const result = await client.execCaptured(session_id, command, {
				args,
				cwd,
				env,
				timeoutSeconds: timeout_seconds,
				maxOutputBytes: max_output_bytes,
			});
			return {
				structuredContent: { ...result },
				// Two text blocks: serialized JSON first (the MCP spec's
				// backwards-compatibility contract for structured content — existing
				// text-only consumers, our own test harness included, parse the first
				// text block as JSON), then the human-readable rendering.
				content: [
					{ type: "text" as const, text: JSON.stringify(result, null, 2) },
					{ type: "text" as const, text: execText(result) },
				],
			};
		},
	);
}
