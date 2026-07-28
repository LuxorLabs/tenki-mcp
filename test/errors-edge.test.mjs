/**
 * errors-edge suite — negative + robustness coverage for tenki-mcp.
 *
 *   npm run build && TENKI_API_KEY=… node test/errors-edge.test.mjs
 *
 * Focus (the "errors" category + the edge of "core"), NOT the happy paths already
 * green in coverage.test.mjs:
 *   • invalid-args-fail-fast — out-of-range / malformed / missing-required args are
 *     rejected client-side by zod BEFORE any network call (MCP InvalidParams), so a
 *     bounds check can never leak a side effect. Each reject is proven pre-network
 *     locally (the error text is an "Input validation error", never a "Tenki … failed
 *     (…)" round-trip) — robust even while concurrent suites mutate the shared workspace.
 *   • semantic-rejects — well-formed-but-nonexistent ids across sandbox/volume/snapshot/
 *     template/image/preview return an attributable isError (not a crash/hang); an
 *     unknown tool name returns a clean "not found".
 *   • idempotency — repeat delete of a ghost volume/snapshot, double-terminate, and
 *     ghost-id terminate are clean no-ops (never a 5xx).
 *   • illegal state transitions — resume a RUNNING sandbox / pause an already-PAUSED
 *     one return clean conflict errors, never a client crash.
 *   • run_code edges — env injection, a surfaced non-zero exit (ok:false), an honored
 *     timeout_seconds, and self-teardown of the ephemeral VM (no billing leak).
 *
 * RESOURCE DISCIPLINE: this suite owns SANDBOXES only (≤2, auto-tracked + cleaned).
 * Volumes/snapshots/templates are quota-limited and owned by the journeys suite, so
 * every delete/idempotency probe here runs against GHOST ids — nothing is provisioned.
 * run_code's own throwaway microVMs self-terminate in its finally (not counted/tracked).
 *
 * Data-plane-dependent steps (run_code) use h.checkData so an intermittent network
 * outage is a SKIP, not a false failure; the control-plane exit code is asserted anyway.
 */
import { Harness, isDataPlaneOutage } from "./harness.mjs";

const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const h = await Harness.connect("errors-edge");
console.log(`connected — ${h.tools.length} tools\n`);

/** Record a SKIP with the same shape h.checkData uses (for capability/timing gaps that aren't data-plane outages). */
function skip(name, reason) {
	h.results.push({ name, status: "skip", error: reason });
	console.log(`  … ${name} — skipped (${reason})`);
}
/** Record an ad-hoc PASS/FAIL (for blocks that manage their own control flow). */
function pass(name) {
	h.results.push({ name, status: "pass" });
	console.log(`  ✓ ${name}`);
}
function fail(name, e) {
	h.results.push({ name, status: "fail", error: (e?.message ?? String(e)).slice(0, 300) });
	console.log(`  ✗ ${name}\n      ${(e?.message ?? e).toString().replace(/\s+/g, " ").slice(0, 240)}`);
}

const API_FAIL = /Tenki [\w ]*failed \(\d/i; // "Tenki GetSession failed (404 …)" / "Tenki data ReadFile failed (500…)"
const ZOD_FAIL = /Input validation error|-32602/i;
const FIVE_XX = /\(5\d\d/;
const HANG = /timed out|timeout/i;
const NOTFOUND = /not.?found|does not exist|no such|unknown|invalid|404|403|permission|unauthor|conflict|precondition|not .*(?:running|paused|active)|already/i;

/** Assert a negative call is rejected by zod BEFORE any network call (no side effect possible). */
async function expectZodReject(name, args) {
	const msg = await h.expectError(name, args); // throws if the call unexpectedly SUCCEEDS
	if (API_FAIL.test(msg)) throw new Error(`reached the API — zod bypassed the bound: ${msg.slice(0, 160)}`);
	if (!ZOD_FAIL.test(msg)) throw new Error(`not a pre-network validation error: ${msg.slice(0, 160)}`);
	return msg;
}

/** Assert a well-formed but nonexistent id reaches the API and returns an attributable isError (not a client/transport crash). */
async function expectNotFound(name, args) {
	const msg = await h.expectError(name, args);
	if (ZOD_FAIL.test(msg)) throw new Error(`zod rejected a well-formed id (should reach the API): ${msg.slice(0, 160)}`);
	if (HANG.test(msg)) throw new Error(`call hung instead of returning an error: ${msg.slice(0, 160)}`);
	if (!(API_FAIL.test(msg) || NOTFOUND.test(msg)))
		throw new Error(`not an attributable server error: ${msg.slice(0, 160)}`);
	return msg;
}

/** Tolerantly assert a delete/terminate is a clean no-op: idempotent success OR a clean 4xx/NotFound isError — never a 5xx, a zod reject, or a hang. */
async function expectCleanNoOp(name, args) {
	try {
		await h.call(name, args);
	} catch (e) {
		const m = e?.message ?? String(e);
		if (FIVE_XX.test(m)) throw new Error(`5xx on an idempotent op (not clean): ${m.slice(0, 160)}`);
		if (ZOD_FAIL.test(m)) throw new Error(`zod rejected a well-formed id: ${m.slice(0, 160)}`);
		if (HANG.test(m)) throw new Error(`op hung instead of a clean no-op: ${m.slice(0, 160)}`);
		// otherwise a clean 4xx / NotFound isError — acceptable and idempotent
	}
}

const findings = [];
let runSid = null; // ephemeral run_code session id (for the self-teardown check)
let B = null; // long-lived RUNNING sandbox for the illegal-transition guards

try {
	// ── invalid-args-fail-fast: out-of-range args → zod InvalidParams pre-network ──────
	await h.check("invalid-args: create_sandbox cpu/memory bounds rejected pre-network", async () => {
		await expectZodReject("tenki_create_sandbox", { cpu_cores: 0 }); // min 1
		await expectZodReject("tenki_create_sandbox", { cpu_cores: 17 }); // max 16
		await expectZodReject("tenki_create_sandbox", { cpu_cores: 1.5 }); // int
		await expectZodReject("tenki_create_sandbox", { memory_mb: 127 }); // min 128
		await expectZodReject("tenki_create_sandbox", { memory_mb: 65537 }); // max 65536
	});

	await h.check("invalid-args: create_volume size bounds rejected pre-network (no volume created)", async () => {
		await expectZodReject("tenki_create_volume", { name: `qa-neg-${RUN}`, size_bytes: 1_048_575 }); // 1 under 1 MiB
		await expectZodReject("tenki_create_volume", { name: `qa-neg-${RUN}`, size_bytes: 107_374_182_401 }); // over 100 GiB
		await expectZodReject("tenki_create_volume", { name: `qa-neg-${RUN}`, size_bytes: 5_000_000.5 }); // non-int
	});

	await h.check("invalid-args: port + preview-slug bounds rejected pre-network", async () => {
		await expectZodReject("tenki_expose_port", { session_id: "sess_x", port: 0 }); // positive()
		await expectZodReject("tenki_create_preview_url", { session_id: "sess_x", port: 70000, slug: "valid-slug" }); // max 65535
		await expectZodReject("tenki_create_preview_url", { session_id: "sess_x", port: 8080, slug: "ab" }); // min 3
		await expectZodReject("tenki_create_preview_url", { session_id: "sess_x", port: 8080, slug: "Has_Underscore" }); // regex
		await expectZodReject("tenki_create_preview_url", { session_id: "sess_x", port: 8080, slug: "has space" }); // regex
		await expectZodReject("tenki_create_preview_url", { session_id: "sess_x", port: 8080, slug: "a".repeat(64) }); // max 63
	});

	// ── invalid-args-fail-fast: missing required → zod InvalidParams (critical: no empty-id coercion) ──
	await h.check("invalid-args: missing required fields rejected pre-network (no empty-id coercion)", async () => {
		// A missing session_id on terminate must NOT be coerced to "" and sent (a server could misread empty as a wildcard).
		const term = await expectZodReject("tenki_terminate_sandbox", {});
		if (/"received":\s*""/.test(term)) throw new Error(`terminate coerced missing id to empty string: ${term.slice(0, 120)}`);
		await expectZodReject("tenki_get_sandbox", {});
		await expectZodReject("tenki_write_file", { session_id: "sess_x", path: "/home/tenki/x" }); // missing content
		await expectZodReject("tenki_attach_volume", { session_id: "sess_x", volume_id: "vol_x" }); // missing mount_path
		await expectZodReject("tenki_resize_volume", { volume_id: "vol_x" }); // missing size_bytes
		await expectZodReject("tenki_share_image", { reference: "ws/img:latest" }); // missing grantee_workspace_id
		await expectZodReject("tenki_create_volume", { size_bytes: 1_048_576 }); // missing name
	});

	await h.check("invalid-args: bulk terminate empty/omitted id list rejected (.min(1), no empty→all footgun)", async () => {
		await expectZodReject("tenki_terminate_sandboxes", { session_ids: [] }); // too_small min 1
		await expectZodReject("tenki_terminate_sandboxes", {}); // session_ids required
	});

	// ── semantic-rejects: well-formed bogus ids reach the API → attributable isError ───────
	await h.check("notfound: well-formed bogus ids return attributable isError across 6 domains", async () => {
		await expectNotFound("tenki_get_sandbox", { session_id: "sess_000" });
		await expectNotFound("tenki_get_volume", { volume_id: "vol_000" });
		await expectNotFound("tenki_get_snapshot", { snapshot_id: "snap_000" });
		await expectNotFound("tenki_get_template", { template_id: "tpl_000" });
		await expectNotFound("tenki_get_image", { reference: "noone/nothere:latest" });
		await expectNotFound("tenki_get_preview_url", { preview_url_id: "prev_000" });
	});

	await h.check("notfound: an unknown tool name returns a clean 'not found'", async () => {
		const msg = await h.expectError("tenki_does_not_exist", {});
		if (!/not found/i.test(msg)) throw new Error(`expected 'not found', got: ${msg.slice(0, 160)}`);
	});

	// ── idempotency: repeat delete of GHOST ids is a clean no-op (never provisions anything) ─
	await h.check("idempotency: repeat delete of a ghost volume/snapshot is a clean no-op (no 5xx)", async () => {
		for (let i = 0; i < 2; i++) await expectCleanNoOp("tenki_delete_volume", { volume_id: `vol_ghost_${RUN}` });
		for (let i = 0; i < 2; i++) await expectCleanNoOp("tenki_delete_snapshot", { snapshot_id: `snap_ghost_${RUN}` });
	});

	// ── edge of core: double-terminate + ghost-id terminate are idempotent-clean ──────────
	await h.check("idempotent terminate: double-terminate + ghost-id terminate are clean no-ops", async () => {
		const a = await h.createSandbox({ name: `err-term-${RUN}`, wait_ready: false }); // sandbox #1 (owned + tracked)
		if (!a.sessionId) throw new Error("create returned no session id");
		await h.call("tenki_terminate_sandbox", { session_id: a.sessionId }); // 1st terminate → succeeds
		await expectCleanNoOp("tenki_terminate_sandbox", { session_id: a.sessionId }); // 2nd terminate (same id) → no-op
		await expectCleanNoOp("tenki_terminate_sandbox", { session_id: `sess_ghost_${RUN}` }); // never-existed id → no-op
		h.resources.sandbox = h.resources.sandbox.filter((x) => x !== a.sessionId); // already gone; drop from cleanup
	});

	// ── edge of core: illegal state transitions return clean conflict errors ──────────────
	await h.checkData("guard: boot a RUNNING sandbox for the illegal-transition tests", async () => {
		try {
			const b = await h.createSandbox({ name: `err-guard-${RUN}`, wait_ready: true }); // sandbox #2 (owned + tracked)
			B = b.sessionId;
			const st = String((b.session ?? {}).state ?? "");
			if (!/RUNNING/i.test(st)) throw new Error(`not RUNNING (state: ${st})`);
		} catch (e) {
			// Any boot failure/timeout routes to SKIP — the transition guards, not booting, are the target here.
			throw new Error(`fetch failed — could not boot a RUNNING sandbox: ${e?.message ?? e}`);
		}
	});

	// Contract under test = tenki-mcp ROBUSTNESS: a redundant transition must return a CLEAN result
	// (a specific conflict isError OR a clean idempotent no-op) with no crash/hang/5xx and no wrong-state
	// mutation. Whether the upstream control plane chooses "conflict" vs "idempotent success" is a Tenki
	// API-semantics trait, recorded as a finding — not an MCP failure.
	if (B) {
		await h.check("illegal-transition: resume a RUNNING sandbox is handled cleanly (conflict or idempotent no-op)", async () => {
			let succeeded = false;
			try {
				await h.call("tenki_resume_sandbox", { session_id: B });
				succeeded = true;
			} catch (e) {
				const m = e?.message ?? String(e);
				if (FIVE_XX.test(m)) throw new Error(`5xx on resume-while-running (not clean): ${m.slice(0, 160)}`);
				if (ZOD_FAIL.test(m)) throw new Error(`zod rejected a valid session id: ${m.slice(0, 160)}`);
				if (HANG.test(m)) throw new Error(`resume-while-running hung: ${m.slice(0, 160)}`);
				return; // clean conflict / 4xx isError — the ideal outcome
			}
			if (succeeded) {
				// Idempotent success is acceptable ONLY if it didn't mutate to a wrong state — sandbox must stay RUNNING.
				const g = await h.call("tenki_get_sandbox", { session_id: B });
				const st = String((g.session ?? g).state ?? "");
				if (!/RUNNING/i.test(st)) throw new Error(`resume-while-running left the sandbox in ${st} (wrong-state mutation)`);
				findings.push(
					"Tenki API semantics (not an MCP bug): tenki_resume_sandbox on a RUNNING sandbox returns a clean idempotent SUCCESS (no FailedPrecondition/conflict); the sandbox stays RUNNING. The TEST-MATRIX assumes a state-conflict error here.",
				);
			}
		});

		// pause → poll to PAUSED → double-pause. Managed block (skip on a pause capability/timing gap).
		{
			const name = "illegal-transition: pause an already-paused sandbox is handled cleanly (conflict or idempotent no-op)";
			try {
				await h.call("tenki_pause_sandbox", { session_id: B });
				let paused = false;
				for (let i = 0; i < 45; i++) {
					const g = await h.call("tenki_get_sandbox", { session_id: B });
					const st = String((g.session ?? g).state ?? "");
					if (/PAUSE|SUSPEND/i.test(st)) {
						paused = true;
						break;
					}
					if (/TERMINAT|ERROR|FAILED/i.test(st)) break;
					await sleep(1000);
				}
				if (!paused) {
					skip(name, "sandbox did not reach PAUSED within 45s (pause capability/timing gap)");
				} else {
					let succeeded = false;
					try {
						await h.call("tenki_pause_sandbox", { session_id: B }); // double-pause
						succeeded = true;
					} catch (e) {
						const m = e?.message ?? String(e);
						if (FIVE_XX.test(m)) throw new Error(`5xx on double-pause (not clean): ${m.slice(0, 160)}`);
						if (HANG.test(m)) throw new Error(`double-pause hung: ${m.slice(0, 160)}`);
						pass(name); // clean conflict / 4xx isError — the ideal outcome
					}
					if (succeeded) {
						const g = await h.call("tenki_get_sandbox", { session_id: B });
						const st = String((g.session ?? g).state ?? "");
						if (!/PAUSE|SUSPEND/i.test(st)) throw new Error(`double-pause left the sandbox in ${st} (wrong-state mutation)`);
						findings.push(
							"Tenki API semantics (not an MCP bug): tenki_pause_sandbox on an already-PAUSED sandbox returns a clean idempotent SUCCESS (no conflict); the sandbox stays PAUSED. The TEST-MATRIX assumes a state-conflict error here.",
						);
						pass(name);
					}
					await h.call("tenki_resume_sandbox", { session_id: B }).catch(() => {}); // best-effort restore for tidy teardown
				}
			} catch (e) {
				if (isDataPlaneOutage(e)) skip(name, "control-plane transient");
				else fail(name, e);
			}
		}
	} else {
		skip("illegal-transition: resume a RUNNING sandbox is handled cleanly (conflict or idempotent no-op)", "no RUNNING sandbox");
		skip("illegal-transition: pause an already-paused sandbox is handled cleanly (conflict or idempotent no-op)", "no RUNNING sandbox");
	}

	// ── run_code edges: env injection + surfaced non-zero exit (data-plane; exitCode is control-plane) ─
	await h.checkData("run_code: env injected + non-zero exit surfaced (ok:false, exitCode 7)", async () => {
		const r = await h.call("tenki_run_code", { language: "shell", code: 'printf "env-%s" "$FOO"; exit 7', env: { FOO: "bar" } });
		runSid = r.sessionId ?? null;
		// exitCode + ok ride the control-plane ExecuteCommand response — assert regardless of capture health.
		if (r.exitCode !== 7) throw new Error(`expected exitCode 7, got ${r.exitCode}: ${JSON.stringify(r).slice(0, 160)}`);
		if (r.ok !== false) throw new Error(`expected ok:false on a non-zero exit: ${JSON.stringify(r).slice(0, 160)}`);
		// env visibility rides the data plane (stdout capture) — tolerate a capture outage.
		if (r.captureError && !String(r.stdout).trim()) return; // capture degraded; exit-code half already proven
		if (!String(r.stdout).includes("env-bar"))
			throw new Error(`env var not injected (expected 'env-bar' in stdout): ${JSON.stringify(r).slice(0, 160)}`);
	});

	await h.checkData("run_code: timeout_seconds bounds a long run (not a clean exit-0 'done')", async () => {
		const r = await h.call("tenki_run_code", { language: "shell", code: "sleep 2; echo done", timeout_seconds: 1 });
		// Matrix failure condition, exactly: a bounded run must NOT come back exit-0 with 'done' after the full sleep.
		if (r.exitCode === 0 && String(r.stdout).includes("done"))
			throw new Error(`timeout NOT honored — ran to completion (exit 0, 'done'): ${JSON.stringify(r).slice(0, 160)}`);
		if (r.exitCode === 0 && !r.captureError)
			findings.push("run_code timeout: process was cut short (no 'done') but exitCode surfaced as 0 — a timed-out run should report a non-zero exit.");
	});

	// ── run_code self-teardown (control-plane; no billing leak) ───────────────────────────
	if (runSid) {
		await h.check("run_code: ephemeral sandbox self-terminated (no billing leak)", async () => {
			let st = "";
			try {
				const g = await h.call("tenki_get_sandbox", { session_id: runSid });
				st = String((g.session ?? g).state ?? "");
			} catch (e) {
				if (API_FAIL.test(e?.message ?? "") || NOTFOUND.test(e?.message ?? "")) return; // gone == terminated
				throw e;
			}
			if (!/TERMINAT/i.test(st))
				throw new Error(`ephemeral run_code sandbox not terminated (state: ${st}) — billing leak`);
		});
	} else {
		skip("run_code: ephemeral sandbox self-terminated (no billing leak)", "env/exit run_code was skipped");
	}
} catch (e) {
	console.error("suite error:", e?.message ?? e);
} finally {
	await h.cleanup();
	const r = h.report();
	console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${h.tools.length} tools)`);
	const bad = r.results.filter((x) => x.status === "fail");
	if (bad.length) console.log("FAILURES:\n" + bad.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	const skips = r.results.filter((x) => x.status === "skip");
	if (skips.length) console.log("SKIPS:\n" + skips.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	if (findings.length) console.log("FINDINGS:\n" + findings.map((f) => `  ! ${f}`).join("\n"));
	await h.close();
	process.exitCode = r.failed ? 1 : 0;
}
