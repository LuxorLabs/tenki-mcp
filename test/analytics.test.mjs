/**
 * OFFLINE PostHog MCP Analytics suite — runs the real server in-memory with
 * analytics pointed at a local fake ingestion endpoint. ZERO external network.
 * Proves: off by default and under opt-outs; when on, the injected `context`
 * argument never reaches our handlers; argument values and tool results are
 * never sent; hosted sessions are attributed to the OAuth subject + workspace.
 *
 *   npm run build && node test/analytics.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

// Fake PostHog ingestion: collect every event posted to /batch or /capture.
const events = [];
const ingest = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		let buf = Buffer.concat(chunks);
		if (req.headers["content-encoding"] === "gzip") buf = gunzipSync(buf);
		try {
			const body = JSON.parse(buf.toString("utf8") || "{}");
			for (const e of body.batch ?? [body]) events.push(e);
		} catch { /* ignore */ }
		res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":1}');
	});
});
await new Promise((r) => ingest.listen(0, "127.0.0.1", r));
const ingestUrl = `http://127.0.0.1:${ingest.address().port}`;

// 1) gating — decided purely from env, before any client exists
{
	const { analyticsEnabled } = await import(join(DIST, "analytics.js"));
	check("off with no token", analyticsEnabled({}) === false);
	check("on with LUXOR_MCP_POSTHOG_TOKEN", (() => {
		process.env.LUXOR_MCP_POSTHOG_TOKEN = "phc_test";
		try { return analyticsEnabled(process.env) === true; } finally { delete process.env.LUXOR_MCP_POSTHOG_TOKEN; }
	})());
	check("DO_NOT_TRACK=1 wins over a token", analyticsEnabled({ LUXOR_MCP_POSTHOG_TOKEN: "phc_test", DO_NOT_TRACK: "1" }) === false);
	check("LUXOR_MCP_ANALYTICS=0 wins over a token", analyticsEnabled({ LUXOR_MCP_POSTHOG_TOKEN: "phc_test", LUXOR_MCP_ANALYTICS: "0" }) === false);
}

// 2) default build: no analytics → tool schemas are untouched
{
	const { createServer } = await import(join(DIST, "server.js"));
	const server = createServer({});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const c = new Client({ name: "analytics-off", version: "1.0.0" });
	await Promise.all([server.connect(st), c.connect(ct)]);
	const { tools } = await c.listTools();
	const exec = tools.find((t) => t.name === "tenki_exec");
	check("analytics off: no injected context argument", exec && !("context" in (exec.inputSchema.properties ?? {})));
	await c.close();
}

// 3) analytics on (token + local host set before the shared client is created)
process.env.LUXOR_MCP_POSTHOG_TOKEN = "phc_test_token";
process.env.LUXOR_MCP_POSTHOG_HOST = ingestUrl;
const { createServer } = await import(join(DIST, "server.js"));
const { shutdownAnalytics, scrubEvent } = await import(join(DIST, "analytics.js"));

let seenArgs;
const SECRET = "sk-live-THIS-MUST-NOT-LEAVE-THE-PROCESS";
const stub = {
	execCaptured: async (sessionId, command, opts) => {
		seenArgs = { sessionId, command, ...opts };
		return { command, args: opts?.args ?? [], stdout: `${SECRET}\n`, stderr: "", exitCode: 0, ok: true };
	},
};
const server = createServer(stub, { subject: "user-123", workspaceId: "ws-456", clientId: "client-789" });
const [ct, st] = InMemoryTransport.createLinkedPair();
const c = new Client({ name: "analytics-test-client", version: "9.9.9" });
await Promise.all([server.connect(st), c.connect(ct)]);

const { tools } = await c.listTools();
const exec = tools.find((t) => t.name === "tenki_exec");
check("analytics on: context argument advertised", Boolean(exec?.inputSchema.properties?.context));
check("tool count unchanged (no get_more_tools)", !tools.some((t) => t.name === "get_more_tools"));

const res = await c.callTool({
	name: "tenki_exec",
	arguments: { session_id: "s1", command: "echo", args: [SECRET], context: "Checking the build output for the user's failing deploy" },
});
check("tool call still succeeds", res.isError !== true, JSON.stringify(res.content).slice(0, 120));
check("handler never sees the injected context", seenArgs && seenArgs.command === "echo" && !("context" in (seenArgs ?? {})));
check("result has no conversation-id block", !(res.content ?? []).some((b) => b.type === "text" && /conversation_id/.test(b.text)));

await c.close();
await shutdownAnalytics();
ingest.close();

const call = events.find((e) => e.event === "$mcp_tool_call");
const p = call?.properties ?? {};
check("a $mcp_tool_call event was sent", Boolean(call), `got ${events.map((e) => e.event).join(",") || "none"}`);
check("tool name recorded", p.$mcp_tool_name === "tenki_exec", p.$mcp_tool_name);
check("intent recorded", /failing deploy/.test(p.$mcp_intent ?? ""), p.$mcp_intent);
check("argument names recorded", Array.isArray(p.$mcp_input_keys) && p.$mcp_input_keys.includes("command"), JSON.stringify(p.$mcp_input_keys));
check("argument values NOT sent", !("$mcp_parameters" in p));
check("tool result NOT sent", !("$mcp_response" in p));
check("attributed to OAuth subject", call?.distinct_id === "user-123", call?.distinct_id);
check("grouped by workspace", p.$groups?.workspace === "ws-456", JSON.stringify(p.$groups));
check("server build = package version", typeof p.$mcp_server_build === "string" && p.$mcp_server_build.length > 0);
check("secret appears in NO event", !JSON.stringify(events).includes(SECRET));

// 4) scrubEvent truncates long error messages
{
	const e = scrubEvent({ event: "$mcp_tool_call", properties: { $mcp_error_message: "x".repeat(1000), $mcp_parameters: {}, $mcp_response: {} } });
	check("long error message truncated", e.properties.$mcp_error_message.length <= 301);
}

console.log(`\nanalytics: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
