/**
 * Live verification of the parity domains against the real Tenki API.
 * Sends the SAME request bodies the tools send (owner-derived fields included).
 * Continue-on-error: every check runs, pass/fail collected, resources cleaned up.
 *   TENKI_API_KEY=… node scripts/verify-domains.mjs
 */
import { TenkiClient } from "../dist/client.js";

const token = process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY;
if (!token) { console.error("Set TENKI_API_KEY."); process.exit(1); }
const client = new TenkiClient(token, process.env.TENKI_API_ENDPOINT || undefined);

let pass = 0, fail = 0; const fails = [];
async function check(name, fn) {
	try { const r = await fn(); console.log(`  ✓ ${name}`); pass++; return r; }
	catch (e) { console.log(`  ✗ ${name}\n      ${(e?.message ?? e).toString().replace(/\s+/g, " ").slice(0, 220)}`); fail++; fails.push(name); return null; }
}

const owner = await client.resolveOwner();
const ws = owner.workspaceId, proj = owner.projectId;
console.log(`owner: ${owner.ownerType}/${owner.ownerId?.slice(0,8)} ws=${ws?.slice(0,8)} proj=${proj?.slice(0,8)}\n`);

console.log("── workspace + list ops (read-only, bodies as the tools send) ──");
await check("GetWorkspaceSandboxUsage", () => client.control("GetWorkspaceSandboxUsage", { workspaceId: ws }));
await check("GetWorkspaceSandboxSettings", () => client.control("GetWorkspaceSandboxSettings", { workspaceId: ws }));
await check("ListVolumes", () => client.control("ListVolumes", { workspaceId: ws }));
await check("ListSnapshots", () => client.control("ListSnapshots", {}));
await check("ListDanglingSnapshots", () => client.control("ListDanglingSnapshots", {}));
await check("ListTemplates", () => client.control("ListTemplates", { workspaceId: ws }));
await check("ListRegistryImages", () => client.control("ListRegistryImages", {}));
await check("ListWorkspaceSandboxes", () => client.control("ListWorkspaceSandboxes", { workspaceId: ws }));
await check("ListProjectSandboxes", () => client.control("ListProjectSandboxes", { projectId: proj }));

console.log("── volume lifecycle (create→get→update→resize→delete) ──");
const vlist = await client.control("ListVolumes", { workspaceId: ws }).catch(() => ({}));
const vols = vlist.volumes ?? [];
console.log(`  (workspace has ${vols.length} volume(s))`);
for (const v of vols) {
	const nm = v.name ?? ""; const id = v.id ?? v.volumeId;
	if (id && nm.startsWith("mcp-verify")) await client.control("DeleteVolume", { volumeId: id }).then(() => console.log(`  (cleaned leftover ${nm})`)).catch(() => {});
}
let volId;
const cv = await check("CreateVolume", () => client.control("CreateVolume", { workspaceId: ws, name: "mcp-verify-vol", sizeBytes: 1_048_576, ...(proj ? { projectId: proj } : {}) }));
volId = cv?.volume?.id ?? cv?.id ?? cv?.volumeId;
if (volId) {
	await check("GetVolume", () => client.control("GetVolume", { volumeId: volId }));
	await check("UpdateVolume (rename)", () => client.control("UpdateVolume", { volumeId: volId, name: "mcp-verify-vol-2" }));
	await check("ResizeVolume", () => client.control("ResizeVolume", { volumeId: volId, newSizeBytes: 2_097_152 }));
	await check("DeleteVolume", () => client.control("DeleteVolume", { volumeId: volId }));
} else console.log("  (skipped get/update/resize/delete — no volume id)");

console.log("── sandbox-scoped (allow_inbound for previews) ──");
let sid, snapId;
try {
	const created = await client.control("CreateSession", { cpuCores: 1, memoryMb: 1024, maxDuration: "600s", idleTimeoutMinutes: 5, allowInbound: true, allowOutbound: true,
		...(owner.ownerType ? { ownerType: owner.ownerType } : {}), ...(owner.ownerId ? { ownerId: owner.ownerId } : {}), ...(ws ? { workspaceId: ws } : {}), ...(proj ? { projectId: proj } : {}) });
	sid = (created.session ?? created).id ?? created.sessionId;
	await client.waitForState(sid, "RUNNING");
	console.log(`  (sandbox ${sid?.slice(0,8)} RUNNING)`);

	await check("data Mkdir", () => client.data(sid, "Mkdir", { path: "/home/tenki/vt", recursive: true }));
	await check("data Stat", () => client.data(sid, "Stat", { path: "/home/tenki/vt" }));
	await check("data Remove", () => client.data(sid, "Remove", { path: "/home/tenki/vt", recursive: true }));
	await check("ReportSessionActivity", () => client.control("ReportSessionActivity", { sessionId: sid }));
	await check("ExtendSession", () => client.control("ExtendSession", { sessionId: sid, additionalDuration: "60s" }));
	await check("UpdateSession (rename)", () => client.control("UpdateSession", { sessionId: sid, name: "mcp-verify" }));

	const cs = await check("CreateSnapshot", () => client.control("CreateSnapshot", { sessionId: sid, name: "mcp-verify-snap" }));
	snapId = cs?.snapshot?.id ?? cs?.id ?? cs?.snapshotId;
	if (snapId) {
		await check("GetSnapshot", () => client.control("GetSnapshot", { snapshotId: snapId }));
		await check("DeleteSnapshot", () => client.control("DeleteSnapshot", { snapshotId: snapId }));
	}

	// previews — bodies as the FIXED tools send them (projectId + slug)
	await check("ExposePort", () => client.control("ExposePort", { sessionId: sid, port: 8080 }));
	await check("CreatePreviewUrl", () => client.control("CreatePreviewUrl", { sessionId: sid, port: 8080, slug: "mcp-verify-preview", ...(proj ? { projectId: proj } : {}) }));
	await check("OpenPreview", () => client.control("OpenPreview", { sessionId: sid, port: 8080, ...(proj ? { projectId: proj } : {}) }));
	await check("ListPreviewUrls", () => client.control("ListPreviewUrls", { ...(proj ? { projectId: proj } : {}), sessionId: sid }));
	await check("UnexposePort", () => client.control("UnexposePort", { sessionId: sid, port: 8080 }));
} catch (e) {
	console.log("  ✗ sandbox setup failed:", (e?.message ?? e).toString().slice(0, 200)); fail++;
} finally {
	if (sid) { try { await client.control("TerminateSession", { sessionId: sid }); console.log(`  (terminated ${sid?.slice(0,8)})`); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fails.length) console.log("FAILED: " + fails.join(", "));
process.exitCode = fail ? 1 : 0;
