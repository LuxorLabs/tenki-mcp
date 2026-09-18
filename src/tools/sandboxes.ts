import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, envSchema, pathSchema, sessionIdSchema, tagsSchema } from "./common.js";

/** Non-secret/secret request-scoped env maps share the API's key/value bounds. */
const MAX_ENV_PAIRS = 64;
const boundedEnvSchema = z
	.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(8192))
	.refine((o) => Object.keys(o).length <= MAX_ENV_PAIRS, `at most ${MAX_ENV_PAIRS} pairs`)
	.optional();

/** Sandbox (session) lifecycle. */
export function registerSandboxes(server: McpServer, client: TenkiClient): void {
	server.registerTool(
		"tenki_create_sandbox",
		{
			description:
				"Create a persistent sandbox microVM, optionally from a snapshot or template image. Returns the session (id, state), its data-plane endpoint, and any `warnings` the API attached (e.g. a max duration that was capped or overridden by sticky). Boots in ~2s. Use tenki_exec / tenki_read_file / tenki_write_file against the returned session id.",
			inputSchema: z
				.object({
					name: z.string().max(64).optional().describe("Human-readable name."),
					cpu_cores: z.number().int().min(1).max(16).optional().describe("vCPUs (default 2)."),
					memory_mb: z
						.number()
						.int()
						.min(128)
						.max(65536)
						.refine((n) => n % 2 === 0, "memory_mb must be aligned to 2 MiB (even)")
						.optional()
						.describe("Memory in MB (default 4096; must be even)."),
					disk_size_gb: z.number().int().min(5).max(100).optional().describe("Disk in GB (default 5; 5-100)."),
					max_duration_seconds: z.number().int().positive().optional().describe("Hard lifetime cap in seconds."),
					idle_timeout_minutes: z
						.number()
						.int()
						.min(0)
						.optional()
						.describe("Reap after N idle minutes (0 disables the idle reaper). Not changeable after creation."),
					sticky: z
						.boolean()
						.optional()
						.describe("Keep the sandbox alive with no hard lifetime cap (overrides max_duration/idle timeout with a warning). Not allowed for service credentials."),
					clone_repo_url: z.string().optional().describe("Git URL to clone into the sandbox on boot."),
					allow_outbound: z.boolean().optional().describe("Allow outbound networking (off by default)."),
					allow_inbound: z.boolean().optional().describe("Allow inbound networking (off by default)."),
					egress_allow_domains: z
						.array(z.string().max(253))
						.max(256)
						.optional()
						.describe("Egress allowlist: exact hostnames or single-label '*.example.com' wildcards. Omit for unrestricted egress. Ignored when allow_outbound is false."),
					egress_allow_cidrs: z
						.array(z.string().max(18))
						.max(64)
						.optional()
						.describe("Egress allowlist: IPv4 prefixes reachable without a name lookup."),
					snapshot_id: z.string().optional().describe("Boot from a snapshot."),
					image: z
						.string()
						.optional()
						.describe(
							"Boot from a template image, passed as a reference STRING: the imageDigestRef of a READY build from tenki_build_template / tenki_get_template_build (e.g. 'ws/name@sha256:...'), or 'workspace/name' for its latest version.",
						),
					template_spec_id: z
						.string()
						.optional()
						.describe("Run a typed template's current spec directly in the new sandbox (no build / no published image)."),
					setup_env: boundedEnvSchema.describe("Non-secret request-scoped env for template setup steps (≤64 pairs)."),
					setup_secrets: boundedEnvSchema.describe("Secret request-scoped env for checkout/setup only; never persisted (≤64 pairs)."),
					secret_overrides: z
						.record(z.string(), z.string())
						.refine((o) => Object.keys(o).length <= MAX_ENV_PAIRS, `at most ${MAX_ENV_PAIRS} pairs`)
						.optional()
						.describe("Map of a declared runtime secret name to the workspace secret to use instead (≤64 pairs)."),
					volumes: z
						.array(
							z.object({
								volume_id: z.string().describe("Volume id to mount."),
								mount_path: pathSchema.describe("Absolute mount path inside the sandbox, e.g. /mnt/data."),
								read_only: z.boolean().optional().describe("Mount read-only (default read-write)."),
							}),
						)
						.optional()
						.describe("Volumes to attach at boot (also attachable later with tenki_attach_volume)."),
					ssh_authorized_keys: z
						.array(z.string().min(1))
						.optional()
						.describe("SSH public keys to authorize at boot (also settable later with tenki_update_ssh_keys)."),
					metadata: z.record(z.string(), z.string()).optional().describe("Free-form key→value metadata stored on the session."),
					tags: tagsSchema.describe("Tags for later filtering (≤20, each ≤32 chars of a-z 0-9 _ : . -)."),
					workspace_id: z.string().optional().describe("Workspace to create in (defaults to the key's first workspace)."),
					env: envSchema,
					wait_ready: z
						.boolean()
						.optional()
						.describe("Wait until the sandbox is RUNNING before returning (default true). The server holds the request for a bounded time; the tool then polls for the remainder."),
				})
				.strict(),
		},
		async (a) => {
			const owner = await client.resolveOwner();
			const workspaceId = a.workspace_id ?? owner.workspaceId;
			const wait = a.wait_ready !== false;
			const egress =
				(a.egress_allow_domains && a.egress_allow_domains.length) || (a.egress_allow_cidrs && a.egress_allow_cidrs.length)
					? {
							...(a.egress_allow_domains && a.egress_allow_domains.length ? { allowDomains: a.egress_allow_domains } : {}),
							...(a.egress_allow_cidrs && a.egress_allow_cidrs.length ? { allowCidrs: a.egress_allow_cidrs } : {}),
						}
					: undefined;
			// allow_inbound / allow_outbound are `optional bool` with presence semantics on
			// the wire, so an explicit false is sent, not dropped (sticky is a plain bool;
			// sending false there is harmless).
			const body: Record<string, unknown> = {
				...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
				...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
				...(workspaceId ? { workspaceId } : {}),
				...(a.name ? { name: a.name } : {}),
				...(a.cpu_cores !== undefined ? { cpuCores: a.cpu_cores } : {}),
				...(a.memory_mb !== undefined ? { memoryMb: a.memory_mb } : {}),
				...(a.disk_size_gb !== undefined ? { diskSizeGb: a.disk_size_gb } : {}),
				...(a.max_duration_seconds ? { maxDuration: `${a.max_duration_seconds}s` } : {}),
				...(a.idle_timeout_minutes !== undefined ? { idleTimeoutMinutes: a.idle_timeout_minutes } : {}),
				...(a.sticky !== undefined ? { sticky: a.sticky } : {}),
				...(a.clone_repo_url ? { cloneRepoUrl: a.clone_repo_url } : {}),
				...(a.allow_outbound !== undefined ? { allowOutbound: a.allow_outbound } : {}),
				...(a.allow_inbound !== undefined ? { allowInbound: a.allow_inbound } : {}),
				...(egress ? { egress } : {}),
				...(a.snapshot_id ? { snapshotId: a.snapshot_id } : {}),
				// The API still uses registryRef internally for template-image launches.
				...(a.image ? { registryRef: a.image } : {}),
				...(a.template_spec_id ? { templateSpecId: a.template_spec_id } : {}),
				...(a.setup_env && Object.keys(a.setup_env).length ? { setupEnv: a.setup_env } : {}),
				...(a.setup_secrets && Object.keys(a.setup_secrets).length ? { setupSecrets: a.setup_secrets } : {}),
				...(a.secret_overrides && Object.keys(a.secret_overrides).length ? { secretOverrides: a.secret_overrides } : {}),
				...(a.volumes && a.volumes.length
					? {
							volumes: a.volumes.map((v) => ({
								volumeId: v.volume_id,
								mountPath: v.mount_path,
								// proto field is `readonly` (one word) — `readOnly` is discarded by the API.
								...(v.read_only !== undefined ? { readonly: v.read_only } : {}),
							})),
						}
					: {}),
				...(a.ssh_authorized_keys && a.ssh_authorized_keys.length ? { sshAuthorizedKeys: a.ssh_authorized_keys } : {}),
				...(a.metadata && Object.keys(a.metadata).length ? { metadata: a.metadata } : {}),
				...(a.tags && a.tags.length ? { tags: a.tags } : {}),
				...(a.env && Object.keys(a.env).length ? { env: a.env } : {}),
				// Server-side bounded wait (CreateSessionRequest.wait_ready); on expiry the
				// session comes back in its current state and we fall back to polling.
				...(wait ? { waitReady: true } : {}),
			};
			const resp = await client.control("CreateSession", body);
			const session = resp.session ?? resp;
			const sessionId = session.id ?? resp.sessionId;
			const dataPlaneEndpoint = resp.dataPlaneEndpoint ?? resp.data_plane_endpoint;
			const warnings = Array.isArray(resp.warnings) ? resp.warnings : [];
			const finalSession =
				wait && sessionId && !String(session.state ?? "").includes("RUNNING") ? await client.waitForState(sessionId, "RUNNING") : session;
			return ok({ session: finalSession, dataPlaneEndpoint, ...(warnings.length ? { warnings } : {}) });
		},
	);

	server.tool(
		"tenki_get_sandbox",
		"Fetch a sandbox's current state and metadata.",
		{ session_id: sessionIdSchema },
		async ({ session_id }) => ok(await client.control("GetSession", { sessionId: session_id })),
	);

	server.tool(
		"tenki_get_sandbox_metrics",
		"Get a sandbox's CPU and memory usage averaged over a recent window (default 5 minutes; 1 minute to 30 days): average cores / percent of limit, average bytes / percent of limit, sample count and coverage. Use to right-size a sandbox or spot a runaway process.",
		{
			session_id: sessionIdSchema,
			window_seconds: z
				.number()
				.int()
				.min(60)
				.max(30 * 24 * 3600)
				.optional()
				.describe("Averaging window in seconds ending now: 60 (1 minute) to 2592000 (30 days). Omit for the API default (5 minutes)."),
		},
		async ({ session_id, window_seconds }) =>
			ok(
				await client.control("GetSessionMetrics", {
					sessionId: session_id,
					...(window_seconds ? { window: `${window_seconds}s` } : {}),
				}),
			),
	);

	server.tool(
		"tenki_list_sandboxes",
		"List the credential's sandboxes (workspace scope is inferred from the API key), optionally filtered by tags or stickiness. Paginated: a nextPageToken in the response means more pages exist.",
		{
			include_terminated: z.boolean().optional().describe("Include terminated sandboxes (default false)."),
			tags: z.array(z.string()).optional().describe("Only sandboxes carrying all of these tags."),
			sticky: z.boolean().optional().describe("Only sticky (true) or only non-sticky (false) sandboxes."),
			page_size: z.number().int().min(1).max(100).optional().describe("Rows per page (max 100)."),
			page_token: z.string().optional(),
		},
		async ({ include_terminated, tags, sticky, page_size, page_token }) =>
			ok(
				await client.control("ListSessions", {
					...(include_terminated ? { includeTerminated: true } : {}),
					...(tags && tags.length ? { tags } : {}),
					...(sticky !== undefined ? { sticky } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.tool(
		"tenki_terminate_sandbox",
		"Terminate (destroy) a sandbox. The microVM and its filesystem are gone after this.",
		{ session_id: sessionIdSchema },
		async ({ session_id }) => ok(await client.control("TerminateSession", { sessionId: session_id })),
	);

	server.tool(
		"tenki_pause_sandbox",
		"Pause a sandbox (snapshot + suspend) so it can be resumed later. By default the call blocks until the pause snapshot is durable (can take ~40s); pass async to return as soon as the pause is accepted and poll tenki_get_sandbox for PAUSED.",
		{
			session_id: sessionIdSchema,
			async: z.boolean().optional().describe("Return once the pause is accepted instead of waiting for it to finish (default false)."),
		},
		async ({ session_id, async: isAsync }) =>
			ok(await client.control("PauseSession", { sessionId: session_id, ...(isAsync ? { async: true } : {}) })),
	);

	server.tool(
		"tenki_resume_sandbox",
		"Resume a previously paused sandbox.",
		{ session_id: sessionIdSchema },
		async ({ session_id }) => ok(await client.control("ResumeSession", { sessionId: session_id })),
	);
}
