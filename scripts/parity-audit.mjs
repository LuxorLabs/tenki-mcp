/**
 * Parity audit — the "full API parity" gate.
 *
 * Enumerates every unary method of the public Tenki API (SandboxService,
 * SandboxSessionDataPlaneService, SSHGatewayClientService as declared in
 * tenki-app `proto/tenki/sandbox/v1/*.proto`) and fails if any TOOL-worthy
 * method is not covered by a registered MCP tool, or if a tool calls a method
 * that is not in the surface at all (removed upstream → the tool can only 404).
 * Methods the API marks `option deprecated = true` are listed in DEPRECATED:
 * covering them is allowed but reported, so a migration is never silent.
 *
 *   node scripts/parity-audit.mjs        # exits 1 if any gap / unknown method
 *
 * Coverage is detected by grepping src/tools/*.ts for client.control("X") /
 * client.data(_, "X") calls, plus HELPER_COVERAGE for methods a tool reaches
 * through a client helper (e.g. read_file → ReadFile via client.readTextFile).
 *
 * Surface last synced to tenki-app origin/main 7685be8cba (2026-09-18). When the
 * proto changes, update SURFACE / DEPRECATED here in the same PR.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, "..", "src", "tools");

// ── Canonical method surface ──────────────────────────────────────────────────
// TOOL     → must be covered by a tool
// V2       → streaming/interactive, deferred (needs an HTTP/2 Connect-streaming transport)
// INTERNAL → transport plumbing or a surface deliberately kept out of the MCP (registry images: tenki-mcp #27)
const SURFACE = {
	SandboxService: {
		CreateSession: "TOOL", GetSession: "TOOL", GetSessionMetrics: "TOOL", ListSessions: "TOOL", ListWorkspaceSandboxes: "TOOL",
		UpdateSession: "TOOL", PauseSession: "TOOL", ResumeSession: "TOOL",
		ExtendSession: "TOOL", TerminateSession: "TOOL", TerminateSessions: "TOOL", ReportSessionActivity: "TOOL",
		WaitSession: "V2", CreateSessionCredential: "INTERNAL",
		ExecuteCommand: "TOOL", StreamCommandOutput: "V2", GitOperation: "TOOL",
		GetArtifactUploadUrl: "TOOL", GetArtifactDownloadUrl: "TOOL",
		ExposePort: "TOOL", UnexposePort: "TOOL", ListExposedPorts: "TOOL", OpenPreview: "TOOL", TouchPreview: "TOOL",
		CreatePreviewUrl: "TOOL", DeletePreviewUrl: "TOOL", GetPreviewUrl: "TOOL", ListPreviewUrls: "TOOL",
		BindPreviewUrl: "TOOL", UnbindPreviewUrl: "TOOL", ResolvePreviewToken: "TOOL",
		UpdateSSHAuthorizedKeys: "TOOL",
		CreateVolume: "TOOL", GetVolume: "TOOL", ListVolumes: "TOOL", UpdateVolume: "TOOL",
		DeleteVolume: "TOOL", ResizeVolume: "TOOL", AttachVolume: "TOOL", DetachVolume: "TOOL",
		CreateSnapshot: "TOOL", GetSnapshot: "TOOL", GetSnapshotDownloadURL: "TOOL", UpdateSnapshot: "TOOL",
		DeleteSnapshot: "TOOL", ListSnapshots: "TOOL", ListSessionSnapshots: "TOOL", ListDanglingSnapshots: "TOOL",
		ListWorkspaceSnapshots: "TOOL",
		CreateTemplate: "TOOL", GetTemplate: "TOOL", ListTemplates: "TOOL",
		UpdateTemplate: "TOOL", DeleteTemplate: "TOOL", BuildTemplate: "TOOL", CancelTemplateBuild: "TOOL",
		GetTemplateBuild: "TOOL", ListActiveTemplateBuilds: "TOOL",
		PublishRegistryImage: "INTERNAL", GetRegistryImage: "INTERNAL", ListRegistryImages: "INTERNAL",
		SetRegistryImageVisibility: "INTERNAL", DeleteRegistryImage: "INTERNAL", DeleteRegistryImageVersion: "INTERNAL",
		ResolveRegistryRef: "INTERNAL", ShareImage: "INTERNAL", UnshareRegistryImage: "INTERNAL",
		RevokeRegistryShareGrant: "INTERNAL", ListRegistryShareGrants: "INTERNAL",
		WhoAmI: "TOOL", GetWorkspaceSandboxUsage: "TOOL",
		GetWorkspacePreviewDomains: "TOOL", UpdateWorkspacePreviewDomains: "TOOL",
	},
	SandboxSessionDataPlaneService: {
		ReadFile: "TOOL", WriteFile: "TOOL", Stat: "TOOL", Mkdir: "TOOL", Remove: "TOOL", List: "TOOL",
		ReadFileStream: "V2", WriteFileStream: "V2", Run: "V2", Dial: "V2", HostPortTunnel: "V2",
	},
	SSHGatewayClientService: {
		IssueSandboxSSHCert: "TOOL", ListActiveSSHGateways: "TOOL",
	},
};

// `option deprecated = true` in the proto. Still served; a tool may keep
// calling them, but the audit says so on every run.
const DEPRECATED = {
	ExecuteCommand: "data-plane Run stream (bidi; needs HTTP/2 Connect streaming)",
	StreamCommandOutput: "data-plane Run stream",
	ExposePort: "CreatePreviewUrl (slug required)",
	UnexposePort: "UnbindPreviewUrl / DeletePreviewUrl",
	ListExposedPorts: "ListPreviewUrls(session_id)",
	ListWorkspaceSandboxes: "ListSessions (credential-scoped)",
	ListWorkspaceSnapshots: "ListSnapshots (credential-scoped)",
};

// Methods a tool reaches via a client helper rather than a direct client.control/data call.
const HELPER_COVERAGE = new Set([
	"ReadFile", "WriteFile", // read_file/write_file → client.readTextFile/writeTextFile
	"ExecuteCommand", // exec/run_code/move_path → client.execCaptured
]);

// ── Detect called methods from the tool source ────────────────────────────────
const called = new Set(HELPER_COVERAGE);
for (const f of fs.readdirSync(toolsDir)) {
	if (!f.endsWith(".ts")) continue;
	const src = fs.readFileSync(path.join(toolsDir, f), "utf8");
	for (const m of src.matchAll(/client\.control\(\s*"([A-Za-z]+)"/g)) called.add(m[1]);
	for (const m of src.matchAll(/client\.data\(\s*[a-z_]+\s*,\s*"([A-Za-z]+)"/g)) called.add(m[1]);
}

// ── Report ────────────────────────────────────────────────────────────────────
const known = new Set(Object.values(SURFACE).flatMap((methods) => Object.keys(methods)));
let toolCount = 0, coveredCount = 0, v2 = 0, internal = 0;
const missing = [];
for (const [svc, methods] of Object.entries(SURFACE)) {
	for (const [method, kind] of Object.entries(methods)) {
		if (kind === "V2") { v2++; continue; }
		if (kind === "INTERNAL") { internal++; continue; }
		toolCount++;
		if (called.has(method)) coveredCount++;
		else missing.push(`${svc}/${method}`);
	}
}
const unknown = [...called].filter((m) => !known.has(m)).sort();
const deprecatedInUse = Object.keys(DEPRECATED).filter((m) => called.has(m));

console.log(`Parity audit — Tenki unary API surface`);
console.log(`  tool-worthy methods: ${toolCount}`);
console.log(`  covered:             ${coveredCount}`);
console.log(`  deferred to v2 (streaming): ${v2}`);
console.log(`  internal (excluded):        ${internal}`);
console.log(`  coverage: ${((coveredCount / toolCount) * 100).toFixed(1)}%`);
if (deprecatedInUse.length) {
	console.log(`\n! ${deprecatedInUse.length} deprecated method(s) still called by a tool (allowed, but plan the migration):`);
	for (const m of deprecatedInUse) console.log(`    - ${m} → ${DEPRECATED[m]}`);
}
let failed = false;
if (unknown.length) {
	failed = true;
	console.log(`\n✗ ${unknown.length} method(s) called by a tool that are NOT in the API surface (removed upstream? the tool can only fail):`);
	for (const m of unknown) console.log(`    - ${m}`);
}
if (missing.length) {
	failed = true;
	console.log(`\n✗ ${missing.length} method(s) NOT covered by a tool:`);
	for (const m of missing) console.log(`    - ${m}`);
	console.log(`\nFull parity requires a tool for each. Add them, or mark a method V2/INTERNAL with justification.`);
}
if (failed) process.exit(1);
console.log(`\n✓ Full parity: every tool-worthy method has a tool, and every tool calls a live method.`);
