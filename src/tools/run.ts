import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient, Language } from "../client.js";
import { ok, envSchema } from "./common.js";

/** The headline one-shot execution tool. */
export function registerRun(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_run_code",
		"Boot a throwaway microVM, run a snippet (shell/python/javascript), return its stdout/stderr/exit code, and tear the sandbox down. Cost-guarded and self-terminating. Use this for one-shot execution when you don't need a persistent sandbox.",
		{
			language: z.enum(["shell", "python", "javascript"]).describe("Interpreter for the snippet."),
			code: z.string().describe("The code to run."),
			env: envSchema,
			timeout_seconds: z.number().int().positive().optional().describe("Max seconds for the run (default 30)."),
		},
		async ({ language, code, env, timeout_seconds }) =>
			ok(await client.runCode(language as Language, code, { env, timeoutSeconds: timeout_seconds })),
	);
}
