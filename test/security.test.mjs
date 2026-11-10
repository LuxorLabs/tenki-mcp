/**
 * Offline security-control tests (dummy key, zero network): MCP tool annotations
 * and the least-privilege env controls. Regression guard for SECURITY.md claims.
 *
 *   npm run build && node test/security.test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "index.js");
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

/** Spawn the server with extra env and return its advertised tools (offline). */
async function toolsWith(env) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER],
		env: { ...process.env, TENKI_API_KEY: "tk_dummy", ...env },
		stderr: "ignore",
	});
	const client = new Client({ name: "sec-test", version: "1.0.0" });
	await client.connect(transport);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

try {
	// 1) Default mode: annotations present + correct
	const def = await toolsWith({});
	check("default advertises 82 tools (81 + tenki_auth_status)", def.length === 82, `${def.length}`);
	const byName = Object.fromEntries(def.map((t) => [t.name, t]));
	check("read tools carry readOnlyHint", byName["tenki_whoami"]?.annotations?.readOnlyHint === true && byName["tenki_get_sandbox"]?.annotations?.readOnlyHint === true);
	check("destructive tools carry destructiveHint", byName["tenki_terminate_sandbox"]?.annotations?.destructiveHint === true && byName["tenki_delete_volume"]?.annotations?.destructiveHint === true && byName["tenki_delete_template_build"]?.annotations?.destructiveHint === true && byName["tenki_delete_egress_policy"]?.annotations?.destructiveHint === true);
	check("egress policy reads are read-only, create/update are not", byName["tenki_get_egress_policy"]?.annotations?.readOnlyHint === true && byName["tenki_list_egress_policies"]?.annotations?.readOnlyHint === true && byName["tenki_create_egress_policy"]?.annotations?.readOnlyHint !== true && byName["tenki_update_egress_policy"]?.annotations?.readOnlyHint !== true);
	check("additive tools are NOT readOnly and NOT destructive", byName["tenki_run_code"]?.annotations?.readOnlyHint === false && byName["tenki_create_sandbox"]?.annotations?.readOnlyHint === false && byName["tenki_create_sandbox"]?.annotations?.destructiveHint === false);
	check("overwrite/modify tools carry destructiveHint (exec, write_file, update_*, git checkout)", ["tenki_exec", "tenki_write_file", "tenki_update_sandbox", "tenki_update_egress_policy", "tenki_git_checkout"].every((n) => byName[n]?.annotations?.destructiveHint === true));
	check("fork_sandbox spends (not read-only, not destructive); list_ci_runner_sizes is read-only", byName["tenki_fork_sandbox"]?.annotations?.readOnlyHint !== true && byName["tenki_fork_sandbox"]?.annotations?.destructiveHint !== true && byName["tenki_list_ci_runner_sizes"]?.annotations?.readOnlyHint === true);
	check("every tool declares openWorldHint (hits external API)", def.every((t) => t.annotations?.openWorldHint === true));
	// Boundary cases the name-prefix heuristic must get right (not tautological):
	check("get_upload_url is NOT read-only and IS destructive (its signed PUT can overwrite a file)", byName["tenki_get_upload_url"]?.annotations?.readOnlyHint === false && byName["tenki_get_upload_url"]?.annotations?.destructiveHint === true);
	check("read_file IS read-only", byName["tenki_read_file"]?.annotations?.readOnlyHint === true);
	check("git diff/log ARE read-only although their names lack a read prefix", byName["tenki_git_diff"]?.annotations?.readOnlyHint === true && byName["tenki_git_log"]?.annotations?.readOnlyHint === true);

	// 2) TENKI_MCP_READONLY: only read tools survive
	const ro = await toolsWith({ TENKI_MCP_READONLY: "1" });
	check("read-only mode registers fewer tools", ro.length > 0 && ro.length < def.length, `${ro.length}`);
	check("read-only mode exposes ZERO destructive tools", ro.every((t) => t.annotations?.destructiveHint !== true));
	check("read-only mode exposes ONLY read-only tools", ro.every((t) => t.annotations?.readOnlyHint === true));
	check("read-only mode drops run_code / create / fork / delete", !ro.some((t) => ["tenki_run_code", "tenki_create_sandbox", "tenki_fork_sandbox", "tenki_delete_volume"].includes(t.name)));
	check("read-only mode DROPS get_upload_url (write capability)", !ro.some((t) => t.name === "tenki_get_upload_url"));
	check("read-only mode KEEPS read_file (pure read)", ro.some((t) => t.name === "tenki_read_file"));
	check("read-only mode keeps git diff/log and drops git clone/checkout", ["tenki_git_diff", "tenki_git_log"].every((n) => ro.some((t) => t.name === n)) && !ro.some((t) => ["tenki_git_clone", "tenki_git_checkout"].includes(t.name)));

	// 3) TENKI_MCP_DISABLED_TOOLS: named denylist. tenki_exec is included
	// deliberately — it registers via registerTool, so this also proves the
	// modern registration path honors the denylist.
	const den = await toolsWith({ TENKI_MCP_DISABLED_TOOLS: "tenki_run_code,tenki_terminate_sandbox,tenki_exec" });
	check("denylist removes exactly the named tools", den.length === def.length - 3 && !den.some((t) => ["tenki_run_code", "tenki_terminate_sandbox", "tenki_exec"].includes(t.name)), `${den.length}`);
} catch (e) {
	console.error("  ✗ " + (e?.message ?? e));
	fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
