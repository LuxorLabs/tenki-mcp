/**
 * OFFLINE connector pre-submission suite — encodes the tool-design rules from
 * https://claude.com/docs/connectors/building/review-criteria so a regression
 * fails CI instead of a directory review:
 *   - every tool has a `title` and the applicable readOnlyHint / destructiveHint
 *   - names are ≤ 64 characters; every parameter is described
 *   - read and write operations are separate tools (no operation/method switch)
 *   - responses are bounded (tenki_read_file pages, git output is capped)
 *   - inputs are validated before the API call (git values that would be git options)
 * Runs the real server in-memory against a stubbed API client — ZERO network.
 *
 *   npm run build && node test/presubmission.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
const { createServer } = await import(join(DIST, "server.js"));
const { TOOL_TITLES } = await import(join(DIST, "tools", "titles.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

/** Connect an in-memory client to a server built around a stubbed API client. */
async function connect(stub) {
	const server = createServer(stub);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "presubmission-test", version: "1.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}
const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
const json = (r) => JSON.parse(text(r));

/** Records control-plane calls; serves ReadFile from `files` (path → Buffer). */
class Stub {
	constructor(files = {}) { this.calls = []; this.files = files; this.output = "ok"; }
	async control(method, body) { this.calls.push({ method, body }); return { output: this.output }; }
	async readFileBytes(_sid, path) { return this.files[path] ?? Buffer.alloc(0); }
}

// 1) Tool surface: titles, hints, names, parameter descriptions
{
	const client = await connect(new Stub());
	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

	check("every tool has a non-empty top-level title", tools.every((t) => typeof t.title === "string" && t.title.trim().length > 0), names.filter((n) => !byName[n].title).join(","));
	check("annotations.title equals the top-level title", tools.every((t) => t.annotations?.title === t.title));
	const missing = names.filter((n) => !(n in TOOL_TITLES));
	check("every tool has an explicit TOOL_TITLES entry (no name-derived fallback)", missing.length === 0, missing.join(","));
	const stale = Object.keys(TOOL_TITLES).filter((n) => !names.includes(n));
	check("no TOOL_TITLES entry for an unregistered tool", stale.length === 0, stale.join(","));
	check("titles are unique", new Set(tools.map((t) => t.title)).size === tools.length);
	check(
		"every tool declares readOnlyHint and destructiveHint as booleans",
		tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean" && typeof t.annotations?.destructiveHint === "boolean"),
	);
	check("no tool is both read-only and destructive", !tools.some((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint));
	check("every tool name is ≤ 64 characters", names.every((n) => n.length <= 64), names.filter((n) => n.length > 64).join(","));
	const undocumented = tools.flatMap((t) =>
		Object.entries(t.inputSchema?.properties ?? {})
			.filter(([, p]) => typeof p.description !== "string" || p.description.trim() === "")
			.map(([k]) => `${t.name}.${k}`),
	);
	check("every input parameter has a description", undocumented.length === 0, undocumented.join(","));

	// Read and write operations live in separate tools.
	check("the mixed read/write tenki_git tool is gone", !names.includes("tenki_git"));
	check("git is split into clone/checkout/diff/log", ["tenki_git_clone", "tenki_git_checkout", "tenki_git_diff", "tenki_git_log"].every((n) => names.includes(n)));
	const switchers = tools.filter((t) => ["operation", "method", "action"].some((k) => k in (t.inputSchema?.properties ?? {}))).map((t) => t.name);
	check("no tool takes an operation/method/action switch", switchers.length === 0, switchers.join(","));

	// Hints match behavior. Destructive = may overwrite, modify, interrupt or delete existing state.
	const ro = (n) => byName[n]?.annotations?.readOnlyHint === true;
	const destructive = (n) => byName[n]?.annotations?.readOnlyHint === false && byName[n]?.annotations?.destructiveHint === true;
	const additive = (n) => byName[n]?.annotations?.readOnlyHint === false && byName[n]?.annotations?.destructiveHint === false;
	const mustBeDestructive = [
		"tenki_exec", "tenki_write_file", "tenki_move_path", "tenki_git_checkout", "tenki_get_upload_url",
		"tenki_update_sandbox", "tenki_update_snapshot", "tenki_update_volume", "tenki_update_template",
		"tenki_update_egress_policy", "tenki_update_workspace_preview_domains", "tenki_update_ssh_keys",
		"tenki_pause_sandbox", "tenki_open_preview", "tenki_bind_preview_url", "tenki_resize_volume",
		"tenki_cancel_template_build", "tenki_terminate_sandbox", "tenki_remove_path", "tenki_delete_volume",
		"tenki_build_template", // image_name publishes a new latest version of an existing reference
	];
	const notDestructive = mustBeDestructive.filter((n) => !destructive(n));
	check("tools that overwrite, modify, interrupt or delete carry destructiveHint", notDestructive.length === 0, notDestructive.join(","));
	const mustBeAdditive = ["tenki_create_sandbox", "tenki_run_code", "tenki_fork_sandbox", "tenki_git_clone", "tenki_create_snapshot", "tenki_extend_sandbox"];
	check("create/extend tools are additive (not read-only, not destructive)", mustBeAdditive.every(additive), mustBeAdditive.filter((n) => !additive(n)).join(","));
	check("git diff/log and read_file are read-only", ["tenki_git_diff", "tenki_git_log", "tenki_read_file"].every(ro));
	const misnamedReads = tools.filter((t) => /^tenki_(update|delete|terminate|remove|write|set)_/.test(t.name) && t.annotations.destructiveHint !== true).map((t) => t.name);
	check("no update/delete/terminate/remove/write/set tool claims to be non-destructive", misnamedReads.length === 0, misnamedReads.join(","));
	await client.close();
}

// 2) tenki_read_file: bounded, pageable, never splits a UTF-8 character
{
	const small = Buffer.from("hello\n");
	// 70 000 bytes: ASCII with a 3-byte character (€) straddling the 65 536 default cut.
	const big = Buffer.concat([Buffer.alloc(65_535, "a"), Buffer.from("€"), Buffer.alloc(4_462, "b")]);
	const client = await connect(new Stub({ "/home/tenki/small.txt": small, "/home/tenki/big.txt": big }));
	const read = (args) => client.callTool({ name: "tenki_read_file", arguments: { session_id: "s1", ...args } });

	const s = json(await read({ path: "/home/tenki/small.txt" }));
	check("small file → whole content, totalBytes, no truncation fields", s.content === "hello\n" && s.totalBytes === 6 && s.truncated === undefined && s.nextOffset === undefined, JSON.stringify(s));

	const p1 = json(await read({ path: "/home/tenki/big.txt" }));
	check("large file → default cap of 65536 bytes, truncated with nextOffset", p1.truncated === true && p1.totalBytes === 70_000 && Buffer.byteLength(p1.content) <= 65_536, JSON.stringify({ ...p1, content: p1.content.length }));
	check("cut backs off to a character boundary (no U+FFFD, € not split)", !p1.content.includes("�") && p1.nextOffset === 65_535, `nextOffset=${p1.nextOffset}`);
	const p2 = json(await read({ path: "/home/tenki/big.txt", offset: p1.nextOffset }));
	check("next page starts at nextOffset and finishes the file", p2.offset === 65_535 && p2.truncated === undefined && p2.content.startsWith("€"));
	check("pages reassemble the exact original bytes", Buffer.from(p1.content + p2.content).equals(big));

	const mid = json(await read({ path: "/home/tenki/big.txt", offset: 65_536 }));
	check("an offset inside a character moves forward to the next character", mid.offset === 65_538 && !mid.content.includes("�"), `offset=${mid.offset}`);
	const capped = json(await read({ path: "/home/tenki/big.txt", max_bytes: 1024 }));
	check("max_bytes bounds the returned content", Buffer.byteLength(capped.content) === 1024 && capped.nextOffset === 1024);
	const past = await read({ path: "/home/tenki/small.txt", offset: 7 });
	check("offset past the end → actionable error", past.isError === true && /past the end.*6 bytes/.test(text(past)), text(past));
	const tooBig = await read({ path: "/home/tenki/small.txt", max_bytes: 2_000_000 });
	check("max_bytes above 1 MiB rejected", tooBig.isError === true);
	await client.close();
}

// 2b) tenki_read_file on binary data (runs of stray UTF-8 continuation bytes):
// pages must advance AND tile the file exactly — no stall, no skipped bytes.
{
	/** Page through a file; returns the pages' [offset, bytesReturned] and whether it reached the end. */
	async function pageAll(client, path, maxBytes) {
		const pages = [];
		let off = 0;
		for (let i = 0; i < 50; i++) {
			const r = json(await client.callTool({ name: "tenki_read_file", arguments: { session_id: "s1", path, offset: off, max_bytes: maxBytes } }));
			const start = r.offset ?? 0;
			const len = r.bytesReturned ?? Buffer.byteLength(r.content);
			pages.push([start, len]);
			if (!r.truncated) return { pages, done: true, total: r.totalBytes };
			if (!(r.nextOffset > off)) return { pages, done: false, total: r.totalBytes };
			off = r.nextOffset;
		}
		return { pages, done: false };
	}
	const tiles = ({ pages, done, total }) =>
		done && pages[0][0] === 0 && pages.every(([o, n], i) => i === 0 || o === pages[i - 1][0] + pages[i - 1][1]) && pages.at(-1)[0] + pages.at(-1)[1] === total;
	const files = {
		"/home/tenki/run": Buffer.concat([Buffer.from("a"), Buffer.alloc(3000, 0x80)]),
		// Reviewer repro: a stray run straddling the 1024 cut used to lose a byte on the next page.
		"/home/tenki/straddle": Buffer.concat([Buffer.alloc(1021, "A"), Buffer.alloc(4, 0x80), Buffer.from("AB")]),
		// Mixed: valid multi-byte characters around stray bytes and a truncated sequence.
		"/home/tenki/mixed": Buffer.concat(Array.from({ length: 300 }, (_, i) => (i % 3 ? Buffer.from("x€y\u{1F600}", "utf8") : Buffer.from([0xe2, 0x82, 0x80, 0x80])))),
	};
	const client = await connect(new Stub(files));
	for (const p of Object.keys(files)) {
		const res = await pageAll(client, p, 1024);
		check(`binary data (${p.split("/").pop()}): pages advance and tile every byte exactly`, tiles(res), JSON.stringify(res.pages));
	}
	const mid = json(await client.callTool({ name: "tenki_read_file", arguments: { session_id: "s1", path: "/home/tenki/run", offset: 500, max_bytes: 1024 } }));
	check("binary data: an offset on a stray byte is not moved", mid.offset === 500, `offset=${mid.offset}`);
	await client.close();
}

// 3) git tools: typed args map onto GitOperation's string args; directory reaches checkout/diff/log
{
	const stub = new Stub();
	const client = await connect(stub);
	const sid = "22222222-2222-4222-8222-222222222222";
	const lastGit = () => stub.calls.filter((c) => c.method === "GitOperation").at(-1)?.body;

	await client.callTool({ name: "tenki_git_clone", arguments: { session_id: sid, repo: "https://github.com/octocat/Hello-World", depth: 1, directory: "/home/tenki/hw" } });
	let b = lastGit();
	check("clone → operation clone, depth as string, directory passed", b?.operation === "clone" && b?.args?.repo === "https://github.com/octocat/Hello-World" && b?.args?.depth === "1" && b?.args?.directory === "/home/tenki/hw" && b?.sessionId === sid, JSON.stringify(b));

	await client.callTool({ name: "tenki_git_checkout", arguments: { session_id: sid, ref: "feature", create: true, directory: "/home/tenki/hw" } });
	b = lastGit();
	check("checkout create:true → args.create 'true' + directory", b?.operation === "checkout" && b?.args?.ref === "feature" && b?.args?.create === "true" && b?.args?.directory === "/home/tenki/hw", JSON.stringify(b));
	await client.callTool({ name: "tenki_git_checkout", arguments: { session_id: sid, ref: "main" } });
	b = lastGit();
	check("checkout without create sends no create key", b?.args && !("create" in b.args) && !("directory" in b.args), JSON.stringify(b));

	await client.callTool({ name: "tenki_git_diff", arguments: { session_id: sid, base: "main", head: "feature", path: "src", directory: "hw" } });
	b = lastGit();
	check("diff → base/head/path/directory passed", b?.operation === "diff" && b?.args?.base === "main" && b?.args?.head === "feature" && b?.args?.path === "src" && b?.args?.directory === "hw", JSON.stringify(b));
	const before = stub.calls.length;
	const both = await client.callTool({ name: "tenki_git_diff", arguments: { session_id: sid, range: "a..b", base: "a" } });
	check("diff with range AND base rejected before any API call", both.isError === true && /range or base\/head/.test(text(both)) && stub.calls.length === before, text(both));

	await client.callTool({ name: "tenki_git_log", arguments: { session_id: sid, max_count: 5, directory: "/home/tenki/hw" } });
	b = lastGit();
	check("log → max_count as string + directory", b?.operation === "log" && b?.args?.max_count === "5" && b?.args?.directory === "/home/tenki/hw", JSON.stringify(b));

	// Values the engine puts in git's argv must not be read as options:
	// `git diff --output=<file>` truncates a file, `git clone --upload-pack=<cmd>` runs a command.
	const optionLike = [
		["tenki_git_diff", { range: "--output=/home/tenki/app.py" }],
		["tenki_git_diff", { base: "--output=/home/tenki/app.py" }],
		["tenki_git_diff", { head: "-o" }],
		["tenki_git_log", { range: "--output=/home/tenki/app.py" }],
		["tenki_git_log", { directory: "--output=x" }],
		["tenki_git_clone", { repo: "--upload-pack=touch /tmp/x" }],
		["tenki_git_clone", { repo: "https://example.com/r.git", directory: "--upload-pack=x" }],
		["tenki_git_clone", { repo: "https://example.com/r.git", branch: "--config=x" }],
		["tenki_git_checkout", { ref: "--orphan" }],
		// The engine re-trims with Go's strings.TrimSpace, which strips U+0085 (NEL); JS trim() does not.
		["tenki_git_diff", { range: "\u0085--output=/home/tenki/app.py" }],
		["tenki_git_clone", { repo: "\u0085 --upload-pack=touch /tmp/x" }],
		["tenki_git_checkout", { ref: " \u0085-b" }],
	];
	const beforeOpts = stub.calls.length;
	const accepted = [];
	for (const [name, args] of optionLike) {
		const r = await client.callTool({ name, arguments: { session_id: sid, ...args } });
		if (r.isError !== true || !/must not start with '-'/.test(text(r))) accepted.push(`${name} ${JSON.stringify(args)}`);
	}
	check("option-like git values (leading '-') are rejected before any API call", accepted.length === 0 && stub.calls.length === beforeOpts, accepted.join(" | "));

	// Output is capped like tenki_exec / tenki_read_file.
	stub.output = "x".repeat(70_000) + "€";
	const big = json(await client.callTool({ name: "tenki_git_log", arguments: { session_id: sid, directory: "hw" } }));
	check("git output over 64 KiB is truncated with totalBytes and a note", big.truncated === true && big.totalBytes === 70_003 && Buffer.byteLength(big.output) === 65_536 && /max_count/.test(big.note), JSON.stringify({ ...big, output: big.output?.length }));
	stub.output = "small";
	const smallOut = json(await client.callTool({ name: "tenki_git_log", arguments: { session_id: sid, directory: "hw" } }));
	check("small git output is returned unchanged with no truncation fields", smallOut.output === "small" && smallOut.truncated === undefined);
	await client.close();
}

// 4) tenki_open_preview: any port is passed through (the API reserves only 22)
{
	const stub = new Stub();
	const client = await connect(stub);
	const sid = "22222222-2222-4222-8222-222222222222";
	for (const port of [7681, 3000]) {
		await client.callTool({ name: "tenki_open_preview", arguments: { session_id: sid, port } });
		const b = stub.calls.filter((c) => c.method === "OpenPreview").at(-1)?.body;
		check(`open_preview sends port ${port} unchanged`, b?.port === port && b?.sessionId === sid, JSON.stringify(b));
	}
	await client.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
