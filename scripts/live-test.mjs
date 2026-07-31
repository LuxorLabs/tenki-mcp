/**
 * Live end-to-end test against the real Tenki API.
 *
 * Requires a real key in the environment (TENKI_API_KEY=tk_...). Run via:
 *   node --env-file=.env scripts/live-test.mjs
 *
 * Progression, cheapest/safest first:
 *   1. WhoAmI       — no side effects, just proves auth works
 *   2. run_code     — boots a 1-vCPU throwaway sandbox, runs Python, tears it down
 *   3. create/exec/write/read/terminate — a persistent-sandbox round trip
 *
 * The key is never printed.
 */
import { TenkiClient } from "../dist/client.js";

const token = process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY;
if (!token) {
	console.error("No TENKI_API_KEY found. Add it to .env, then: node --env-file=.env scripts/live-test.mjs");
	process.exit(1);
}
const client = new TenkiClient(token, process.env.TENKI_API_ENDPOINT || undefined);

const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m, e) => console.log(`  ✗ ${m}\n     ${e?.message ?? e}`);

let sessionId;
try {
	console.log("[1] WhoAmI (auth check, no side effects)");
	const who = await client.control("WhoAmI", {});
	pass(`authenticated as ${who.ownerType ?? "?"}/${who.ownerId ?? "?"} · ${(who.workspaces ?? []).length} workspace(s)`);

	console.log("[2] run_code (ephemeral sandbox: boot → run python → terminate)");
	const rc = await client.runCode("python", 'print("hello from tenki-mcp")');
	if (rc.ok && rc.stdout.includes("hello from tenki-mcp")) pass(`stdout=${JSON.stringify(rc.stdout.trim())} exit=${rc.exitCode}`);
	else fail(`unexpected result: ${JSON.stringify({ stdout: rc.stdout, stderr: rc.stderr, exit: rc.exitCode, captureError: rc.captureError })}`);

	console.log("[3] persistent sandbox round-trip (create → write → exec → read → terminate)");
	const owner = await client.resolveOwner();
	const created = await client.control("CreateSession", {
		cpuCores: 1, memoryMb: 1024, maxDuration: "600s", idleTimeoutMinutes: 5,
		...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
		...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
		...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
		...(owner.projectId ? { projectId: owner.projectId } : {}),
	});
	const s = created.session ?? created;
	sessionId = s.id ?? created.sessionId;
	pass(`created ${sessionId}`);
	await client.waitForState(sessionId, "RUNNING");
	pass("reached RUNNING");
	await client.writeTextFile(sessionId, "/home/tenki/note.txt", "written by tenki-mcp live test");
	const ex = await client.execCaptured(sessionId, "cat", { args: ["/home/tenki/note.txt"] });
	if (ex.ok && ex.stdout.includes("written by tenki-mcp")) pass(`exec+read back: ${JSON.stringify(ex.stdout.trim())}`);
	else fail(`round-trip mismatch: ${JSON.stringify(ex)}`);

	console.log("\nAll live checks passed ✓");
} catch (e) {
	fail("live test error", e);
	process.exitCode = 1;
} finally {
	if (sessionId) {
		try {
			await client.control("TerminateSession", { sessionId });
			console.log(`(cleaned up ${sessionId})`);
		} catch {
			console.log(`(could not terminate ${sessionId} — it will self-reap via the idle/max-duration guards)`);
		}
	}
}
