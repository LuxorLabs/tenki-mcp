/**
 * Deploy this MCP App server into a sticky Tenki Sandbox and expose it on a
 * stable preview URL, so a hosted chat (Vercel) can reach it.
 *
 *   npm run deploy            # create or update the host sandbox, print its URL
 *   npm run deploy -- --drop  # terminate it
 *
 * The host sandbox holds the Tenki key and boots the demo's other sandboxes, so
 * its endpoint is protected with a bearer token (MCP_TOKEN). The token is
 * generated once and kept in the gitignored .env.deploy next to .env; the same
 * value goes into the chat app's environment.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { config } from "dotenv";

import { HOST_TAG } from "../tenki.ts";
import { TenkiClient } from "../../../../src/client.ts";

const ROOT = path.join(import.meta.dirname, "..");
const DEMO_ENV = path.join(ROOT, "..", ".env");
const DEPLOY_ENV = path.join(ROOT, "..", ".env.deploy");
config({ path: [path.join(ROOT, ".env"), DEMO_ENV], quiet: true });

const HOST_NAME = process.env.MCP_HOST_NAME || "ck-mcp-host";
const SLUG = process.env.MCP_HOST_SLUG || "tenki-mcp-apps";
const PORT = 3108;
const DIR = "/home/tenki/mcp";
const UNIT = "tenki-mcp-app";

const key = process.env.TENKI_API_KEY || process.env.TENKI_AUTH_TOKEN;
if (!key) {
	console.error("No TENKI_API_KEY in examples/copilotkit-mcp-apps/.env — nothing to deploy to.");
	process.exit(1);
}
const client = new TenkiClient(key, process.env.TENKI_API_ENDPOINT || undefined);
const drop = process.argv.includes("--drop");

const sh = async (sessionId: string, script: string, timeoutSeconds = 60) => {
	const r = await client.execCaptured(sessionId, "sh", { args: ["-c", script], timeoutSeconds, maxOutputBytes: 20_000 });
	if (!r.ok) throw new Error(`remote command failed (exit ${r.exitCode}): ${script.slice(0, 80)}…\n${r.stdout}\n${r.stderr}`);
	return r.stdout.trim();
};

/** Write a local file into the sandbox, gzipped so a 700 KB bundle is a 190 KB body. */
async function putFile(sessionId: string, localPath: string, remotePath: string) {
	const body = await fs.readFile(localPath);
	const b64 = gzipSync(body).toString("base64");
	await client.writeTextFile(sessionId, `${remotePath}.gz.b64`, b64);
	await sh(sessionId, `cd $(dirname ${remotePath}) && base64 -d ${remotePath}.gz.b64 | gunzip > ${remotePath} && rm ${remotePath}.gz.b64`);
	return body.length;
}

// ─── find or create the host sandbox ────────────────────────────────────────

const owner = await client.resolveOwner();
const listed = await client.control("ListSessions", { pageSize: 100 });
const existing = (listed.sessions ?? []).find(
	(s: any) => (s.tags ?? []).includes(HOST_TAG) && !String(s.state ?? "").includes("TERMINAT"),
);

if (drop) {
	if (!existing) {
		console.log("No host sandbox running.");
		process.exit(0);
	}
	await client.control("TerminateSession", { sessionId: existing.id });
	console.log(`Terminated ${existing.name} (${existing.id}).`);
	process.exit(0);
}

let sessionId: string;
if (existing && String(existing.state).includes("RUNNING")) {
	sessionId = existing.id;
	console.log(`Reusing host sandbox ${existing.name} (${sessionId})`);
} else {
	// A host that is PAUSED (Tenki caps a sandbox's lifetime — 2h in this
	// workspace — and pauses it at the cap) still holds the preview slug, and
	// resuming a paused 4 GB VM has hung for minutes. Replacing it is faster and
	// predictable, so retire it before booting the new one.
	if (existing) {
		console.log(`Replacing ${String(existing.state).replace("SESSION_STATE_", "")} host sandbox ${existing.name}`);
		await client.control("TerminateSession", { sessionId: existing.id }).catch(() => {});
	}
	const created = await client.control("CreateSession", {
		...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
		...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
		...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
		name: HOST_NAME,
		cpuCores: 2,
		memoryMb: 4096,
		maxDuration: "86400s",
		idleTimeoutMinutes: 1440,
		allowInbound: true,
		allowOutbound: true,
		// HOST_TAG only, never the demo tag: the demo's own teardown must not be
		// able to destroy the sandbox hosting this server.
		tags: [HOST_TAG],
	});
	const session = created.session ?? created;
	sessionId = session.id;
	// Placement has taken minutes when Tenki is busy; failing fast here just means
	// the keepalive tries again from scratch, which is slower still.
	await client.waitForState(sessionId, "RUNNING", { intervalMs: 250, timeoutMs: 420_000 });
	console.log(`Created host sandbox ${HOST_NAME} (${sessionId})`);
}

// ─── token ──────────────────────────────────────────────────────────────────

let token = process.env.MCP_TOKEN || "";
if (!token) {
	try {
		const existingEnv = await fs.readFile(DEPLOY_ENV, "utf8");
		token = /^MCP_TOKEN=(.*)$/m.exec(existingEnv)?.[1]?.trim() ?? "";
	} catch {
		/* first deploy */
	}
}
if (!token) token = randomBytes(32).toString("base64url");

// ─── upload ─────────────────────────────────────────────────────────────────

const manifest = {
	name: "tenki-mcp-app-host",
	private: true,
	type: "module",
	dependencies: {
		"@modelcontextprotocol/ext-apps": "1.7.5",
		"@modelcontextprotocol/sdk": "1.30.0",
		dotenv: "^16.4.7",
		express: "^5.1.0",
		tsx: "^4.21.0",
		zod: "^4.4.3",
	},
} as const;

await sh(sessionId, `mkdir -p ${DIR}/dist`);
await client.writeTextFile(sessionId, `${DIR}/package.json`, JSON.stringify(manifest, null, 2));
await client.writeTextFile(
	sessionId,
	`${DIR}/.env`,
	[`TENKI_API_KEY=${key}`, `MCP_TOKEN=${token}`, "MCP_HOST=0.0.0.0", `MCP_PORT=${PORT}`, ""].join("\n"),
);
await sh(sessionId, `chmod 600 ${DIR}/.env`);

// tenki.ts imports the repo's client through a relative path that doesn't exist here.
const tenkiSrc = (await fs.readFile(path.join(ROOT, "tenki.ts"), "utf8")).replace('from "../../../src/client.ts"', 'from "./client.ts"');
await client.writeTextFile(sessionId, `${DIR}/tenki.ts`, tenkiSrc);
await client.writeTextFile(sessionId, `${DIR}/server.ts`, await fs.readFile(path.join(ROOT, "server.ts"), "utf8"));
await client.writeTextFile(sessionId, `${DIR}/client.ts`, await fs.readFile(path.join(ROOT, "..", "..", "..", "src", "client.ts"), "utf8"));

execFileSync("npx", ["vite", "build"], { cwd: ROOT, stdio: "ignore" });
const bundle = path.join(ROOT, "dist", "index.html");
const bytes = await putFile(sessionId, bundle, `${DIR}/dist/index.html`);
const sum = createHash("sha256").update(await fs.readFile(bundle)).digest("hex").slice(0, 12);
const remoteSum = await sh(sessionId, `sha256sum ${DIR}/dist/index.html | cut -c1-12`);
if (remoteSum !== sum) throw new Error(`widget bundle mismatch after upload (local ${sum}, remote ${remoteSum})`);
console.log(`Uploaded server + widget bundle (${Math.round(bytes / 1024)} KB, sha ${sum})`);

// ─── install, run, expose ───────────────────────────────────────────────────

console.log("Installing dependencies in the sandbox…");
await sh(sessionId, `cd ${DIR} && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -3`, 300);

await sh(
	sessionId,
	[
		`sudo -n systemctl stop ${UNIT} >/dev/null 2>&1 || true`,
		`sudo -n systemd-run --unit=${UNIT} --collect -p Restart=always -p RestartSec=2 --uid="$(id -u)" --gid="$(id -g)" ` +
			`-p WorkingDirectory=${DIR} -E HOME=/home/tenki -E PATH="$PATH" ${DIR}/node_modules/.bin/tsx ${DIR}/server.ts >/dev/null`,
	].join("\n"),
	60,
);
await sh(sessionId, `i=0; while [ $i -lt 60 ]; do node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && exit 0; i=$((i+1)); sleep 0.5; done; exit 1`, 60);

const exposed = await client.control("ExposePort", { sessionId, port: PORT, slug: SLUG });
const url = JSON.stringify(exposed).match(/"(https:\/\/[^"]+)"/)?.[1];
if (!url) throw new Error(`ExposePort returned no preview URL: ${JSON.stringify(exposed).slice(0, 300)}`);

const health = await (async () => {
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(4000) });
			if (res.ok) return await res.json();
		} catch {
			/* edge still routing */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return null;
})();
if (!health) throw new Error(`The sandbox is serving but ${url}/healthz never answered.`);

// Refuse to hand out an endpoint that answers without the token.
const unauth = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (unauth.status !== 401) throw new Error(`SECURITY: ${url}/mcp answered ${unauth.status} without a token; expected 401.`);

await fs.writeFile(DEPLOY_ENV, [`# Written by npm run deploy. Gitignored — the chat app needs these.`, `MCP_URL=${url}/mcp`, `MCP_TOKEN=${token}`, ""].join("\n"), { mode: 0o600 });

console.log(`\nMCP server live:  ${url}/mcp   (health: ${JSON.stringify(health)})`);
console.log(`Unauthenticated calls are refused (401). Credentials written to .env.deploy:`);
console.log(`  MCP_URL=${url}/mcp`);
console.log(`  MCP_TOKEN=(in .env.deploy)`);
console.log(`\nSandbox ${sessionId} — logs: tenki sandbox exec --session ${sessionId} -- journalctl -u ${UNIT} -n 50`);
