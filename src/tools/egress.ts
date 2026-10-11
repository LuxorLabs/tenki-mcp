import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TenkiClient } from "../client.js";
import { ok } from "./common.js";

/**
 * Named workspace egress policies (tenki-app #6069): reusable egress allowlists
 * that tenki_create_sandbox pins by name via `egress_policies`. A session keeps
 * the expansion it was created with; later edits or deletes do not change it.
 * Wire shape: SessionEgressPolicy { allowDomains, allowCidrs, interceptHttps,
 * httpRules[{ domains, methods, exact | prefix | regex }] } — the path oneof
 * members are plain fields on the rule.
 */

const POLICY_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const policyNameSchema = z
	.string()
	.regex(POLICY_NAME, "policy names: letters, digits, _ and -, starting with a letter or _, max 128");

const domainSchema = z.string().min(1).max(253);
const pathSchema = z.string().min(1).max(2048).regex(/^\//, "paths start with /");

export const httpRuleSchema = z
	.object({
		domains: z
			.array(domainSchema)
			.min(1)
			.max(256)
			.describe("Hosts the rule applies to: exact names, single-label '*.example.com' wildcards, or '*' for every allowed domain."),
		methods: z
			.array(z.string().min(1).max(32))
			.max(16)
			.optional()
			.describe("HTTP methods (e.g. GET, POST; uppercased by the API). Omit to match every method."),
		path_exact: pathSchema.optional().describe("Match only this escaped path (no query)."),
		path_prefix: pathSchema.optional().describe("Match paths starting with this prefix."),
		path_regex: z.string().min(1).max(1024).optional().describe("RE2 regex that must match the whole escaped path (no query)."),
	})
	.strict()
	.refine((r) => [r.path_exact, r.path_prefix, r.path_regex].filter((p) => p !== undefined).length <= 1, {
		message: "set at most one of path_exact, path_prefix, path_regex",
	});

export type HttpRule = z.infer<typeof httpRuleSchema>;

export const httpRuleToWire = (r: HttpRule): Record<string, unknown> => ({
	domains: r.domains,
	...(r.methods?.length ? { methods: r.methods } : {}),
	...(r.path_exact !== undefined ? { exact: r.path_exact } : {}),
	...(r.path_prefix !== undefined ? { prefix: r.path_prefix } : {}),
	...(r.path_regex !== undefined ? { regex: r.path_regex } : {}),
});

export const allowDomainsSchema = z
	.array(domainSchema)
	.max(256)
	.describe("Allowed hosts: exact names or single-label '*.example.com' wildcards (≤256).");
export const allowCidrsSchema = z
	.array(z.string().min(1).max(18))
	.max(64)
	.describe("Allowed IPv4 prefixes reachable without a name lookup (≤64; not 0.0.0.0/0).");
export const interceptHttpsSchema = z
	.boolean()
	.describe("Terminate port-443 TLS with the sandbox's managed CA so each request's Host is checked; requires at least one allowed domain.");
export const httpRulesSchema = z
	.array(httpRuleSchema)
	.max(64)
	.describe("Per-host HTTP method/path rules (≤64; requires intercept_https). On ports 80 and 443 a request matching no rule is refused with 403.");

export interface EgressBody {
	allow_domains?: string[];
	allow_cidrs?: string[];
	intercept_https?: boolean;
	http_rules?: HttpRule[];
}

/**
 * Map an egress body to SessionEgressPolicy JSON. `requireComplete` applies the
 * checks the API runs on a policy that stands alone; on create they are skipped
 * when named policies are pinned, because the API merges them first.
 */
export function egressBodyToWire(tool: string, b: EgressBody, requireComplete: boolean): Record<string, unknown> | undefined {
	const domains = b.allow_domains?.length ? b.allow_domains : undefined;
	const cidrs = b.allow_cidrs?.length ? b.allow_cidrs : undefined;
	const rules = b.http_rules?.length ? b.http_rules : undefined;
	if (requireComplete) {
		if (!domains && !cidrs && (b.intercept_https || rules)) throw new Error(`${tool}: an egress policy must list at least one allowed domain or CIDR.`);
		if (b.intercept_https && !domains) throw new Error(`${tool}: intercept_https requires at least one allowed domain.`);
		if (rules && !b.intercept_https) throw new Error(`${tool}: http_rules require intercept_https: true (without interception HTTPS requests would bypass them).`);
	}
	if (!domains && !cidrs && !b.intercept_https && !rules) return undefined;
	return {
		...(domains ? { allowDomains: domains } : {}),
		...(cidrs ? { allowCidrs: cidrs } : {}),
		...(b.intercept_https ? { interceptHttps: true } : {}),
		...(rules ? { httpRules: rules.map(httpRuleToWire) } : {}),
	};
}

const workspaceIdSchema = z.string().optional().describe("Workspace (defaults to the key's workspace).");
const policyRefSchema = z.string().min(1).describe("Policy ID or name.");
const revisionSchema = z
	.number()
	.int()
	.min(1)
	.max(4294967295)
	.describe("The policy's current revision (from tenki_get_egress_policy); a stale revision is refused with ABORTED.");
const ENABLE_NOTE =
	"Sandboxes cannot pin policies (failed_precondition) if session egress policies are disabled for the workspace (on by default; Tenki staff can turn it off).";

export function registerEgress(server: McpServer, client: TenkiClient): void {
	const workspace = async (workspace_id?: string) => {
		const id = workspace_id ?? (await client.resolveOwner()).workspaceId;
		return id ? { workspaceId: id } : {};
	};
	const body = (tool: string, b: EgressBody) => {
		const egress = egressBodyToWire(tool, b, true);
		if (!egress) throw new Error(`${tool}: an egress policy must list at least one allowed domain or CIDR.`);
		return egress;
	};

	server.tool(
		"tenki_create_egress_policy",
		`Save a named egress policy (allowed domains/CIDRs, optional HTTPS interception and per-host HTTP rules) in the workspace, for tenki_create_sandbox's egress_policies to pin by name. ${ENABLE_NOTE}`,
		{
			name: policyNameSchema.refine((n) => !UUID.test(n), "a policy name must not be a UUID").describe("Policy name (letters, digits, _ and -; not a UUID). Exact, never trimmed."),
			allow_domains: allowDomainsSchema.optional(),
			allow_cidrs: allowCidrsSchema.optional(),
			intercept_https: interceptHttpsSchema.optional(),
			http_rules: httpRulesSchema.optional(),
			workspace_id: workspaceIdSchema,
		},
		async ({ name, workspace_id, ...b }) =>
			ok(await client.control("CreateEgressPolicy", { ...(await workspace(workspace_id)), name, egress: body("tenki_create_egress_policy", b) })),
	);

	server.tool(
		"tenki_update_egress_policy",
		"Replace a named egress policy's rules (the whole body; omitted fields are cleared). Requires the current revision. Sandboxes created earlier keep the rules they were created with.",
		{
			policy_id: policyRefSchema,
			expected_revision: revisionSchema,
			allow_domains: allowDomainsSchema.optional(),
			allow_cidrs: allowCidrsSchema.optional(),
			intercept_https: interceptHttpsSchema.optional(),
			http_rules: httpRulesSchema.optional(),
			workspace_id: workspaceIdSchema,
		},
		async ({ policy_id, expected_revision, workspace_id, ...b }) =>
			ok(
				await client.control("UpdateEgressPolicy", {
					...(await workspace(workspace_id)),
					policyId: policy_id,
					expectedRevision: expected_revision,
					egress: body("tenki_update_egress_policy", b),
				}),
			),
	);

	server.tool(
		"tenki_get_egress_policy",
		"Get one named egress policy by ID or name: its rules, current revision, and how many non-terminated sandboxes pinned it.",
		{ policy_id: policyRefSchema, workspace_id: workspaceIdSchema },
		async ({ policy_id, workspace_id }) => ok(await client.control("GetEgressPolicy", { ...(await workspace(workspace_id)), policyId: policy_id })),
	);

	server.tool(
		"tenki_list_egress_policies",
		"List the workspace's named egress policies, ordered by name. Pass next_cursor back as cursor for the next page.",
		{
			page_size: z.number().int().min(1).max(100).optional().describe("Max policies per page (≤100, default 50)."),
			cursor: z.string().optional().describe("next_cursor from the previous page."),
			workspace_id: workspaceIdSchema,
		},
		async ({ page_size, cursor, workspace_id }) =>
			ok(
				await client.control("ListEgressPolicies", {
					...(await workspace(workspace_id)),
					...(page_size ? { pageSize: page_size } : {}),
					...(cursor ? { cursor } : {}),
				}),
			),
	);

	server.tool(
		"tenki_delete_egress_policy",
		"Delete a named egress policy (requires its current revision). New sandboxes can no longer pin it; sandboxes that already pinned it keep its rules.",
		{ policy_id: policyRefSchema, expected_revision: revisionSchema, workspace_id: workspaceIdSchema },
		async ({ policy_id, expected_revision, workspace_id }) =>
			ok(
				await client.control("DeleteEgressPolicy", {
					...(await workspace(workspace_id)),
					policyId: policy_id,
					expectedRevision: expected_revision,
				}),
			),
	);
}
