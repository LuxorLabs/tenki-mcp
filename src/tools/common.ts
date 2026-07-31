import { z } from "zod";

/** Serialize any tool return value as MCP text content. */
export const ok = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** Shared env-map schema used by tools that accept environment variables. */
export const envSchema = z.record(z.string()).optional().describe("Environment variables as a key→value object.");
