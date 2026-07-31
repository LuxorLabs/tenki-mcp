/**
 * OFFLINE exec result-path suite — proves the parts of tenki_exec that
 * tools/list can't: the rendered content blocks, terminal-control escaping,
 * SDK output validation, and the exec-backed tenki_move_path semantics.
 * Runs the real server in-memory against a stubbed API client — ZERO network.
 *
 *   npm run build && node test/exec-output.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deepStrictEqual } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
const { createServer } = await import(join(DIST, "server.js"));
const { TenkiClient } = await import(join(DIST, "client.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

/** Connect an in-memory client to a server built around a stubbed API client. */
async function connect(stub) {
	const server = createServer(stub);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "exec-output-test", version: "1.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

const baseResult = {
	command: "echo",
	args: ["hi"],
	stdout: "plain\n",
	stderr: "",
	exitCode: 0,
	ok: true,
};

// 1) result contract: structuredContent + JSON text block + readable text block
{
	const client = await connect({ execCaptured: async () => ({ ...baseResult }) });
	const res = await client.callTool({ name: "tenki_exec", arguments: { session_id: "s1", command: "echo", args: ["hi"] } });
	check("exec call succeeds", res.isError !== true, JSON.stringify(res.content).slice(0, 120));
	check("structuredContent carries the typed result", res.structuredContent?.ok === true && res.structuredContent?.stdout === "plain\n");
	const texts = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
	check("two text blocks (JSON + readable)", texts.length === 2, `${texts.length}`);
	let parsed;
	try { parsed = JSON.parse(texts[0]); } catch { /* fails below */ }
	check("first text block is the serialized JSON result (spec back-compat)", parsed !== undefined);
	try { deepStrictEqual(parsed, res.structuredContent); check("JSON text block equals structuredContent", true); }
	catch (e) { check("JSON text block equals structuredContent", false, e.message?.slice(0, 100)); }
	check("second text block is the readable rendering", /^exit 0\n--- stdout/.test(texts[1] ?? ""), (texts[1] ?? "").slice(0, 40));
	await client.close();
}

// 2) untrusted output: raw bytes in structuredContent, visible escapes in the rendering
{
	const hostile = "a\x1b[2Jb\rc\x9bd‮e​f";
	const client = await connect({ execCaptured: async () => ({ ...baseResult, stdout: hostile }) });
	const res = await client.callTool({ name: "tenki_exec", arguments: { session_id: "s1", command: "echo" } });
	check("structuredContent keeps raw control chars", res.structuredContent?.stdout === hostile);
	const readable = (res.content ?? []).filter((c) => c.type === "text")[1]?.text ?? "";
	check("readable block escapes ESC", readable.includes("\\x1b") && !readable.includes("\x1b"));
	check("readable block escapes CR", readable.includes("\\x0d"));
	check("readable block escapes C1 CSI (U+009B)", readable.includes("\\x9b") && !readable.includes("\x9b"));
	check("readable block escapes bidi override (U+202E)", readable.includes("\\u202e") && !readable.includes("‮"));
	check("readable block escapes zero-width space (U+200B)", readable.includes("\\u200b") && !readable.includes("​"));
	await client.close();
}

// 3) SDK output validation is active: a result violating the schema fails the call
{
	const client = await connect({ execCaptured: async () => ({ ...baseResult, exitCode: "3" }) });
	const res = await client.callTool({ name: "tenki_exec", arguments: { session_id: "s1", command: "echo" } });
	check("schema-violating result → isError", res.isError === true);
	await client.close();
}

// 4) tenki_move_path: ok keys off the exit code, capture trouble is surfaced separately
{
	const client = await connect({
		execCaptured: async () => ({ ...baseResult, command: "mv", stdout: "", exitCode: 0, ok: false, captureError: "ReadFile blip" }),
	});
	const res = await client.callTool({ name: "tenki_move_path", arguments: { session_id: "s1", from: "/home/tenki/a", to: "/home/tenki/b" } });
	const j = JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "{}");
	check("move with exit 0 + capture failure → ok:true", j.ok === true, JSON.stringify(j));
	check("move surfaces captureError", j.captureError === "ReadFile blip");
	await client.close();
}
{
	const client = await connect({
		execCaptured: async () => ({ ...baseResult, command: "mv", exitCode: 1, ok: false, stderr: "mv: cannot stat" }),
	});
	const res = await client.callTool({ name: "tenki_move_path", arguments: { session_id: "s1", from: "/home/tenki/a", to: "/home/tenki/b" } });
	const j = JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "{}");
	check("move with exit 1 → ok:false + stderr", j.ok === false && j.stderr === "mv: cannot stat", JSON.stringify(j));
	await client.close();
}

// 5) a non-numeric exit code from the API degrades to -1, not a failed call
{
	class StubbedApi extends TenkiClient {
		constructor() { super("tk_offline_dummy_key"); }
		async control(method) {
			if (method === "ExecuteCommand") return { execution: { exitCode: "not-a-number" } };
			return {};
		}
		async readTextFile() { return "salvaged output"; }
	}
	const r = await new StubbedApi().execCaptured("s1", "echo");
	check("unparseable exitCode → -1, output preserved", r.exitCode === -1 && r.stdout === "salvaged output" && r.ok === false, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
