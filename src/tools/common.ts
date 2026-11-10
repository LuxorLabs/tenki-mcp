import { z } from "zod";

const PUBLIC_KEYS: Record<string, string> = {
	registryRef: "image",
	registry_ref: "image",
	sourceRegistryImageId: "sourceImageId",
	source_registry_image_id: "source_image_id",
	sourceRegistryWorkspaceId: "sourceImageWorkspaceId",
	source_registry_workspace_id: "source_image_workspace_id",
	sourceRegistryRef: "sourceImage",
	source_registry_ref: "source_image",
	registryImageName: "publishedImageName",
	registry_image_name: "published_image_name",
};

/** Keep registry-backed implementation fields out of public MCP responses. */
export function publicValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, child]) => [PUBLIC_KEYS[key] ?? key, publicValue(child)]),
	);
}

/** Serialize any tool return value as MCP text content. */
export const ok = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(publicValue(value), null, 2) }],
});

// UTF-8 boundary handling for byte-capped text. A position is "inside a
// character" only when a lead byte at most 3 bytes before it declares a
// sequence long enough to cover it. Stray continuation bytes (binary data,
// invalid UTF-8) are not inside anything, so a cut lands exactly there. Start
// and end use the same rule, so consecutive pages tile the file with no gap or
// overlap, on valid UTF-8 and on binary alike.
const isContinuation = (b: number) => (b & 0xc0) === 0x80;
/** Sequence length a lead byte declares (1 for ASCII and invalid leads). */
const utf8SeqLen = (b: number) => (b >= 0xf0 && b <= 0xf7 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc0 && b <= 0xdf ? 2 : 1);

/** Start of the character covering i, or -1 when i is a character start or a stray byte. */
function coveringLead(buf: Buffer, i: number, floor: number): number {
	if (i >= buf.length || !isContinuation(buf[i])) return -1;
	for (let back = 1; back <= 3 && i - back >= floor; back++) {
		const b = buf[i - back];
		if (!isContinuation(b)) return utf8SeqLen(b) > back ? i - back : -1;
	}
	return -1;
}

/** First index ≥ i that starts a character: i itself unless i is inside one, then that character's end. */
export function utf8CharStart(buf: Buffer, i: number): number {
	const lead = coveringLead(buf, i, 0);
	return lead < 0 ? i : Math.min(lead + utf8SeqLen(buf[lead]), buf.length);
}

/** Largest end ≤ limit that does not split a character; always > start when limit > start. */
export function utf8CharEnd(buf: Buffer, start: number, limit: number): number {
	if (limit >= buf.length) return buf.length;
	const lead = coveringLead(buf, limit, start + 1);
	return lead < 0 ? limit : lead;
}

/**
 * Cap a text field at maxBytes without splitting a UTF-8 character. Returns the
 * text unchanged when it fits; otherwise the head plus the original size.
 */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return { text, truncated: false, totalBytes: buf.length };
	return { text: buf.subarray(0, utf8CharEnd(buf, 0, maxBytes)).toString("utf8"), truncated: true, totalBytes: buf.length };
}

/** Shared env-map schema used by tools that accept environment variables. */
export const envSchema = z.record(z.string(), z.string()).optional().describe("Environment variables as a key→value object.");

/** Shared session-id schema — every per-sandbox tool takes one of these.
 * Trimmed, unlike pathSchema below: a session id is a UUID, so surrounding
 * whitespace is always an accident (and the API's uuid validation would
 * reject it), which makes trimming a safe correction rather than the silent
 * retargeting it would be for a filename. */
export const sessionIdSchema = z
	.string()
	.trim()
	.min(1)
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

/**
 * Shared tag-list schema, matching the API's repeated-string constraint on
 * sessions, snapshots, volumes and templates: ≤20 tags, each ≤32 chars of
 * [a-z0-9_:.-] starting with a letter or digit.
 */
export const tagsSchema = z
	.array(z.string().max(32).regex(/^[a-z0-9][a-z0-9_:.-]*$/, "lowercase letters, digits, and _:.- ; must start with a letter or digit"))
	.max(20)
	.optional()
	.describe("Tags (≤20, each ≤32 chars of a-z 0-9 _ : . -).");

/**
 * Wire mapping for the tags/clear_tags pair shared by sessions, snapshots and
 * volumes. proto3 drops an empty repeated field, so `[]` becomes clear_tags;
 * a non-empty list together with clear_tags is rejected because the server
 * applies clear_tags first and would silently discard the list.
 */
export function tagsPatch(tags?: string[], clearTags?: boolean): { tags?: string[]; clearTags?: true } {
	if (clearTags && tags && tags.length) {
		throw new Error("pass either tags (a replacement list) or clear_tags, not both — clear_tags would win and the tags would be silently dropped.");
	}
	if (clearTags || (tags !== undefined && tags.length === 0)) return { clearTags: true };
	return tags && tags.length ? { tags } : {};
}

/** Free-text search across a list (server-side; API max 256 chars). */
export const searchSchema = z.string().max(256).optional();

/** Prefix a bare enum name the way protobuf JSON expects it (e.g. RUNNING → SESSION_STATE_RUNNING). */
export const protoEnum = (prefix: string, value: string): string => `${prefix}_${value}`;

/** Common server-side list options shared by the sandbox, volume, template and preview-URL lists. */
export const listQuery = (search?: string, includeFacets?: boolean, sortDesc?: boolean): Record<string, unknown> => ({
	...(search && search.trim() ? { search: search.trim() } : {}),
	...(includeFacets ? { includeFacets: true } : {}),
	...(sortDesc ? { sortDesc: true } : {}),
});
