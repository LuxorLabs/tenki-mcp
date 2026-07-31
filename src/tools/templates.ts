import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok, envSchema } from "./common.js";

/**
 * Template tools — custom-image templates and their builds.
 *
 * A "template" is a reusable sandbox-image spec (base image + setup script +
 * default resources/env); building one produces a snapshot/image that sandboxes
 * can boot from. Method names and request fields are matched to the generated
 * `tenki.sandbox.v1.SandboxService` protobuf (the wire contract the control
 * plane actually speaks). Notable shapes: sizing is a nested `resources` object
 * ({ cpuCores, memoryMb, diskSizeGb }); the env map is `envVars`; a build is
 * addressed by `buildId`; and ListActiveTemplateBuilds is scoped by `templateId`.
 */
export function registerTemplates(server: McpServer, client: TenkiClient): void {
	/** Assemble the nested TemplateResources object from flat sizing params (omitting any unset). */
	const resourcesFrom = (cpuCores?: number, memoryMb?: number, diskSizeGb?: number): Record<string, number> => {
		const r: Record<string, number> = {};
		if (cpuCores !== undefined) r.cpuCores = cpuCores;
		if (memoryMb !== undefined) r.memoryMb = memoryMb;
		if (diskSizeGb !== undefined) r.diskSizeGb = diskSizeGb;
		return r;
	};

	// ── Create ──────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_create_template",
		"Create a custom-image template (a reusable sandbox-image spec: base image + setup script + default resources). Build it into a bootable image later with tenki_build_template.",
		{
			name: z.string().describe("Human-readable template name."),
			base_image_id: z.string().optional().describe("Base image ID to build on top of."),
			setup_script: z.string().optional().describe("Shell script run at build time to provision the image. Required for a from-scratch template (the API rejects a create without it unless you derive from a parent template/image)."),
			start_cmd: z.string().optional().describe("Command run when a sandbox boots from this template."),
			cpu_cores: z.number().int().min(1).max(16).optional().describe("Default vCPUs for sandboxes from this template (1-16)."),
			memory_mb: z.number().int().min(512).max(65536).optional().describe("Default memory in MB (512-65536)."),
			disk_size_gb: z.number().int().min(5).max(100).optional().describe("Default disk in GB (5-100)."),
			env_vars: envSchema,
			tags: z.array(z.string()).optional().describe("Tags for later filtering."),
			parent_template_id: z.string().optional().describe("Derive this template from an existing template."),
			parent_image: z.string().optional().describe("Derive this template from an existing built image reference."),
			builder_spec: z.record(z.unknown()).optional().describe("Advanced structured build spec (TemplateBuildSpec); passed through as-is."),
			workspace_id: z.string().optional().describe("Workspace to create in (defaults to the key's first workspace)."),
			project_id: z.string().optional().describe("Project to create in (defaults to the key's first project)."),
		},
		async (a) => {
			const owner = await client.resolveOwner();
			const workspaceId = a.workspace_id ?? owner.workspaceId;
			const projectId = a.project_id ?? owner.projectId;
			const resources = resourcesFrom(a.cpu_cores, a.memory_mb, a.disk_size_gb);
			const body: Record<string, unknown> = {
				...(workspaceId ? { workspaceId } : {}),
				name: a.name,
				...(a.base_image_id ? { baseImageId: a.base_image_id } : {}),
				...(a.setup_script !== undefined ? { setupScript: a.setup_script } : {}),
				...(a.start_cmd !== undefined ? { startCmd: a.start_cmd } : {}),
				...(a.env_vars && Object.keys(a.env_vars).length ? { envVars: a.env_vars } : {}),
				...(Object.keys(resources).length ? { resources } : {}),
				...(projectId ? { projectId } : {}),
				...(a.tags && a.tags.length ? { tags: a.tags } : {}),
				...(a.parent_template_id ? { parentTemplateId: a.parent_template_id } : {}),
				...(a.parent_image ? { parentImage: a.parent_image } : {}),
				...(a.builder_spec ? { builderSpec: a.builder_spec } : {}),
			};
			return ok(await client.control("CreateTemplate", body));
		},
	);

	// ── Get ─────────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_get_template",
		"Retrieve one template by ID.",
		{ template_id: z.string().describe("The template ID.") },
		async ({ template_id }) => ok(await client.control("GetTemplate", { templateId: template_id })),
	);

	// ── List ────────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_list_templates",
		"List templates for the workspace, optionally filtered by tags.",
		{
			tags: z.array(z.string()).optional().describe("Only return templates that carry all of these tags."),
			workspace_id: z.string().optional().describe("Workspace to list from (defaults to the key's first workspace)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ tags, workspace_id, page_size, page_token }) => {
			const owner = await client.resolveOwner();
			const workspaceId = workspace_id ?? owner.workspaceId;
			return ok(
				await client.control("ListTemplates", {
					...(workspaceId ? { workspaceId } : {}),
					...(tags && tags.length ? { tags } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);

	// ── Update ──────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_update_template",
		"Update mutable fields on a template. Only the fields you provide are changed; pass clear_tags to remove all tags.",
		{
			template_id: z.string().describe("The template ID to update."),
			name: z.string().optional().describe("New human-readable name."),
			base_image_id: z.string().optional().describe("New base image ID."),
			setup_script: z.string().optional().describe("New build-time provisioning script."),
			start_cmd: z.string().optional().describe("New boot command."),
			cpu_cores: z.number().int().min(1).max(16).optional().describe("New default vCPUs (1-16)."),
			memory_mb: z.number().int().min(512).max(65536).optional().describe("New default memory in MB (512-65536)."),
			disk_size_gb: z.number().int().min(5).max(100).optional().describe("New default disk in GB (5-100)."),
			env_vars: envSchema,
			tags: z.array(z.string()).optional().describe("Replacement set of tags."),
			clear_tags: z.boolean().optional().describe("Remove all tags from the template."),
			builder_spec: z.record(z.unknown()).optional().describe("Advanced structured build spec (TemplateBuildSpec); passed through as-is."),
		},
		async (a) => {
			const resources = resourcesFrom(a.cpu_cores, a.memory_mb, a.disk_size_gb);
			const body: Record<string, unknown> = {
				templateId: a.template_id,
				...(a.name !== undefined ? { name: a.name } : {}),
				...(a.base_image_id !== undefined ? { baseImageId: a.base_image_id } : {}),
				...(a.setup_script !== undefined ? { setupScript: a.setup_script } : {}),
				...(a.start_cmd !== undefined ? { startCmd: a.start_cmd } : {}),
				...(a.env_vars && Object.keys(a.env_vars).length ? { envVars: a.env_vars } : {}),
				...(Object.keys(resources).length ? { resources } : {}),
				...(a.tags && a.tags.length ? { tags: a.tags } : {}),
				...(a.clear_tags ? { clearTags: true } : {}),
				...(a.builder_spec ? { builderSpec: a.builder_spec } : {}),
			};
			return ok(await client.control("UpdateTemplate", body));
		},
	);

	// ── Delete ──────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_delete_template",
		"Delete a template by ID. Pass force to delete even when builds or dependents exist.",
		{
			template_id: z.string().describe("The template ID to delete."),
			force: z.boolean().optional().describe("Force deletion despite dependents (default false)."),
		},
		async ({ template_id, force }) =>
			ok(
				await client.control("DeleteTemplate", {
					templateId: template_id,
					...(force ? { force: true } : {}),
				}),
			),
	);

	// ── Build ───────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_build_template",
		"Trigger a build for a template, producing a bootable image. Returns the created build (poll it with tenki_get_template_build).",
		{
			template_id: z.string().describe("The template ID to build."),
			image_name: z.string().optional().describe("Name for the resulting image."),
			publish_raw_image: z.boolean().optional().describe("Publish the raw rootfs image alongside the build snapshot."),
			build_secrets: z.record(z.string()).optional().describe("Build-time secrets as a key→value object (not persisted into the image)."),
			build_env: z.record(z.string()).optional().describe("Per-build environment overrides frozen into this build only."),
		},
		async ({ template_id, image_name, publish_raw_image, build_secrets, build_env }) =>
			ok(
				await client.control("BuildTemplate", {
					templateId: template_id,
					...(image_name !== undefined ? { imageName: image_name } : {}),
					...(publish_raw_image !== undefined ? { publishRawImage: publish_raw_image } : {}),
					...(build_secrets && Object.keys(build_secrets).length ? { buildSecrets: build_secrets } : {}),
					...(build_env && Object.keys(build_env).length ? { buildEnv: build_env } : {}),
				}),
			),
	);

	// ── Cancel build ──────────────────────────────────────────────────────────────
	server.tool(
		"tenki_cancel_template_build",
		"Cancel an in-progress template build by its build ID.",
		{ build_id: z.string().describe("The template build ID to cancel.") },
		async ({ build_id }) => ok(await client.control("CancelTemplateBuild", { buildId: build_id })),
	);

	// ── Get build ─────────────────────────────────────────────────────────────────
	server.tool(
		"tenki_get_template_build",
		"Retrieve one template build by its build ID (state, progress, and result image).",
		{ build_id: z.string().describe("The template build ID.") },
		async ({ build_id }) => ok(await client.control("GetTemplateBuild", { buildId: build_id })),
	);

	// ── List active builds ──────────────────────────────────────────────────────────
	server.tool(
		"tenki_list_active_template_builds",
		"List the currently active (in-progress) builds for a given template.",
		{ template_id: z.string().describe("The template ID whose active builds to list.") },
		async ({ template_id }) => ok(await client.control("ListActiveTemplateBuilds", { templateId: template_id })),
	);

	server.tool(
		"tenki_list_project_templates",
		"List templates in a project (defaults to the key's first project). Supports pagination.",
		{
			project_id: z.string().optional().describe("Project to list (defaults to the key's first project)."),
			page_size: z.number().int().positive().optional(),
			page_token: z.string().optional(),
		},
		async ({ project_id, page_size, page_token }) => {
			const projectId = project_id ?? (await client.resolveOwner()).projectId;
			return ok(
				await client.control("ListProjectTemplates", {
					...(projectId ? { projectId } : {}),
					...(page_size ? { pageSize: page_size } : {}),
					...(page_token ? { pageToken: page_token } : {}),
				}),
			);
		},
	);
}