import { z } from "zod";

/** Serialize any tool return value as MCP text content. */
export const ok = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** Shared env-map schema used by tools that accept environment variables. */
export const envSchema = z.record(z.string()).optional().describe("Environment variables as a key→value object.");

/** Shared session-id schema — every per-sandbox tool takes one of these.
 * Rejects empty/whitespace-only ids client-side WITHOUT transforming the
 * value — zod's .trim() is a transform, and arguments must reach the API
 * verbatim. */
export const sessionIdSchema = z
	.string()
	.refine((s) => s.trim().length > 0, "session id must not be empty or whitespace-only")
	.describe("Sandbox session id (UUID), from tenki_create_sandbox or tenki_list_sandboxes.");

/** Shared TCP-port schema. */
export const portSchema = z.number().int().min(1).max(65535).describe("TCP port inside the sandbox (1-65535).");

/** Shared sandbox-path schema — rejects an empty or whitespace-only path
 * client-side instead of by a server error, WITHOUT transforming the value:
 * leading/trailing whitespace is legal in POSIX filenames, and zod's .trim()
 * (a transform, not a check) would silently retarget the operation to a
 * different file. Call sites override the description with their own examples. */
export const pathSchema = z
	.string()
	.refine((s) => s.trim().length > 0, "path must not be empty or whitespace-only")
	.describe("Absolute path inside the sandbox, under /home/tenki.");

/**
 * Preview-slug schema, matching the server's validatePreviewSlug: 3-63 chars,
 * lowercase/digits/hyphens, no leading/trailing hyphen. ExposePort routes a
 * slug through the SAME preview validation (exposePersistentPreviewURL), so
 * this applies to tenki_expose_port too. The server additionally rejects
 * consecutive hyphens, reserved names, and workspace-length overflows —
 * those stay server-side.
 */
export const slugSchema = z
	.string()
	.min(3)
	.max(63)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, and hyphens; cannot start or end with a hyphen")
	.describe("Subdomain slug for the preview URL (3-63 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen).");
