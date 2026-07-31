/**
 * Regression test for the request-shape fixes (registry / touch_preview /
 * get_download_url). Drives the REAL MCP tools against live Tenki with bogus but
 * structurally-complete targets and asserts each reaches a SEMANTIC error
 * (not-found / permission), NOT a shape/validation error. A validation error
 * ("invalid_argument … required / must be / exactly one of") means the tool is
 * sending the wrong field names again.
 *
 *   npm run build && TENKI_API_KEY=… node test/registry-shapes.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadToken() {
	if (process.env.TENKI_API_KEY) return process.env.TENKI_API_KEY;
	if (process.env.TENKI_AUTH_TOKEN) return process.env.TENKI_AUTH_TOKEN;
	try {
		return (readFileSync(`${homedir()}/.config/tenki/config.yaml`, "utf8").match(/^auth_token:\s*(.+)$/m)?.[1] ?? "").trim();
	} catch {
		return "";
	}
}
const token = loadToken();
if (!token) { console.error("No token. Set TENKI_API_KEY or run `tenki login`."); process.exit(1); }

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
const SHAPE = /invalid_argument|is required|must be at least|must not be in list|unsupported.*kind|exactly one of|not a valid UUID/i;
const SEMANTIC = /not.?found|does not exist|no such|already|denied|forbidden|permission/i;

const U = (n) => `00000000-0000-7000-8000-00000000000${n}`;
let pass = 0, fail = 0;

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, TENKI_API_KEY: token }, stderr: "ignore" });
const client = new Client({ name: "shape-regression", version: "1.0.0" });

/** Call a tool with a bogus target; pass if it reaches a semantic (not shape) error, or succeeds. */
async function probe(name, args) {
	let msg = "";
	try {
		const r = await client.callTool({ name, arguments: args });
		if (r.isError) msg = r.content?.find((c) => c.type === "text")?.text ?? "";
		else { console.log(`  ✓ ${name} → 200 (accepted)`); pass++; return; }
	} catch (e) { msg = e?.message ?? String(e); }
	const flat = msg.replace(/\s+/g, " ");
	if (SHAPE.test(flat) && !SEMANTIC.test(flat)) { console.log(`  ✗ ${name} — SHAPE STILL WRONG: ${flat.slice(0, 90)}`); fail++; }
	else { console.log(`  ✓ ${name} → clean semantic error`); pass++; }
}

try {
	await client.connect(transport);
	const owner = JSON.parse((await client.callTool({ name: "tenki_whoami", arguments: {} })).content[0].text);
	const ws = owner.workspaces?.[0]?.workspaceId;

	await probe("tenki_get_image", { reference: "noone/nope" });
	await probe("tenki_resolve_image_ref", { registry_ref: "noone/nope:latest" });
	await probe("tenki_set_image_visibility", { reference: "noone/nope", visibility: "private" });
	await probe("tenki_delete_image", { reference: "noone/nope" });
	await probe("tenki_delete_image", { image_id: U(0), snapshot_id: U(1) });
	await probe("tenki_share_image", { reference: "noone/nope", grantee_workspace_id: ws ?? U(2) });
	await probe("tenki_unshare_image", { reference: "noone/nope", grant_id: U(3) });
	await probe("tenki_revoke_image_share_grant", { grant_id: U(4) });
	await probe("tenki_list_image_share_grants", { reference: "noone/nope" });
	await probe("tenki_publish_image", { reference: "noone/nope", kind: "snapshot", snapshot_id: U(5) });
	await probe("tenki_touch_preview", { preview_token: "nonexistent-token-123" });

	// get_download_url needs a live session
	const created = await client.callTool({ name: "tenki_create_sandbox", arguments: { cpu_cores: 1, memory_mb: 1024, max_duration_seconds: 300, wait_ready: false } });
	const sid = JSON.parse(created.content[0].text).session?.id;
	await probe("tenki_get_download_url", { session_id: sid, artifact_id: U(6) });
	if (sid) await client.callTool({ name: "tenki_terminate_sandbox", arguments: { session_id: sid } }).catch(() => {});

	await client.close();
} catch (e) {
	console.error("  ✗ " + (e?.message ?? e));
	fail++;
	try { await client.close(); } catch { /* ignore */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
