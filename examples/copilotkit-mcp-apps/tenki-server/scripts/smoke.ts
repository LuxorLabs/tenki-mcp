/**
 * Smoke test: talk to the running MCP App server exactly the way CopilotKit's
 * middleware does (UI extension capability, one connection per call), and
 * exercise every model-facing app plus the app-only tools the widgets use.
 *
 *   npx tsx scripts/smoke.ts            # against http://localhost:3108/mcp
 *   npx tsx scripts/smoke.ts --keep     # leave the sandboxes running
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const URL_ = process.env.MCP_URL || "http://localhost:3108/mcp";
const keep = process.argv.includes("--keep");

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
	const client = new Client(
		{ name: "smoke", version: "0.0.0" },
		{ capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } as never },
	);
	const token = process.env.MCP_TOKEN;
	await client.connect(
		new StreamableHTTPClientTransport(new URL(URL_), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined),
	);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

const call = (name: string, args: Record<string, unknown>) =>
	withClient(async (c) => {
		const t = Date.now();
		const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
		const s = (r.structuredContent ?? {}) as Record<string, any>;
		console.log(`\n■ ${name} (${Date.now() - t}ms)${r.isError ? " — ERROR" : ""}`);
		return { r, s };
	});

function assert(cond: unknown, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else console.log(`✓ ${msg}`);
}

const tools = await withClient((c) => c.listTools());
const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
const modelFacing = tools.tools.filter((t) => (t._meta as any)?.ui?.resourceUri).map((t) => t.name);
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
assert(modelFacing.sort().join() === "launch_web_app,run_code_in_sandbox,show_sandbox_fleet", `model-facing apps: ${modelFacing.join(", ")}`);
assert((byName.vm_exec?._meta as any)?.ui?.visibility?.[0] === "app", "vm_exec is app-only");

for (const uri of ["ui://tenki/sandbox-console.html", "ui://tenki/live-preview.html", "ui://tenki/fleet.html"]) {
	const res = await withClient((c) => c.readResource({ uri }));
	const text = String((res.contents[0] as any).text ?? "");
	assert(text.includes("__TENKI_VIEW__") && text.length > 10_000, `resource ${uri} (${Math.round(text.length / 1024)} KB)`);
}

const run = await call("run_code_in_sandbox", {
	title: "Smoke: primes",
	language: "python",
	code: "import platform\nprimes=[n for n in range(2,60) if all(n%d for d in range(2,int(n**.5)+1))]\nprint(primes)\nprint(platform.platform())\n",
});
console.log((run.r.content[0] as any).text);
assert(!run.r.isError && run.s.sandbox?.id, "run_code_in_sandbox booted a sandbox");
assert(run.s.mode === "simulated" || run.s.run?.stdout.includes("[2, 3, 5, 7"), "program output came back");
const vmId: string = run.s.sandbox?.id;

const again = await call("run_code_in_sandbox", { title: "Smoke: reuse", language: "shell", code: "echo reused; ls -la", sandbox_id: vmId });
assert(again.s.reused === true && again.s.timings?.bootMs === null, "sandbox_id reuses the sandbox without booting");

const exec = await call("vm_exec", { sandbox_id: vmId, command: "uname -a && whoami && pwd" });
console.log(exec.s.run);
assert(!exec.r.isError, "vm_exec ran a shell command");

const rerun = await call("vm_run_code", { sandbox_id: vmId, language: "javascript", code: "console.log('node', process.version, 6*7)" });
console.log(rerun.s.run);
assert(!rerun.r.isError, "vm_run_code re-ran edited code");

const web = await call("launch_web_app", {
	title: "Smoke: hello page",
	html: "<!doctype html><title>hi</title><h1 style='font-family:sans-serif'>Hello from a Tenki Sandbox</h1>",
});
console.log((web.r.content[0] as any).text);
assert(!web.r.isError && web.s.previewUrl, "launch_web_app returned a preview URL");
if (web.s.previewUrl) {
	const page = await fetch(web.s.previewUrl).then(async (r) => `${r.status} ${(await r.text()).slice(0, 80)}`).catch((e) => String(e));
	console.log("preview GET:", page);
	assert(page.startsWith("200") && page.includes("Hello"), "preview URL serves the page");
}

const logs = await call("vm_logs", { sandbox_id: web.s.sandbox?.id, port: 8080 });
console.log(logs.s.log);

const fleet = await call("show_sandbox_fleet", {});
console.log((fleet.r.content[0] as any).text);
assert((fleet.s.vms ?? []).some((v: any) => v.id === vmId), "fleet lists the demo VMs");

const guard = await call("vm_destroy", { sandbox_id: "00000000-0000-0000-0000-000000000000" });
assert(guard.r.isError, "destroying an unknown sandbox is refused");

if (!keep) {
	const all = await call("fleet_destroy_all", {});
	console.log(all.s);
	assert(all.s.destroyed >= 2, "fleet_destroy_all cleaned up");
}
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
