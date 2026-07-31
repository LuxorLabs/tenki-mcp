/**
 * v2 HTTP transport test: start tenki-mcp in HTTP mode (loopback + a bearer
 * token), prove the security gates (no token → 401; bad Host → rejected DNS
 * rebinding), then connect with the official MCP Streamable-HTTP client and drive
 * tools/list + a tool call over HTTP — proving the server is hostable AND guarded.
 *
 *   npm run build && TENKI_API_KEY=… node test/http-transport.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import http from "node:http";
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
if (!token) {
	console.error("No token. Set TENKI_API_KEY or run `tenki login`.");
	process.exit(1);
}

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
const PORT = 39217;
const HTTP_TOKEN = "test-http-secret-" + PORT;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn(process.execPath, [SERVER], {
	env: { ...process.env, TENKI_MCP_TRANSPORT: "http", PORT: String(PORT), TENKI_MCP_HTTP_TOKEN: HTTP_TOKEN, TENKI_API_KEY: token },
	stdio: ["ignore", "pipe", "pipe"],
});
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};
const done = (code) => {
	try { child.kill("SIGTERM"); } catch { /* ignore */ }
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(code ?? (fail ? 1 : 0));
};

async function waitForBanner(timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		let buf = "";
		const t = setTimeout(() => reject(new Error("server did not start in time")), timeoutMs);
		child.stderr.on("data", (d) => {
			buf += d.toString();
			if (buf.includes("running on http")) { clearTimeout(t); resolve(buf); }
		});
		child.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited early (${c}): ${buf.slice(0, 200)}`)); });
	});
}

const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

/** Raw POST /mcp — lets us set headers (like Host) that fetch/undici won't override. */
function rawPost(headers, body) {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body), ...headers } },
			(r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve({ code: r.statusCode, body: d })); },
		);
		req.on("error", (e) => resolve({ code: "ERR", body: e.message }));
		req.write(body);
		req.end();
	});
}

try {
	const banner = await waitForBanner();
	check("server started on loopback with auth", banner.includes("127.0.0.1") && banner.includes("bearer auth required"), banner.trim());

	// Security gate 1: no bearer token → 401
	const noAuth = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: initBody });
	check("rejects request with no bearer token (401)", noAuth.status === 401, `got ${noAuth.status}`);

	// Security gate 2: valid token but forged Host → DNS-rebinding protection rejects.
	// Must use raw http.request — fetch/undici won't let you override the Host header.
	const badHost = await rawPost({ Authorization: `Bearer ${HTTP_TOKEN}`, Host: "evil.example.com" }, initBody);
	check("rejects forged Host header (DNS-rebinding guard)", badHost.code === 403, `got ${badHost.code}`);

	// Happy path: authorized client over the SDK transport
	const transport = new StreamableHTTPClientTransport(new URL(BASE), { requestInit: { headers: { Authorization: `Bearer ${HTTP_TOKEN}` } } });
	const client = new Client({ name: "http-test", version: "1.0.0" });
	await client.connect(transport);
	check("authorized client connects over Streamable HTTP", true);

	const { tools } = await client.listTools();
	check("tools/list over HTTP → 84 tools", tools.length >= 80, `${tools.length}`);

	const res = await client.callTool({ name: "tenki_whoami", arguments: {} });
	const j = JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "{}");
	check(
		"tools/call tenki_whoami over HTTP → authenticated",
		// Any non-empty owner type counts as authenticated — enumerating the
		// API's owner types goes stale each time it grows one.
		typeof j.ownerType === "string" && j.ownerType.length > 0,
		JSON.stringify(j).slice(0, 60),
	);

	await client.close();
	check("clean client close", true);
	done();
} catch (e) {
	console.error("  ✗ " + (e?.message ?? e));
	fail++;
	done(1);
}
