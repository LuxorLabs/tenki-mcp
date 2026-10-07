/**
 * OFFLINE wire-shape suite — spawns the server against a local control-plane
 * stub and asserts the EXACT JSON body each tool puts on the wire. The API
 * discards unknown fields silently (connect-go protojson DiscardUnknown), so a
 * misnamed field is a silent no-op, not an error: `readOnly` instead of
 * `readonly` mounted every volume read-write, `idleTimeoutMinutes` on
 * UpdateSession did nothing, `workspaceId` on ListActiveSSHGateways did nothing.
 * Field names here are the proto's lowerCamelCase JSON names — check them
 * against tenki-app proto/tenki/sandbox/v1/*.proto when they change.
 *
 *   npm run build && node test/wire-shapes.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

const WS = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const VOL = "33333333-3333-4333-8333-333333333333";
const SNAP = "44444444-4444-4444-8444-444444444444";
const PREV = "55555555-5555-4555-8555-555555555555";

/** Method → recorded request bodies (in call order). */
const seen = new Map();
const record = (method, body) => seen.set(method, [...(seen.get(method) ?? []), body]);
const last = (method) => (seen.get(method) ?? []).at(-1);

const REPLIES = {
	WhoAmI: { ownerType: "USER", ownerId: "u1", workspaces: [{ workspaceId: WS, name: "ws" }] },
	CreateSession: { session: { id: SID, state: "SESSION_STATE_RUNNING" }, dataPlaneEndpoint: "http://127.0.0.1:1", warnings: [{ code: "SANDBOX_WARNING_CODE_MAX_DURATION_CAPPED", message: "capped" }] },
	UpdateSession: { session: { id: SID }, warnings: [] },
	GetSession: { session: { id: SID, state: "SESSION_STATE_RUNNING", sticky: false } },
	ListActiveSSHGateways: { gateways: [] },
	ListPreviewUrls: {},
};

const stub = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const method = req.url.split("/").pop();
		record(method, raw ? JSON.parse(raw) : {});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(REPLIES[method] ?? {}));
	});
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${stub.address().port}`;

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER],
	env: { ...process.env, TENKI_API_KEY: "tk_wire_dummy", TENKI_API_ENDPOINT: endpoint },
	stderr: "ignore",
});
const client = new Client({ name: "wire-shapes", version: "1.0.0" });
const call = (name, args) => client.callTool({ name, arguments: args });
const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

try {
	await client.connect(transport);

	// UpdateSession: max_duration implies sticky:false; [] clears via clear_tags; no idle field exists
	await call("tenki_update_sandbox", { session_id: SID, max_duration_seconds: 900, tags: [] });
	let b = last("UpdateSession");
	check("update_sandbox: max_duration_seconds → maxDuration '900s' + sticky:false", b?.maxDuration === "900s" && b?.sticky === false, JSON.stringify(b));
	check("update_sandbox: looked the sandbox up before defaulting sticky:false", (seen.get("GetSession") ?? []).length === 1);
	REPLIES.GetSession = { session: { id: SID, state: "SESSION_STATE_RUNNING", sticky: true } };
	const stickyRefused = await call("tenki_update_sandbox", { session_id: SID, max_duration_seconds: 900 });
	check("update_sandbox: max_duration on a STICKY sandbox is refused without explicit sticky", stickyRefused.isError === true && /sticky/.test(text(stickyRefused)) && (seen.get("UpdateSession") ?? []).length === 1, text(stickyRefused).slice(0, 120));
	REPLIES.GetSession = { session: { id: SID, state: "SESSION_STATE_RUNNING", sticky: false } };
	check("update_sandbox: tags [] → clearTags:true and no empty tags array", b?.clearTags === true && !("tags" in (b ?? {})), JSON.stringify(b));
	check("update_sandbox: never sends idleTimeoutMinutes", !("idleTimeoutMinutes" in (b ?? {})));
	await call("tenki_update_sandbox", { session_id: SID, sticky: true, max_duration_seconds: 900 });
	b = last("UpdateSession");
	check("update_sandbox: explicit sticky:true is not overridden", b?.sticky === true, JSON.stringify(b));

	// AttachVolume: proto field is `readonly`
	await call("tenki_attach_volume", { session_id: SID, volume_id: VOL, mount_path: "/mnt/x", read_only: true });
	b = last("AttachVolume");
	check("attach_volume: read_only → volume.readonly (not readOnly)", b?.volume?.readonly === true && !("readOnly" in (b?.volume ?? {})), JSON.stringify(b));
	check("attach_volume: nests volumeId + mountPath under volume", b?.volume?.volumeId === VOL && b?.volume?.mountPath === "/mnt/x");

	// DetachVolume: force → forceDetach
	await call("tenki_detach_volume", { session_id: SID, volume_id: VOL, force: true });
	check("detach_volume: force → forceDetach:true", last("DetachVolume")?.forceDetach === true, JSON.stringify(last("DetachVolume")));

	// ListActiveSSHGateways: region / sessionId only
	await call("tenki_list_ssh_gateways", { region: "us", session_id: SID });
	b = last("ListActiveSSHGateways");
	check("list_ssh_gateways: sends region + sessionId, never workspaceId", b?.region === "us" && b?.sessionId === SID && !("workspaceId" in (b ?? {})), JSON.stringify(b));

	// GetArtifactDownloadUrl: artifactId only
	await call("tenki_get_download_url", { artifact_id: SNAP, session_id: SID });
	b = last("GetArtifactDownloadUrl");
	check("get_download_url: sends artifactId only (sessionId dropped)", b?.artifactId === SNAP && !("sessionId" in (b ?? {})), JSON.stringify(b));

	// ListPreviewUrls: server-side sessionId filter
	const lp = await call("tenki_list_preview_urls", { session_id: SID, page_size: 5 });
	b = last("ListPreviewUrls");
	check("list_preview_urls: sessionId sent server-side", b?.sessionId === SID && b?.pageSize === 5, JSON.stringify(b));
	check("list_preview_urls: no WhoAmI / workspaceId when session_id scopes the query", !("workspaceId" in (b ?? {})) && !seen.has("WhoAmI"));
	check("list_preview_urls: empty page normalizes to previewUrls []", /"previewUrls":\s*\[\]/.test(text(lp)), text(lp));

	// GetPreviewUrl: oneof id | slug
	await call("tenki_get_preview_url", { slug: "my-app" });
	check("get_preview_url: slug lookup sends slug only", last("GetPreviewUrl")?.slug === "my-app" && !("previewUrlId" in last("GetPreviewUrl")));
	await call("tenki_get_preview_url", { preview_url_id: PREV });
	check("get_preview_url: id lookup sends previewUrlId only", last("GetPreviewUrl")?.previewUrlId === PREV && !("slug" in last("GetPreviewUrl")));

	// BindPreviewUrl / ExposePort: expiresAt
	await call("tenki_bind_preview_url", { preview_url_id: PREV, session_id: SID, port: 8080, expires_at: "2030-01-01T00:00:00Z" });
	check("bind_preview_url: expires_at → expiresAt", last("BindPreviewUrl")?.expiresAt === "2030-01-01T00:00:00Z");
	await call("tenki_expose_port", { session_id: SID, port: 8080, expires_at: "2030-01-01T00:00:00Z" });
	check("expose_port: expires_at → expiresAt", last("ExposePort")?.expiresAt === "2030-01-01T00:00:00Z");

	// PauseSession / CreateSnapshot: async
	await call("tenki_pause_sandbox", { session_id: SID, async: true });
	check("pause_sandbox: async → async:true", last("PauseSession")?.async === true);
	await call("tenki_create_snapshot", { session_id: SID, async: true, name: "s" });
	check("create_snapshot: async → async:true", last("CreateSnapshot")?.async === true);

	// UpdateSnapshot: clear flags + tags
	await call("tenki_update_snapshot", { snapshot_id: SNAP, clear_expires_at: true, tags: ["a", "b"] });
	b = last("UpdateSnapshot");
	check("update_snapshot: clear_expires_at → clearExpiresAt, tags passed", b?.clearExpiresAt === true && Array.isArray(b?.tags) && b.tags.length === 2, JSON.stringify(b));

	// UpdateVolume: tags/clear
	await call("tenki_update_volume", { volume_id: VOL, tags: [] });
	check("update_volume: tags [] → clearTags:true", last("UpdateVolume")?.clearTags === true && !("tags" in last("UpdateVolume")));

	// GetSessionMetrics: window as Duration string
	await call("tenki_get_sandbox_metrics", { session_id: SID, window_seconds: 300 });
	check("get_sandbox_metrics: window_seconds → window '300s'", last("GetSessionMetrics")?.window === "300s" && last("GetSessionMetrics")?.sessionId === SID);

	// Mkdir (data plane is unreachable here, so only check the call fails cleanly, not the body)

	// CreateSession: explicit false flags, waitReady, egress, volumes.readonly, warnings surfaced
	const cr = await call("tenki_create_sandbox", {
		allow_inbound: false,
		allow_outbound: true,
		egress_allow_domains: ["*.pypi.org"],
		volumes: [{ volume_id: VOL, mount_path: "/mnt/data", read_only: true }],
		sticky: false,
		idle_timeout_minutes: 0,
		memory_mb: 2048,
	});
	b = last("CreateSession");
	check("create_sandbox: explicit allow_inbound:false is SENT", b?.allowInbound === false, JSON.stringify(b));
	check("create_sandbox: allow_outbound:true sent", b?.allowOutbound === true);
	check("create_sandbox: egress allowlist → egress.allowDomains", Array.isArray(b?.egress?.allowDomains) && b.egress.allowDomains[0] === "*.pypi.org");
	check("create_sandbox: volumes[].read_only → readonly", b?.volumes?.[0]?.readonly === true && b?.volumes?.[0]?.volumeId === VOL);
	check("create_sandbox: sticky:false sent explicitly", b?.sticky === false);
	check("create_sandbox: idle_timeout_minutes 0 is sent (not dropped as falsy)", b?.idleTimeoutMinutes === 0);
	check("create_sandbox: waitReady:true asks the server to hold until RUNNING", b?.waitReady === true);
	check("create_sandbox: workspaceId resolved from WhoAmI", b?.workspaceId === WS);
	check("create_sandbox: API warnings surfaced in the result", /MAX_DURATION_CAPPED/.test(text(cr)), text(cr).slice(0, 200));
	check("create_sandbox: no GetSession poll when the server returned RUNNING", (seen.get("GetSession") ?? []).length === 2);

	// Server-side list search / state filters / sort / facets (tenki-app #5747) use proto enum names
	{
		await call("tenki_list_workspace_sandboxes", { search: " web ", states: ["RUNNING", "PAUSED"], state: "RUNNING", order: "STATE_THEN_CREATED", sort_by: "CREATED_AT", sort_desc: true, include_facets: true, page_size: 10 });
		const ls = last("ListWorkspaceSandboxes");
		check("list_workspace_sandboxes: search trimmed, states/state/order/sortBy carry proto enum prefixes", ls?.search === "web" && ls?.states?.[1] === "SESSION_STATE_PAUSED" && ls?.state === "SESSION_STATE_RUNNING" && ls?.order === "SANDBOX_LIST_ORDER_STATE_THEN_CREATED" && ls?.sortBy === "SANDBOX_SORT_FIELD_CREATED_AT" && ls?.sortDesc === true && ls?.includeFacets === true, JSON.stringify(ls));
		await call("tenki_list_volumes", { states: ["IN_USE"], sort_by: "SIZE_BYTES", search: "data" });
		check("list_volumes: VOLUME_STATE_ / VOLUME_SORT_FIELD_ prefixes + search", last("ListVolumes")?.states?.[0] === "VOLUME_STATE_IN_USE" && last("ListVolumes")?.sortBy === "VOLUME_SORT_FIELD_SIZE_BYTES" && last("ListVolumes")?.search === "data", JSON.stringify(last("ListVolumes")));
		await call("tenki_list_templates", { states: ["UNBUILT", "FAILED"], sort_by: "UPDATED_AT", sort_desc: true });
		check("list_templates: TEMPLATE_LIST_STATE_ / TEMPLATE_SORT_FIELD_ prefixes", last("ListTemplates")?.states?.[0] === "TEMPLATE_LIST_STATE_UNBUILT" && last("ListTemplates")?.sortBy === "TEMPLATE_SORT_FIELD_UPDATED_AT" && last("ListTemplates")?.sortDesc === true, JSON.stringify(last("ListTemplates")));
		await call("tenki_list_preview_urls", { states: ["ORPHANED"], sort_by: "SLUG", include_facets: true });
		check("list_preview_urls: PREVIEW_URL_BINDING_STATE_ / PREVIEW_URL_SORT_FIELD_ prefixes", last("ListPreviewUrls")?.states?.[0] === "PREVIEW_URL_BINDING_STATE_ORPHANED" && last("ListPreviewUrls")?.sortBy === "PREVIEW_URL_SORT_FIELD_SLUG" && last("ListPreviewUrls")?.includeFacets === true, JSON.stringify(last("ListPreviewUrls")));
		check("list tools omit search/sort/facet fields when not given", !("search" in (seen.get("ListPreviewUrls")?.[0] ?? {})) && !("sortBy" in (seen.get("ListPreviewUrls")?.[0] ?? {})));
	}

	// Workspace-secret injection on create (tenki-app #5707 / #5848 / #5849) + raised VM ceilings (#5832)
	{
		await call("tenki_create_sandbox", {
			cpu_cores: 64,
			memory_mb: 262144,
			secret_files: [
				{ path: "/home/tenki/.npmrc", secret_name: "npm-token" },
				{ path: "/home/tenki/hello.txt", content: "hi" },
			],
			secret_policies: ["github-readonly", "npm-publish"],
			tailnet: { auth_key: "tskey-auth-k1-SECRET", hostname: "build-box", tags: ["tag:ci"], ephemeral: true, expose_ports: [8080], exit_node: "exit-1", exit_policy: "EXIT_NODE_MANAGED" },
		});
		const cs = last("CreateSession");
		check("create_sandbox: 64 vCPU / 256 GiB accepted (API ceiling 128 / 512 GiB)", cs?.cpuCores === 64 && cs?.memoryMb === 262144, JSON.stringify({ c: cs?.cpuCores, m: cs?.memoryMb }));
		check("create_sandbox: secret_files → secretFiles[{path, raw:{name}} | {path, content}]", cs?.secretFiles?.[0]?.raw?.name === "npm-token" && cs?.secretFiles?.[0]?.path === "/home/tenki/.npmrc" && cs?.secretFiles?.[1]?.content === "hi" && !("raw" in (cs?.secretFiles?.[1] ?? {})), JSON.stringify(cs?.secretFiles));
		check("create_sandbox: secret_policies → secretPolicies (names only; SecretRequestBinding was removed upstream in #5913)", Array.isArray(cs?.secretPolicies) && cs.secretPolicies[1] === "npm-publish" && !("secretRequests" in (cs ?? {})), JSON.stringify(cs?.secretPolicies));
		check("create_sandbox: tailnet → authKey, provider omitted when unset, exitNode + enum prefix", cs?.tailnet?.authKey === "tskey-auth-k1-SECRET" && !("provider" in (cs?.tailnet ?? {})) && cs?.tailnet?.hostname === "build-box" && cs?.tailnet?.tags?.[0] === "tag:ci" && cs?.tailnet?.ephemeral === true && cs?.tailnet?.exposePorts?.[0] === 8080 && cs?.tailnet?.exitNode === "exit-1" && cs?.tailnet?.exitPolicy === "TAILNET_EXIT_POLICY_EXIT_NODE_MANAGED" && !("wakeOnConnect" in (cs?.tailnet ?? {})) && !("ephemeralPausePolicy" in (cs?.tailnet ?? {})), JSON.stringify(cs?.tailnet));
		const noExit = await call("tenki_create_sandbox", { tailnet: { auth_key: "tskey-x", exit_policy: "EXIT_NODE_MANAGED" } });
		check("create_sandbox: EXIT_NODE_MANAGED without exit_node rejected pre-network", noExit.isError === true && /requires exit_node/.test(text(noExit)));
		const dupTag = await call("tenki_create_sandbox", { tailnet: { auth_key: "tskey-x", tags: ["tag:ci", "tag:ci"] } });
		check("create_sandbox: duplicate tailnet tags rejected pre-network", dupTag.isError === true && /unique/.test(text(dupTag)));
		const httpUrl = await call("tenki_create_sandbox", { tailnet: { auth_key: "tskey-x", control_url: "http://headscale.local" } });
		check("create_sandbox: non-https control_url rejected pre-network", httpUrl.isError === true && /https/.test(text(httpUrl)));
		const badPolicy = await call("tenki_create_sandbox", { secret_policies: ["github readonly"] });
		check("create_sandbox: secret policy name with a space rejected pre-network", badPolicy.isError === true && /policy names/.test(text(badPolicy)));
		const badTag = await call("tenki_create_sandbox", { tailnet: { auth_key: "tskey-x", tags: ["ci"] } });
		check("create_sandbox: tailnet tag without tag: prefix rejected pre-network", badTag.isError === true && /tag:name/.test(text(badTag)));
		const bad = await call("tenki_create_sandbox", { secret_files: [{ path: "/x", secret_name: "a", content: "b" }] });
		check("create_sandbox: a secret file with both secret_name and content is rejected pre-network", bad.isError === true && /exactly one of secret_name or content/.test(text(bad)));
		const over = await call("tenki_create_sandbox", { cpu_cores: 129 });
		check("create_sandbox: cpu_cores 129 rejected pre-network (ceiling 128)", over.isError === true && /128/.test(text(over)));
	}

	// Contradictory or empty updates are rejected before any call
	{
		const e1 = await call("tenki_update_snapshot", { snapshot_id: SNAP, expires_at: "2030-01-01T00:00:00Z", clear_expires_at: true });
		check("update_snapshot: expires_at + clear_expires_at is rejected", e1.isError === true && /not both/.test(text(e1)));
		const e2 = await call("tenki_create_sandbox", { egress_allow_domains: ["*.pypi.org"] });
		check("create_sandbox: egress allowlist without allow_outbound is rejected pre-network", e2.isError === true && /allow_outbound: true/.test(text(e2)));
		const e3 = await call("tenki_get_preview_url", { preview_url_id: "" });
		check("get_preview_url: empty preview_url_id rejected pre-network", e3.isError === true && !/exactly one/.test(text(e3)) && (seen.get("GetPreviewUrl") ?? []).length === 2);
		await call("tenki_update_template", { template_id: SNAP, tags: [] });
		check("update_template: tags [] → clearTags:true", last("UpdateTemplate")?.clearTags === true && !("tags" in last("UpdateTemplate")));
		const e4 = await call("tenki_update_template", { template_id: SNAP });
		check("update_template: no fields → rejected", e4.isError === true && /at least one field/.test(text(e4)));
		const before = (seen.get("UpdateSession") ?? []).length;
		const r1 = await call("tenki_update_sandbox", { session_id: SID, tags: ["a"], clear_tags: true });
		check("update_sandbox: tags + clear_tags is rejected (clear would silently win)", r1.isError === true && /not both/.test(text(r1)) && (seen.get("UpdateSession") ?? []).length === before, text(r1).slice(0, 120));
		const r2 = await call("tenki_update_sandbox", { session_id: SID });
		check("update_sandbox: no fields → rejected, nothing sent", r2.isError === true && /at least one field/.test(text(r2)) && (seen.get("UpdateSession") ?? []).length === before, text(r2).slice(0, 120));
		const r3 = await call("tenki_update_snapshot", { snapshot_id: SNAP });
		check("update_snapshot: no fields → rejected", r3.isError === true && /at least one field/.test(text(r3)));
		const r4 = await call("tenki_get_sandbox_metrics", { session_id: SID, window_seconds: 30 });
		check("get_sandbox_metrics: window under 60s rejected pre-network", r4.isError === true && /60/.test(text(r4)));
	}

	// Template build history / delete: templateId and buildId on the wire
	await call("tenki_list_template_builds", { template_id: SNAP });
	check("list_template_builds: sends templateId", last("ListTemplateBuilds")?.templateId === SNAP, JSON.stringify(last("ListTemplateBuilds")));
	await call("tenki_delete_template_build", { build_id: VOL });
	check("delete_template_build: sends buildId", last("DeleteTemplateBuild")?.buildId === VOL, JSON.stringify(last("DeleteTemplateBuild")));

	// Removed workspace-settings RPCs are never called
	check("no tool calls a removed workspace-settings RPC", ![...seen.keys()].some((m) => /WorkspaceSandboxSettings|SnapshotRetentionSettings/.test(m)));
} catch (e) {
	console.error("  ✗ " + (e?.message ?? e));
	fail++;
} finally {
	try { await client.close(); } catch { /* ignore */ }
	stub.closeAllConnections?.();
	stub.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
