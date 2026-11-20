/**
 * MCP Apps widgets (ui://luxor/*) — OFFLINE, zero network calls.
 * Proves: the run/exec, expose-port and file tools advertise _meta.ui.resourceUri;
 * the three ui:// resources list and read back as self-contained
 * text/html;profile=mcp-app documents whose inline scripts parse; they are
 * served without a credential; and the files widget calls the advertised
 * (prefixed) tool names.
 *
 *   npm run build && node test/mcp-apps.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
const MIME = "text/html;profile=mcp-app";
const EXPECTED = {
	tenki_run_code: "ui://luxor/terminal",
	tenki_exec: "ui://luxor/terminal",
	tenki_expose_port: "ui://luxor/preview",
	tenki_create_preview_url: "ui://luxor/preview",
	tenki_list_files: "ui://luxor/files",
	tenki_read_file: "ui://luxor/files",
};
const URIS = [...new Set(Object.values(EXPECTED))];

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

async function connectWith(env, name) {
	const t = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...process.env, TENKI_API_ENDPOINT: "http://127.0.0.1:1", LUXOR_MCP_TOOL_PREFIX: "", ...env },
		stderr: "ignore",
	});
	const c = new Client({ name, version: "1.0.0" });
	await c.connect(t);
	return c;
}

const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// 1) Tool metadata + resources with a credential.
{
	const c = await connectWith({ TENKI_API_KEY: "tk_offline_dummy_key" }, "mcp-apps");
	const { tools } = await c.listTools();
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
	for (const [name, uri] of Object.entries(EXPECTED)) {
		const meta = byName[name]?._meta;
		check(`${name} → _meta.ui.resourceUri ${uri}`, meta?.ui?.resourceUri === uri, JSON.stringify(meta));
		check(`${name} → legacy _meta["ui/resourceUri"]`, meta?.["ui/resourceUri"] === uri);
	}
	const withUi = tools.filter((t) => t._meta?.ui);
	check("only the widget tools carry _meta.ui", withUi.length === Object.keys(EXPECTED).length, withUi.map((t) => t.name).join(","));
	check("annotations survive the _meta merge", byName.tenki_exec?.annotations?.destructiveHint === true && byName.tenki_read_file?.annotations?.readOnlyHint === true);

	const { resources } = await c.listResources();
	for (const uri of URIS) {
		const r = resources.find((x) => x.uri === uri);
		check(`resources/list includes ${uri} as ${MIME}`, r?.mimeType === MIME, JSON.stringify(r));
	}

	for (const uri of URIS) {
		const { contents } = await c.readResource({ uri });
		const [body] = contents;
		const html = body?.text ?? "";
		check(`${uri}: one content with mimeType ${MIME}`, contents.length === 1 && body.mimeType === MIME && body.uri === uri);
		check(`${uri}: is an HTML document`, /^<!doctype html>/i.test(html) && html.includes("</html>"));
		check(`${uri}: does the ui/initialize handshake`, html.includes('"ui/initialize"') && html.includes('"ui/notifications/initialized"'));
		check(`${uri}: listens for tool-input and tool-result`, html.includes("ui/notifications/tool-input") && html.includes("ui/notifications/tool-result"));
		check(`${uri}: self-contained (no external script/style/link)`, !/<(script|link)[^>]+(src|href)=/i.test(html) && !/@import|fetch\(|XMLHttpRequest/.test(html));
		check(`${uri}: never writes untrusted data via innerHTML`, !/innerHTML|insertAdjacentHTML|document\.write/.test(html));
		const scripts = scriptsOf(html);
		let parseError = "";
		try { for (const s of scripts) new Function(s); } catch (e) { parseError = e.message; }
		// Widget code runs in its own scope: a global `function parent()` once
		// shadowed window.parent and silently cut the widget off from its host.
		check(`${uri}: widget code is scoped and posts via a captured host window`, html.includes('(function(){"use strict";') && html.includes("var host=window.parent") && !/window\.parent\.postMessage/.test(html));
		check(`${uri}: inline script parses`, scripts.length === 1 && !parseError, parseError);
	}

	const preview = (await c.readResource({ uri: "ui://luxor/preview" })).contents[0];
	check("preview declares frameDomains for sandbox preview hosts", preview._meta?.ui?.csp?.frameDomains?.includes("https://*.sb.tenki.sh"), JSON.stringify(preview._meta));
	const files = (await c.readResource({ uri: "ui://luxor/files" })).contents[0].text;
	check("files widget calls tenki_list_files / tenki_read_file", files.includes('"list":"tenki_list_files"') && files.includes('"read":"tenki_read_file"'));

	let unknown = false;
	try { await c.readResource({ uri: "ui://luxor/nope" }); } catch { unknown = true; }
	check("unknown ui:// uri is rejected", unknown);
	await c.close();
}

// 2) luxor_* prefix: metadata keys off the canonical name; widget uses advertised names.
{
	const c = await connectWith({ TENKI_API_KEY: "tk_offline_dummy_key", LUXOR_MCP_TOOL_PREFIX: "luxor" }, "mcp-apps-luxor");
	const { tools } = await c.listTools();
	const exec = tools.find((t) => t.name === "luxor_exec");
	check("luxor prefix: luxor_exec carries the terminal widget", exec?._meta?.ui?.resourceUri === "ui://luxor/terminal", JSON.stringify(exec?._meta));
	const files = (await c.readResource({ uri: "ui://luxor/files" })).contents[0].text;
	check("luxor prefix: files widget calls luxor_list_files / luxor_read_file", files.includes('"list":"luxor_list_files"') && files.includes('"read":"luxor_read_file"'));
	await c.close();
}

// 3) No credential: widgets are still served (static HTML, no API access).
{
	const c = await connectWith({ TENKI_API_KEY: "", TENKI_AUTH_TOKEN: "", LUXOR_API_KEY: "", LUXOR_AUTH_TOKEN: "" }, "mcp-apps-noauth");
	const { resources } = await c.listResources();
	check("no credential → all three widgets still listed", URIS.every((u) => resources.some((r) => r.uri === u)));
	await c.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
