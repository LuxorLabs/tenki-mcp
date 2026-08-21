/**
 * Parity audit — the v1.0 "full CLI parity" gate.
 *
 * Enumerates every unary method of the Tenki API (from the published API surface map,
 * docs/research/rest-endpoints.md in the n8n node) and fails if any TOOL-worthy
 * method is not covered by a registered MCP tool. Streaming methods are deferred
 * to v2.0; transport-internal methods are excluded.
 *
 *   node scripts/parity-audit.mjs        # exits 1 if any gap
 *
 * Coverage is detected by grepping src/tools/*.ts for client.control("X") /
 * client.data(_, "X") calls, plus HELPER_COVERAGE for methods a tool reaches
 * through a client helper (e.g. read_file → ReadFile via client.readTextFile).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, "..", "src", "tools");

// ── Canonical unary method surface ────────────────────────────────────────────
// TOOL   → must be covered by a tool for v1.0 parity
// V2     → streaming/interactive, deferred to v2.0 (a Connect-streaming transport)
// INTERNAL → transport plumbing, never a user tool
const SURFACE = {
	SandboxService: {
		CreateSession: "TOOL", GetSession: "TOOL", ListSessions: "TOOL", ListWorkspaceSandboxes: "TOOL",
		ListProjectSandboxes: "TOOL", UpdateSession: "TOOL", PauseSession: "TOOL", ResumeSession: "TOOL",
		ExtendSession: "TOOL", TerminateSession: "TOOL", TerminateSessions: "TOOL", ReportSessionActivity: "TOOL",
		WaitSession: "V2", CreateSessionCredential: "INTERNAL",
		ExecuteCommand: "TOOL", StreamCommandOutput: "V2", GitOperation: "TOOL",
		GetArtifactUploadUrl: "TOOL", GetArtifactDownloadUrl: "TOOL",
		ExposePort: "TOOL", UnexposePort: "TOOL", ListExposedPorts: "TOOL", OpenPreview: "TOOL", TouchPreview: "TOOL",
		CreatePreviewUrl: "TOOL", DeletePreviewUrl: "TOOL", GetPreviewUrl: "TOOL", ListPreviewUrls: "TOOL",
		BindPreviewUrl: "TOOL", UnbindPreviewUrl: "TOOL", ResolvePreviewToken: "TOOL",
		UpdateSSHAuthorizedKeys: "TOOL",
		CreateVolume: "TOOL", GetVolume: "TOOL", ListVolumes: "TOOL", ListProjectVolumes: "TOOL", UpdateVolume: "TOOL",
		DeleteVolume: "TOOL", ResizeVolume: "TOOL", AttachVolume: "TOOL", DetachVolume: "TOOL",
		CreateSnapshot: "TOOL", GetSnapshot: "TOOL", GetSnapshotDownloadURL: "TOOL", UpdateSnapshot: "TOOL",
		DeleteSnapshot: "TOOL", ListSnapshots: "TOOL", ListSessionSnapshots: "TOOL", ListDanglingSnapshots: "TOOL",
		ListWorkspaceSnapshots: "TOOL", ListProjectSnapshots: "TOOL",
		CreateTemplate: "TOOL", GetTemplate: "TOOL", ListTemplates: "TOOL", ListProjectTemplates: "TOOL",
		UpdateTemplate: "TOOL", DeleteTemplate: "TOOL", BuildTemplate: "TOOL", CancelTemplateBuild: "TOOL",
		GetTemplateBuild: "TOOL", ListActiveTemplateBuilds: "TOOL",
		PublishRegistryImage: "INTERNAL", GetRegistryImage: "INTERNAL", ListRegistryImages: "INTERNAL",
		SetRegistryImageVisibility: "INTERNAL", DeleteRegistryImage: "INTERNAL", DeleteRegistryImageVersion: "INTERNAL",
		ResolveRegistryRef: "INTERNAL", ShareImage: "INTERNAL", UnshareRegistryImage: "INTERNAL",
		RevokeRegistryShareGrant: "INTERNAL", ListRegistryShareGrants: "INTERNAL",
		WhoAmI: "TOOL", GetWorkspaceSandboxUsage: "TOOL", GetWorkspaceSandboxSettings: "TOOL",
		UpdateWorkspaceSandboxSettings: "TOOL", GetWorkspaceSnapshotRetentionSettings: "TOOL",
		UpdateWorkspaceSnapshotRetentionSettings: "TOOL",
	},
	SandboxSessionDataPlaneService: {
		ReadFile: "TOOL", WriteFile: "TOOL", Stat: "TOOL", Mkdir: "TOOL", Remove: "TOOL", List: "TOOL",
		ReadFileStream: "V2", WriteFileStream: "V2", Run: "V2", Dial: "V2", HostPortTunnel: "V2",
	},
	SSHGatewayClientService: {
		IssueSandboxSSHCert: "TOOL", ListActiveSSHGateways: "TOOL",
	},
};

// Methods a tool reaches via a client helper rather than a direct client.control/data call.
const HELPER_COVERAGE = new Set([
	"ReadFile", "WriteFile", // read_file/write_file → client.readTextFile/writeTextFile
	"ExecuteCommand", // exec/run_code → client.execCaptured
]);

// ── Detect covered methods from the tool source ───────────────────────────────
const covered = new Set(HELPER_COVERAGE);
for (const f of fs.readdirSync(toolsDir)) {
	if (!f.endsWith(".ts")) continue;
	const src = fs.readFileSync(path.join(toolsDir, f), "utf8");
	for (const m of src.matchAll(/client\.control\(\s*"([A-Za-z]+)"/g)) covered.add(m[1]);
	for (const m of src.matchAll(/client\.data\(\s*[a-z_]+\s*,\s*"([A-Za-z]+)"/g)) covered.add(m[1]);
}

// ── Report ────────────────────────────────────────────────────────────────────
let toolCount = 0, coveredCount = 0, v2 = 0, internal = 0;
const missing = [];
for (const [svc, methods] of Object.entries(SURFACE)) {
	for (const [method, kind] of Object.entries(methods)) {
		if (kind === "V2") { v2++; continue; }
		if (kind === "INTERNAL") { internal++; continue; }
		toolCount++;
		if (covered.has(method)) coveredCount++;
		else missing.push(`${svc}/${method}`);
	}
}

console.log(`Parity audit — Tenki unary API surface`);
console.log(`  tool-worthy methods: ${toolCount}`);
console.log(`  covered:             ${coveredCount}`);
console.log(`  deferred to v2 (streaming): ${v2}`);
console.log(`  internal (excluded):        ${internal}`);
console.log(`  coverage: ${((coveredCount / toolCount) * 100).toFixed(1)}%`);
if (missing.length) {
	console.log(`\n✗ ${missing.length} method(s) NOT covered by a tool:`);
	for (const m of missing) console.log(`    - ${m}`);
	console.log(`\nFull parity (v1.0) requires a tool for each. Add them, or mark a method V2/INTERNAL with justification.`);
	process.exit(1);
} else {
	console.log(`\n✓ Full CLI parity: every tool-worthy method has a tool.`);
}
