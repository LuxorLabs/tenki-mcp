import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { envSchema, listQuery, ok, protoEnum, searchSchema, tagsPatch, tagsSchema } from "./common.js";

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
		"Create a custom-image template (a reusable sandbox-image spec: base image + setup script + default resources). Build it into a bootable image later with tenki_build_template. NOTE: only a TYPED template (created with builder_spec, no legacy fields) can build a named, publishable image (image_name) that tenki_create_sandbox boots via its `image` arg.",
		{
			name: z.string().min(1).max(64).describe("Human-readable template name (1-64 chars)."),
			base_image_id: z.string().optional().describe("Base image ID to build on top of."),
			setup_script: z.string().optional().describe("Shell script run at build time to provision the image. Required for a from-scratch template (the API rejects a create without it unless you derive from a parent template/image)."),
			start_cmd: z.string().optional().describe("Command run when a sandbox boots from this template."),
			cpu_cores: z.number().int().min(1).max(128).optional().describe("Default vCPUs for sandboxes from this template (1-128; workspace plan may cap lower)."),
			memory_mb: z.number().int().min(512).max(524288).refine((n) => n % 2 === 0, "memory_mb must be even").optional().describe("Default memory in MB (512-524288, even)."),
			disk_size_gb: z.number().int().min(5).max(100).optional().describe("Default disk in GB (5-100)."),
			env_vars: envSchema,
			tags: tagsSchema.describe("Tags for later filtering (≤20, each ≤32 chars of a-z 0-9 _ : . -)."),
			parent_template_id: z.string().optional().describe("Derive this template from an existing template."),
			parent_image: z.string().optional().describe("Derive this template from an existing built image reference."),
			builder_spec: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Typed template spec, passed through as-is — e.g. {specVersion:'tenki.template.v1', base:{image:'sandbox'}, workdir:'/home/tenki', steps:[{run:{command:'...'}}], resources:{cpuCores,memoryMb,diskSizeGb}}. Mutually exclusive with base_image_id/setup_script/start_cmd/env_vars/cpu_cores/memory_mb/disk_size_gb/parent_* (the API rejects mixing). Required if the template's builds should publish an image (tenki_build_template image_name).",
				),
			workspace_id: z.string().optional().describe("Workspace to create in (defaults to the key's first workspace)."),
		},
		async (a) => {
			const owner = await client.resolveOwner();
			const workspaceId = a.workspace_id ?? owner.workspaceId;
			const resources = resourcesFrom(a.cpu_cores, a.memory_mb, a.disk_size_gb);
			const body: Record<string, unknown> = {
				...(workspaceId ? { workspaceId } : {}),
				name: a.name,
				...(a.base_image_id ? { baseImageId: a.base_image_id } : {}),
				...(a.setup_script !== undefined ? { setupScript: a.setup_script } : {}),
				...(a.start_cmd !== undefined ? { startCmd: a.start_cmd } : {}),
				...(a.env_vars && Object.keys(a.env_vars).length ? { envVars: a.env_vars } : {}),
				...(Object.keys(resources).length ? { resources } : {}),
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
		"List templates for the workspace with server-side search, build-state filter, tag filter, sorting and optional state-count facets.",
		{
			tags: z.array(z.string()).optional().describe("Only return templates that carry all of these tags."),
			search: searchSchema.describe("Free-text search over template name/id (max 256 chars)."),
			states: z
				.array(z.enum(["READY", "BUILDING", "PENDING", "FAILED", "UNBUILT"]))
				.max(16)
				.optional()
				.describe("Only templates whose latest build is in any of these states (UNBUILT = never built)."),
			sort_by: z.enum(["NAME", "CREATED_AT", "UPDATED_AT"]).optional().describe("Column to sort by."),
			sort_desc: z.boolean().optional().describe("Sort descending (default ascending)."),
			include_facets: z.boolean().optional().describe("Also return per-state counts for the same filter scope."),
			workspace_id: z.string().optional().describe("Workspace to list from (defaults to the key's first workspace)."),
			page_size: z.number().int().min(1).max(100).optional(),
			page_token: z.string().optional(),
		},
		async ({ tags, search, states, sort_by, sort_desc, include_facets, workspace_id, page_size, page_token }) => {
			const owner = await client.resolveOwner();
			const workspaceId = workspace_id ?? owner.workspaceId;
			return ok(
				await client.control("ListTemplates", {
					...(workspaceId ? { workspaceId } : {}),
					...(tags && tags.length ? { tags } : {}),
					...(states && states.length ? { states: states.map((s) => protoEnum("TEMPLATE_LIST_STATE", s)) } : {}),
					...(sort_by ? { sortBy: protoEnum("TEMPLATE_SORT_FIELD", sort_by) } : {}),
					...listQuery(search, include_facets, sort_desc),
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
			cpu_cores: z.number().int().min(1).max(128).optional().describe("New default vCPUs (1-128)."),
			memory_mb: z.number().int().min(512).max(524288).refine((n) => n % 2 === 0, "memory_mb must be even").optional().describe("New default memory in MB (512-524288, even)."),
			disk_size_gb: z.number().int().min(5).max(100).optional().describe("New default disk in GB (5-100)."),
			env_vars: envSchema,
			tags: tagsSchema.describe("Replacement tag list. Pass [] (or clear_tags) to remove all tags."),
			clear_tags: z.boolean().optional().describe("Remove all tags from the template."),
			builder_spec: z.record(z.string(), z.unknown()).optional().describe("Advanced structured build spec (TemplateBuildSpec); passed through as-is."),
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
				...tagsPatch(a.tags, a.clear_tags),
				...(a.builder_spec ? { builderSpec: a.builder_spec } : {}),
			};
			if (Object.keys(body).length === 1) {
				throw new Error("tenki_update_template: pass at least one field to change — nothing was sent.");
			}
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
		"Trigger a build for a template, producing a bootable image. Returns the created build — poll it with tenki_get_template_build until READY; the ready build's imageDigestRef is what tenki_create_sandbox's `image` arg takes.",
		{
			template_id: z.string().describe("The template ID to build."),
			image_name: z
				.string()
				.regex(/^[a-z][a-z0-9-]{0,63}$/, "lowercase letters, digits and hyphens; must start with a letter; max 64 chars")
				.optional()
				.describe("Name for the resulting image (^[a-z][a-z0-9-]{0,63}$). Requires a TYPED template (created with builder_spec) — the API rejects it for legacy setup-script templates."),
			publish_raw_image: z.boolean().optional().describe("Publish the raw rootfs image alongside the build snapshot."),
			build_secrets: z.record(z.string(), z.string()).optional().describe("Build-time secrets as a key→value object (not persisted into the image)."),
			build_env: z.record(z.string(), z.string()).optional().describe("Per-build environment overrides frozen into this build only."),
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
		"Retrieve one template build by its build ID (state, progress, and result image). A READY build's imageDigestRef is the reference tenki_create_sandbox's `image` arg takes.",
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

}
