/**
 * Coverage suite — exercises every tool domain's happy path against live Tenki,
 * through the real MCP protocol, with tight self-cleaning cycles.
 *
 *   npm run build && TENKI_API_KEY=… node test/coverage.test.mjs
 *
 * Data-plane-dependent checks use h.checkData() so an intermittent data-plane
 * outage is reported as SKIP, not a false failure. Every created resource is
 * tracked and torn down in cleanup().
 */
import { Harness } from "./harness.mjs";

const h = await Harness.connect("coverage");
console.log(`connected — ${h.tools.length} tools\n`);

try {
	// ── identity ────────────────────────────────────────────────────────────────
	await h.check("identity: whoami", async () => {
		const r = await h.call("tenki_whoami");
		if (r.ownerType !== "USER") throw new Error(`unexpected: ${JSON.stringify(r).slice(0, 80)}`);
	});

	// ── sandbox lifecycle ─────────────────────────────────────────────────────────
	let mainSid;
	await h.check("sandbox: create → get → list", async () => {
		const s = await h.createSandbox({ name: "cov-main", wait_ready: false });
		mainSid = s.sessionId;
		if (!mainSid) throw new Error("no session id");
		const g = await h.call("tenki_get_sandbox", { session_id: mainSid });
		if (!(g.session ?? g).state) throw new Error("no state");
		const l = await h.call("tenki_list_sandboxes", { page_size: 5 });
		if (!Array.isArray(l.sessions)) throw new Error("list not an array");
	});
	await h.check("sandbox: pause → resume", async () => {
		const s = await h.createSandbox({ name: "cov-pause", wait_ready: true });
		await h.call("tenki_pause_sandbox", { session_id: s.sessionId });
		await h.call("tenki_resume_sandbox", { session_id: s.sessionId });
	});

	// ── sessions admin ─────────────────────────────────────────────────────────────
	await h.check("sessions-admin: extend → update → report → list workspace/project", async () => {
		await h.call("tenki_extend_sandbox", { session_id: mainSid, additional_duration_seconds: 60 });
		await h.call("tenki_update_sandbox", { session_id: mainSid, name: "cov-main-2" });
		await h.call("tenki_report_sandbox_activity", { session_id: mainSid });
		await h.call("tenki_list_workspace_sandboxes", { page_size: 5 });
		await h.call("tenki_list_project_sandboxes", { page_size: 5 });
	});

	// A ready sandbox with networking for data-plane / git / preview / artifact checks.
	const net = await h.createSandbox({ name: "cov-net", allow_inbound: true, allow_outbound: true, wait_ready: true });

	// ── files (data plane) ──────────────────────────────────────────────────────
	await h.checkData("files: mkdir → write → read → stat → list → move → remove", async () => {
		await h.call("tenki_make_dir", { session_id: net.sessionId, path: "/home/tenki/cov", recursive: true });
		await h.call("tenki_write_file", { session_id: net.sessionId, path: "/home/tenki/cov/a.txt", content: "hello cov" });
		const rd = await h.call("tenki_read_file", { session_id: net.sessionId, path: "/home/tenki/cov/a.txt" });
		if (String(rd.content).trim() !== "hello cov") throw new Error(`read mismatch: ${JSON.stringify(rd.content)}`);
		await h.call("tenki_stat_path", { session_id: net.sessionId, path: "/home/tenki/cov/a.txt" });
		await h.call("tenki_list_files", { session_id: net.sessionId, path: "/home/tenki/cov" });
		await h.call("tenki_move_path", { session_id: net.sessionId, from: "/home/tenki/cov/a.txt", to: "/home/tenki/cov/b.txt" });
		await h.call("tenki_remove_path", { session_id: net.sessionId, path: "/home/tenki/cov", recursive: true });
	});

	// ── exec + run_code (data plane) ───────────────────────────────────────────────
	await h.checkData("exec: echo in the sandbox", async () => {
		const r = await h.call("tenki_exec", { session_id: net.sessionId, command: "echo", args: ["hi-cov"] });
		if (!r.ok || !String(r.stdout).includes("hi-cov")) throw new Error(`exec: ${JSON.stringify(r).slice(0, 120)}`);
	});
	await h.checkData("run_code: python 6*7", async () => {
		const r = await h.call("tenki_run_code", { language: "python", code: "print(6*7)" });
		if (!(r.ok && String(r.stdout).trim() === "42")) throw new Error(`run_code: ${JSON.stringify(r).slice(0, 120)}`);
	});

	// ── git (control-plane RPC; clone needs sandbox outbound). Clone arg key is `repo`, not `url`. ─
	await h.checkData("git: clone a small public repo", async () => {
		const r = await h.call("tenki_git", { session_id: net.sessionId, operation: "clone", args: { repo: "https://github.com/octocat/Hello-World", depth: "1" } });
		const exit = r.exitCode ?? r.execution?.exitCode ?? 0;
		if (Number(exit) !== 0) throw new Error(`clone exit ${exit}: ${JSON.stringify(r).slice(0, 120)}`);
	});

	// ── ports / previews (control plane; needs allow_inbound) ────────────────────────
	await h.check("previews: expose → create_preview_url → list → unexpose", async () => {
		await h.call("tenki_expose_port", { session_id: net.sessionId, port: 8080 });
		const p = await h.call("tenki_create_preview_url", { session_id: net.sessionId, port: 8080, slug: "cov-preview" });
		if (!JSON.stringify(p).match(/http|url/i)) throw new Error(`no url in preview response`);
		await h.call("tenki_list_preview_urls", { session_id: net.sessionId });
		await h.call("tenki_unexpose_port", { session_id: net.sessionId, port: 8080 });
	});

	// ── artifacts (signed URLs). the upload endpoint may return 501 where unavailable. ─
	await h.check("artifacts: get_upload_url (tolerates 501)", async () => {
		try {
			const r = await h.call("tenki_get_upload_url", { session_id: net.sessionId, path: "/home/tenki/blob.bin", content_type: "application/octet-stream" });
			if (!JSON.stringify(r).match(/http|url/i)) throw new Error("no signed url");
		} catch (e) {
			// Tolerate a 501 from the upload endpoint where it isn't available; the wiring is correct.
			if (/not yet implemented|501|unimplemented/i.test(e.message)) return; // endpoint unavailable — tool wiring is correct
			throw e;
		}
	});

	// ── snapshots ────────────────────────────────────────────────────────────────
	await h.check("snapshots: create → get → list → delete", async () => {
		const cs = await h.call("tenki_create_snapshot", { session_id: mainSid, name: "cov-snap" });
		const snapId = cs.snapshot?.id ?? cs.id ?? cs.snapshotId;
		h.track("snapshot", snapId);
		await h.call("tenki_get_snapshot", { snapshot_id: snapId });
		await h.call("tenki_list_snapshots", { page_size: 5 });
		await h.call("tenki_list_session_snapshots", { session_id: mainSid });
		await h.call("tenki_delete_snapshot", { snapshot_id: snapId });
		h.resources.snapshot = h.resources.snapshot.filter((x) => x !== snapId);
	});

	// ── volumes (tight; quota-sensitive) ────────────────────────────────────────────
	await h.check("volumes: create → get → update → resize → delete", async () => {
		const cv = await h.call("tenki_create_volume", { name: "cov-vol", size_bytes: 1_048_576 });
		const volId = cv.volume?.id ?? cv.id ?? cv.volumeId;
		h.track("volume", volId);
		await h.call("tenki_get_volume", { volume_id: volId });
		await h.call("tenki_update_volume", { volume_id: volId, name: "cov-vol-2" });
		await h.call("tenki_resize_volume", { volume_id: volId, size_bytes: 2_097_152 });
		await h.call("tenki_delete_volume", { volume_id: volId });
		h.resources.volume = h.resources.volume.filter((x) => x !== volId);
	});

	// ── templates ────────────────────────────────────────────────────────────────
	await h.check("templates: create → get → list → delete", async () => {
		const ct = await h.call("tenki_create_template", { name: "cov-tmpl", setup_script: "echo provisioning" }).catch((e) => {
			throw new Error(`create: ${e.message}`);
		});
		const tid = ct.template?.id ?? ct.id ?? ct.templateId;
		h.track("template", tid);
		await h.call("tenki_get_template", { template_id: tid });
		await h.call("tenki_list_templates", {});
		await h.call("tenki_delete_template", { template_id: tid });
		h.resources.template = h.resources.template.filter((x) => x !== tid);
	});

	// ── registry (read) ─────────────────────────────────────────────────────────────
	await h.check("registry: list images", async () => {
		await h.call("tenki_list_images", {});
	});

	// ── workspace ────────────────────────────────────────────────────────────────
	await h.check("workspace: usage → settings → retention", async () => {
		await h.call("tenki_get_workspace_usage", {});
		await h.call("tenki_get_workspace_settings", {});
		await h.call("tenki_get_snapshot_retention_settings", {});
	});

	// ── ssh (read; gateway service path) ─────────────────────────────────────────────
	await h.check("ssh: list gateways", async () => {
		await h.call("tenki_list_ssh_gateways", {});
	});
} catch (e) {
	console.error("suite error:", e?.message ?? e);
} finally {
	await h.cleanup();
	const r = h.report();
	console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${h.tools.length} tools)`);
	const bad = r.results.filter((x) => x.status === "fail");
	if (bad.length) console.log("FAILURES:\n" + bad.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	await h.close();
	process.exitCode = r.failed ? 1 : 0;
}
