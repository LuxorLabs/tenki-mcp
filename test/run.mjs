/**
 * Runs every test/*.test.mjs against live Tenki and reports the aggregate.
 * Exit non-zero if any suite fails.
 *
 *   npm run build && TENKI_API_KEY=… node test/run.mjs
 *
 * Each suite drives the real MCP protocol via test/harness.mjs, self-cleans its
 * resources, and prints its own pass/fail/skip. Data-plane/sandbox-network
 * outages are SKIPs, not failures (see harness checkData).
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

let failed = 0;
for (const s of suites) {
	console.log(`\n════════ ${s} ════════`);
	const r = spawnSync(process.execPath, [join(dir, s)], { stdio: "inherit", env: process.env });
	if (r.status !== 0) failed++;
}
console.log(`\n${failed ? `✗ ${failed}/${suites.length} suite(s) failed` : `✓ all ${suites.length} suites passed`}`);
process.exit(failed ? 1 : 0);
