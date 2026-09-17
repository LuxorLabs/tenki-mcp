/**
 * Deploy the chat app to Vercel from this directory's source (no git link), using
 * the token the Vercel CLI already stored on this machine.
 *
 *   node scripts/deploy-vercel.mjs              # production deploy
 *   node scripts/deploy-vercel.mjs --preview    # preview deploy
 *
 * The MCP server is NOT deployed here — it runs in a sticky Tenki Sandbox
 * (tenki-server/scripts/deploy-sandbox.mts) and the app reaches it over
 * MCP_URL + MCP_TOKEN, which live in the project's environment variables.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const NAME = process.env.VERCEL_PROJECT || "tenki-copilotkit-mcp-apps";
const TARGET = process.argv.includes("--preview") ? "preview" : "production";

// Only what `next build` needs: no node_modules, no MCP server, no secrets.
const INCLUDE = ["app", "public"];
const ROOT_FILES = ["package.json", "package-lock.json", "next.config.ts", "postcss.config.mjs", "tsconfig.json"];

const token =
	process.env.VERCEL_TOKEN ||
	JSON.parse(await fs.readFile(path.join(os.homedir(), "Library/Application Support/com.vercel.cli/auth.json"), "utf8")).token;

const api = async (method, urlPath, body, extraHeaders = {}) => {
	const res = await fetch(`https://api.vercel.com${urlPath}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, ...(body && !extraHeaders["x-vercel-digest"] ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
		body: body && !extraHeaders["x-vercel-digest"] ? JSON.stringify(body) : body,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
};

async function* walk(dir) {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".env")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else yield full;
	}
}

const paths = [];
for (const dir of INCLUDE) {
	try {
		for await (const f of walk(path.join(ROOT, dir))) paths.push(f);
	} catch {
		/* optional directory */
	}
}
for (const f of ROOT_FILES) paths.push(path.join(ROOT, f));

const files = [];
for (const full of paths) {
	const body = await fs.readFile(full);
	const sha = createHash("sha1").update(body).digest("hex");
	const rel = path.relative(ROOT, full).split(path.sep).join("/");
	await api("POST", "/v2/files", body, { "x-vercel-digest": sha, "Content-Length": String(body.length), "Content-Type": "application/octet-stream" });
	files.push({ file: rel, sha, size: body.length });
}
console.log(`uploaded ${files.length} files (${Math.round(files.reduce((n, f) => n + f.size, 0) / 1024)} KB)`);

const deployment = await api("POST", "/v13/deployments?forceNew=1", {
	name: NAME,
	project: NAME,
	target: TARGET,
	files,
	projectSettings: {
		framework: "nextjs",
		// The repo's postinstall builds the MCP server, which this deployment doesn't contain.
		installCommand: "npm install --ignore-scripts",
		buildCommand: "next build",
	},
});
console.log(`deployment ${deployment.id} → https://${deployment.url} (${TARGET})`);

const started = Date.now();
for (;;) {
	const d = await api("GET", `/v13/deployments/${deployment.id}`);
	const state = d.readyState ?? d.status;
	if (["READY", "ERROR", "CANCELED"].includes(state)) {
		console.log(`${state} after ${Math.round((Date.now() - started) / 1000)}s`);
		if (state !== "READY") process.exit(1);
		const alias = (d.alias ?? []).filter((a) => !a.includes("-projects.vercel.app")).sort((a, b) => a.length - b.length)[0];
		console.log(`\nLive: https://${alias ?? d.url}`);
		break;
	}
	if (Date.now() - started > 600_000) throw new Error("timed out waiting for the deployment");
	process.stdout.write(".");
	await new Promise((r) => setTimeout(r, 4000));
}
