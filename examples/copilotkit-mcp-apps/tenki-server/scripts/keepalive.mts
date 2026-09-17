/**
 * Keep the hosted MCP server reachable.
 *
 * Tenki caps how long a sandbox may live (2h in this workspace, whatever
 * maxDuration asks for) and PAUSES it at the cap: the process is frozen and the
 * preview route disappears, so a hosted chat loses its tools with no other
 * warning. Resuming a paused host has hung for minutes, so this replaces it.
 *
 *   npm run keepalive            # check every 60s, redeploy when unhealthy
 *   npm run keepalive -- 30      # check every 30s
 *
 * Leave it running during a demo. Each redeploy takes about a minute.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { config } from "dotenv";

const ROOT = path.join(import.meta.dirname, "..");
config({ path: [path.join(ROOT, "..", ".env.deploy"), path.join(ROOT, "..", ".env")], quiet: true });

const every = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 60) * 1000;
const url = process.env.MCP_URL;
if (!url) {
	console.error("No MCP_URL in .env.deploy — run `npm run deploy` first.");
	process.exit(1);
}
const health = `${url.replace(/\/mcp$/, "")}/healthz`;
const stamp = () => new Date().toISOString().slice(11, 19);

const healthy = async () => {
	try {
		const res = await fetch(health, { signal: AbortSignal.timeout(6000) });
		return res.ok;
	} catch {
		return false;
	}
};

console.log(`[keepalive] watching ${health} every ${every / 1000}s`);
for (;;) {
	if (await healthy()) {
		console.log(`${stamp()} ok`);
	} else {
		// One retry: a redeploy is disruptive, and a single blip is usually the edge.
		await new Promise((r) => setTimeout(r, 3000));
		if (await healthy()) {
			console.log(`${stamp()} ok (after a blip)`);
		} else {
			console.log(`${stamp()} DOWN — redeploying the host sandbox…`);
			try {
				execFileSync("npx", ["tsx", path.join(import.meta.dirname, "deploy-sandbox.mts")], { cwd: ROOT, stdio: "inherit" });
				console.log(`${stamp()} redeployed; ${(await healthy()) ? "healthy again" : "still unhealthy — check by hand"}`);
			} catch (err) {
				console.error(`${stamp()} redeploy failed:`, err instanceof Error ? err.message : String(err));
			}
		}
	}
	await new Promise((r) => setTimeout(r, every));
}
