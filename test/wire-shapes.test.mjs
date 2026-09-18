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
	check("create_sandbox: no GetSession poll when the server returned RUNNING", !seen.has("GetSession"));

	// Contradictory or empty updates are rejected before any call
	{
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
