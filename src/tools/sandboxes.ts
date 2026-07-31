import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, envSchema } from "./common.js";

/** Sandbox (session) lifecycle. */
export function registerSandboxes(server: McpServer, client: TenkiClient): void {
	server.tool(
		"tenki_create_sandbox",
		"Create a persistent sandbox microVM. Returns the session (id, state) and its data-plane endpoint. Boots in ~2s. Use tenki_exec / tenki_read_file / tenki_write_file against the returned session_id.",
		{
			name: z.string().optional().describe("Human-readable name."),
			cpu_cores: z.number().int().min(1).max(16).optional().describe("vCPUs (default 2)."),
			memory_mb: z.number().int().min(128).max(65536).optional().describe("Memory in MB (default 4096)."),
			disk_size_gb: z.number().int().positive().optional().describe("Disk in GB (default 5)."),
			max_duration_seconds: z.number().int().positive().optional().describe("Hard lifetime cap in seconds."),
			idle_timeout_minutes: z.number().int().positive().optional().describe("Reap after N idle minutes."),
			clone_repo_url: z.string().optional().describe("Git URL to clone into the sandbox on boot."),
			allow_outbound: z.boolean().optional().describe("Allow outbound networking (off by default)."),
			allow_inbound: z.boolean().optional().describe("Allow inbound networking (off by default)."),
			snapshot_id: z.string().optional().describe("Boot from a snapshot."),
			registry_ref: z.string().optional().describe("Boot from a custom registry image."),
			tags: z.array(z.string()).optional().describe("Tags for later filtering."),
			project_id: z.string().optional().describe("Project to create in (defaults to the key's first project)."),
			workspace_id: z.string().optional().describe("Workspace to create in (defaults to the key's first workspace)."),
			env: envSchema,
			wait_ready: z.boolean().optional().describe("Poll until the sandbox is RUNNING before returning (default true)."),
		},
		async (a) => {
			const owner = await client.resolveOwner();
			const projectId = a.project_id ?? owner.projectId;
			const workspaceId = a.workspace_id ?? owner.workspaceId;
			const body: Record<string, unknown> = {
				...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
				...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
				...(workspaceId ? { workspaceId } : {}),
				...(projectId ? { projectId } : {}),
				...(a.name ? { name: a.name } : {}),
				...(a.cpu_cores ? { cpuCores: a.cpu_cores } : {}),
				...(a.memory_mb ? { memoryMb: a.memory_mb } : {}),
				...(a.disk_size_gb ? { diskSizeGb: a.disk_size_gb } : {}),
				...(a.max_duration_seconds ? { maxDuration: `${a.max_duration_seconds}s` } : {}),
				...(a.idle_timeout_minutes ? { idleTimeoutMinutes: a.idle_timeout_minutes } : {}),
				...(a.clone_repo_url ? { cloneRepoUrl: a.clone_repo_url } : {}),
				...(a.allow_outbound ? { allowOutbound: true } : {}),
				...(a.allow_inbound ? { allowInbound: true } : {}),
				...(a.snapshot_id ? { snapshotId: a.snapshot_id } : {}),
				...(a.registry_ref ? { registryRef: a.registry_ref } : {}),
				...(a.tags && a.tags.length ? { tags: a.tags } : {}),
				...(a.env && Object.keys(a.env).length ? { env: a.env } : {}),
			};
			const resp = await client.control("CreateSession", body);
			const session = resp.session ?? resp;
			const sessionId = session.id ?? resp.sessionId;
			const dataPlaneEndpoint = resp.dataPlaneEndpoint ?? resp.data_plane_endpoint;
			const wait = a.wait_ready !== false;
			const finalSession = wait && sessionId ? await client.waitForState(sessionId, "RUNNING") : session;
			return ok({ session: finalSession, dataPlaneEndpoint });
		},
	);

	server.tool(
		"tenki_get_sandbox",
		"Fetch a sandbox's current state and metadata.",
		{ session_id: z.string() },
		async ({ session_id }) => ok(await client.control("GetSession", { sessionId: session_id })),
	);

	server.tool(
		"tenki_list_sandboxes",
		"List sandboxes for the workspace.",
		{
			include_terminated: z.boolean().optional().describe("Include terminated sandboxes (default false)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ include_terminated, page_size, page_token }) =>
			ok(
				await client.control("ListSessions", {
					...(include_terminated ? { includeTerminated: true } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			),
	);

	server.tool(
		"tenki_terminate_sandbox",
		"Terminate (destroy) a sandbox. The microVM and its filesystem are gone after this.",
		{ session_id: z.string() },
		async ({ session_id }) => ok(await client.control("TerminateSession", { sessionId: session_id })),
	);

	server.tool(
		"tenki_pause_sandbox",
		"Pause a sandbox (snapshot + suspend) so it can be resumed later.",
		{ session_id: z.string() },
		async ({ session_id }) => ok(await client.control("PauseSession", { sessionId: session_id })),
	);

	server.tool(
		"tenki_resume_sandbox",
		"Resume a previously paused sandbox.",
		{ session_id: z.string() },
		async ({ session_id }) => ok(await client.control("ResumeSession", { sessionId: session_id })),
	);
}
