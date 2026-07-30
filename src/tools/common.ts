import { z } from "zod";

/** Serialize any tool return value as MCP text content. */
export const ok = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** Shared env-map schema used by tools that accept environment variables. */
export const envSchema = z.record(z.string()).optional().describe("Environment variables as a key→value object.");

/** Shared session-id schema — every per-sandbox tool takes one of these. */
export const sessionIdSchema = z
	.string()
	.min(1)
	.describe("Sandbox session id (UUID), from tenki_create_sandbox or tenki_list_sandboxes.");

/** Shared TCP-port schema. */
export const portSchema = z.number().int().min(1).max(65535).describe("TCP port inside the sandbox (1-65535).");

/** Preview-slug schema — live-verified server rules: 3-63 chars, [a-z0-9-]. */
export const slugSchema = z
	.string()
	.min(3)
	.max(63)
	.regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only")
	.describe("Subdomain slug for the preview URL (3-63 chars, lowercase letters/digits/hyphens).");
