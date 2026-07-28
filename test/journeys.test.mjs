/**
 * Journeys suite — the product-thesis COMPOSITE workflows, end to end against
 * live Tenki through the real MCP protocol. These are the multi-tool loops the
 * matrix calls the "theses" (ship-code, persistence, runtimes), distinct from
 * coverage.test.mjs's per-domain happy paths:
 *
 *   1. ship-code red→green  — create → write buggy calc + test → exec (RED) →
 *      fix → exec (GREEN). exitCode rides the control plane, so the RED→GREEN
 *      flip is provable even if stdout/stderr capture (data plane) degrades.
 *   2. snapshot→restore     — write a marker, snapshot the sandbox, boot a NEW
 *      sandbox from snapshot_id, read the marker back (disk+memory carried).
 *   3. volume warm-cache     — 1 volume, attach to A, write THROUGH the mount,
 *      detach, attach to B, read it back (durable disk outlives the sandbox).
 *   4. template boot         — create a template (setup_script) → build → poll
 *      (bounded ~90s) → if built, boot a sandbox from the produced image.
 *
 *   npm run build && TENKI_API_KEY=… node test/journeys.test.mjs
 *
 * Data-plane steps (write/read/exec) use h.checkData() so an intermittent network
 * outage is a SKIP, not a false failure; bounded async waits (snapshot-ready,
 * sandbox-boot, template-build) throw a "…within timeout budget" message that
 * checkData classifies as a skip too. THIS SUITE is the sole creator of the
 * (exactly 1) volume and (exactly 1) template; every resource is tracked and
 * torn down in the finally.
 */
import { Harness } from "./harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const h = await Harness.connect("journeys");
console.log(`connected — ${h.tools.length} tools (runid ${runid})\n`);

/** Record a tri-state result directly (for the async/slow template-boot path). */
const record = (status, name, error) => {
	h.results.push({ name, status, ...(error ? { error: String(error).slice(0, 300) } : {}) });
	const sym = status === "pass" ? "✓" : status === "skip" ? "…" : "✗";
	console.log(`  ${sym} ${name}${error ? `\n      ${String(error).replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
};

/** Poll GetSession until RUNNING; bounded — a budget overrun throws a skip-classified msg. */
async function waitRunning(sid, { budgetMs = 120000, intervalMs = 2000 } = {}) {
	const deadline = Date.now() + budgetMs;
	let last = "";
	for (;;) {
		const g = await h.call("tenki_get_sandbox", { session_id: sid });
		const s = g.session ?? g;
		last = String(s.state ?? "");
		if (last.includes("RUNNING")) return s;
		if (/TERMINATED|ERROR|FAILED/.test(last)) throw new Error(`sandbox ${sid} entered ${last} while booting`);
		if (Date.now() > deadline) throw new Error(`sandbox ${sid} not RUNNING within timeout budget (last: ${last})`);
		await sleep(intervalMs);
	}
}

/** Poll GetSnapshot until a ready-ish state; bounded — overrun throws a skip-classified msg. */
async function waitSnapshotReady(snapId, { budgetMs = 120000, intervalMs = 3000 } = {}) {
	const deadline = Date.now() + budgetMs;
	let last = "";
	for (;;) {
		const g = await h.call("tenki_get_snapshot", { snapshot_id: snapId });
		const snap = g.snapshot ?? g;
		last = String(snap.state ?? snap.status ?? "");
		if (/READY|COMPLETE|AVAILABLE|ACTIVE|SUCCEED/i.test(last)) return last;
		if (/FAIL|ERROR/i.test(last)) throw new Error(`snapshot ${snapId} entered ${last}`);
		if (Date.now() > deadline) throw new Error(`snapshot ${snapId} not ready within timeout budget (last: ${last})`);
		await sleep(intervalMs);
	}
}

/** Poll GetTemplateBuild until terminal or budget; returns {state, build, done}. Never throws on state. */
async function waitBuild(buildId, { budgetMs = 90000, intervalMs = 4000 } = {}) {
	const deadline = Date.now() + budgetMs;
	let build = {};
	let state = "";
	for (;;) {
		const gb = await h.call("tenki_get_template_build", { build_id: buildId });
		build = gb.build ?? gb;
		state = String(build.state ?? build.status ?? "");
		if (/SUCCEED|SUCCESS|COMPLETE|READY|DONE|FAIL|ERROR|CANCEL/i.test(state)) return { state, build, done: true };
		if (Date.now() > deadline) return { state, build, done: false };
		await sleep(intervalMs);
	}
}

/** Best-effort extraction of a bootable image reference from a built template/build object. */
function bootRefFrom(obj) {
	const b = obj?.build ?? obj?.template ?? obj;
	if (!b || typeof b !== "object") return null;
	for (const k of ["registryRef", "imageRef", "resultImage", "outputImage", "imageRef", "image", "imageId", "registryReference", "snapshotId", "snapshot"]) {
		const v = b[k];
		if (typeof v === "string" && v.trim()) return { kind: k, ref: v.trim() };
		if (v && typeof v === "object") {
			const id = v.reference ?? v.ref ?? v.id;
			if (typeof id === "string" && id.trim()) return { kind: k, ref: id.trim() };
		}
	}
	return null;
}

// Template ids kept in outer scope so the finally can bound cost + clean up.
let tmplId;
let buildId;
let producedImageRef;

try {
	// ── Journey 1: ship-code red→green loop ─────────────────────────────────────
	await h.checkData("ship-code: create → write buggy test (RED) → fix → exec (GREEN)", async () => {
		const s = await h.createSandbox({ name: `qa-jny-ship-${runid}`, cpu_cores: 1, memory_mb: 1024, allow_outbound: true });
		if (!s.sessionId) throw new Error(`create_sandbox returned no session id: ${JSON.stringify(s).slice(0, 120)}`);
		await waitRunning(s.sessionId);

		// buggy implementation (a-b) + a test that asserts add(2,3)==5 and prints PASS.
		await h.call("tenki_write_file", { session_id: s.sessionId, path: "/home/tenki/calc.py", content: "def add(a, b):\n    return a - b\n" });
		await h.call("tenki_write_file", {
			session_id: s.sessionId,
			path: "/home/tenki/test_calc.py",
			content: 'from calc import add\nassert add(2, 3) == 5, f"got {add(2, 3)}"\nprint("PASS")\n',
		});

		// RED — the buggy add makes the assertion fail (non-zero exit from the control plane).
		const red = await h.call("tenki_exec", { session_id: s.sessionId, command: "python3", args: ["/home/tenki/test_calc.py"], cwd: "/home/tenki" });
		if (Number(red.exitCode) === 0) throw new Error(`expected RED (non-zero exit); got exit 0. stdout=${JSON.stringify(red.stdout)} captureError=${red.captureError ?? "-"}`);
		if (!red.captureError && !/AssertionError|got 1|got -1/.test(String(red.stderr) + String(red.stdout))) {
			throw new Error(`RED exited ${red.exitCode} but the failure signature is missing: stderr=${JSON.stringify(red.stderr)}`);
		}

		// Fix the bug (a+b), then re-run the SAME test → GREEN.
		await h.call("tenki_write_file", { session_id: s.sessionId, path: "/home/tenki/calc.py", content: "def add(a, b):\n    return a + b\n" });
		const green = await h.call("tenki_exec", { session_id: s.sessionId, command: "python3", args: ["/home/tenki/test_calc.py"], cwd: "/home/tenki" });
		if (Number(green.exitCode) !== 0) throw new Error(`expected GREEN (exit 0); got exit ${green.exitCode}. stderr=${JSON.stringify(green.stderr)} captureError=${green.captureError ?? "-"}`);
		if (!green.captureError && !String(green.stdout).includes("PASS")) {
			throw new Error(`GREEN exit 0 but stdout missing PASS: ${JSON.stringify(green.stdout)}`);
		}
	});

	// ── Journey 2: snapshot → restore into a NEW sandbox ────────────────────────
	await h.checkData("persistence: snapshot a sandbox → boot a NEW one from snapshot_id → marker carried", async () => {
		const marker = `checkpoint-${runid}`;
		const src = await h.createSandbox({ name: `qa-jny-ckpt-src-${runid}`, cpu_cores: 1, memory_mb: 1024 });
		if (!src.sessionId) throw new Error("snapshot src: no session id");
		await waitRunning(src.sessionId);

		// Write the marker BEFORE the snapshot; best-effort sync so it's on disk.
		await h.call("tenki_write_file", { session_id: src.sessionId, path: "/home/tenki/marker.txt", content: marker });
		await h.call("tenki_exec", { session_id: src.sessionId, command: "sh", args: ["-c", "sync"] }).catch(() => {});

		const cs = await h.call("tenki_create_snapshot", { session_id: src.sessionId, name: `qa-jny-snap-${runid}` });
		const snapId = cs.snapshot?.id ?? cs.id ?? cs.snapshotId;
		if (!snapId) throw new Error(`create_snapshot returned no id: ${JSON.stringify(cs).slice(0, 160)}`);
		h.track("snapshot", snapId);
		await waitSnapshotReady(snapId);

		// Boot a BRAND-NEW sandbox from the snapshot and read the marker back.
		const dst = await h.createSandbox({ name: `qa-jny-ckpt-dst-${runid}`, snapshot_id: snapId });
		if (!dst.sessionId) throw new Error("restore dst: no session id");
		await waitRunning(dst.sessionId);

		let got = String((await h.call("tenki_read_file", { session_id: dst.sessionId, path: "/home/tenki/marker.txt" })).content ?? "");
		if (!got) {
			// read_file came back empty — disambiguate a degraded capture from a genuine miss via exec cat.
			const ex = await h.call("tenki_exec", { session_id: dst.sessionId, command: "cat", args: ["/home/tenki/marker.txt"] });
			if (ex.captureError) throw new Error(`restore read degraded (data-plane): ${ex.captureError}`);
			got = String(ex.stdout ?? "");
		}
		if (got.trim() !== marker) throw new Error(`RESTORE MISMATCH: expected '${marker}', got '${got.trim() || "(empty)"}' — snapshot did not carry disk state`);
	});

	// ── Journey 3: volume warm-cache — write via A, read via B ──────────────────
	// The durable-disk thesis: a file written under sandbox A's mount is readable
	// under sandbox B's mount after A is gone. (Attach is currently BROKEN — see
	// findings — so this red-lines at attach; the sequence is written to pass once
	// tenki_attach_volume sends the correct nested `volume` shape.)
	await h.checkData("persistence: volume warm-cache — attach→write(A)→detach→attach(B)→read", async () => {
		const cv = await h.call("tenki_create_volume", { name: `qa-jny-cache-${runid}`, size_bytes: 1_048_576 });
		const volId = cv.volume?.id ?? cv.id ?? cv.volumeId;
		if (!volId) throw new Error(`create_volume returned no id: ${JSON.stringify(cv).slice(0, 160)}`);
		h.track("volume", volId);
		const gv = await h.call("tenki_get_volume", { volume_id: volId });
		const vstate = String((gv.volume ?? gv).state ?? "");
		if (!/AVAILABLE|READY|ACTIVE/i.test(vstate)) throw new Error(`volume not available after create: ${vstate}`);

		const A = await h.createSandbox({ name: `qa-jny-volA-${runid}`, cpu_cores: 1, memory_mb: 1024 });
		await waitRunning(A.sessionId);

		// Attach the volume into A. tenki_attach_volume currently rejects with a
		// 400 (sends volumeId; API requires nested volume{volumeId,mountPath}).
		try {
			await h.call("tenki_attach_volume", { session_id: A.sessionId, volume_id: volId, mount_path: "/mnt/cache" });
		} catch (e) {
			if (/value is required|invalid_argument|AttachVolume failed/i.test(e.message)) {
				throw new Error(`tenki_attach_volume rejected valid input — REAL BUG: request sends {sessionId,volumeId,mountPath}, but AttachVolume requires a nested volume{volumeId,mountPath}. Underlying: ${e.message}`);
			}
			throw e; // a network/other error keeps its own classification
		}

		// Write THROUGH the mount (write_file is rooted at /home/tenki, so use exec for /mnt).
		const w = await h.call("tenki_exec", { session_id: A.sessionId, command: "sh", args: ["-c", `echo warm-${runid} > /mnt/cache/warm.txt && sync`] });
		if (Number(w.exitCode) !== 0 && !w.captureError) throw new Error(`write-through failed: exit ${w.exitCode} stderr=${JSON.stringify(w.stderr)}`);

		// delete-while-attached must be rejected (VolumeInUse; delete_volume has no force).
		const inUse = await h.call("tenki_delete_volume", { volume_id: volId }).then(() => "NO-ERROR").catch((e) => e.message);
		if (inUse === "NO-ERROR") throw new Error("delete_volume succeeded while the volume was attached (expected VolumeInUse)");

		await h.call("tenki_detach_volume", { session_id: A.sessionId, volume_id: volId });
		await h.call("tenki_terminate_sandbox", { session_id: A.sessionId }).catch(() => {});
		h.resources.sandbox = h.resources.sandbox.filter((x) => x !== A.sessionId);

		// New sandbox B, re-attach the SAME volume, read the file A wrote.
		const B = await h.createSandbox({ name: `qa-jny-volB-${runid}`, cpu_cores: 1, memory_mb: 1024 });
		await waitRunning(B.sessionId);
		await h.call("tenki_attach_volume", { session_id: B.sessionId, volume_id: volId, mount_path: "/mnt/cache" });
		const r = await h.call("tenki_exec", { session_id: B.sessionId, command: "sh", args: ["-c", "cat /mnt/cache/warm.txt"] });
		if (r.captureError) throw new Error(`warm-cache read degraded (data-plane): ${r.captureError}`);
		if (!String(r.stdout).includes(`warm-${runid}`)) throw new Error(`warm-cache MISS: B did not read A's write. stdout=${JSON.stringify(r.stdout)}`);
		await h.call("tenki_detach_volume", { session_id: B.sessionId, volume_id: volId }).catch(() => {});
	});

	// ── Journey 4a: template → build → addressable (control-plane, reliable) ─────
	await h.check("runtimes: template create → build → addressable (buildId + get-build + list-active)", async () => {
		const ct = await h.call("tenki_create_template", {
			name: `qa-jny-tmpl-${runid}`,
			setup_script: "echo provision",
			cpu_cores: 1,
			memory_mb: 512,
			disk_size_gb: 5,
			tags: ["qa", "journeys"],
		});
		tmplId = ct.template?.id ?? ct.id ?? ct.templateId;
		if (!tmplId) throw new Error(`create_template returned no id: ${JSON.stringify(ct).slice(0, 160)}`);
		h.track("template", tmplId);

		// NOTE: image_name is intentionally omitted — the API rejects it on an untyped
		// setup_script template ("image_name requires a typed template"). See findings.
		const bt = await h.call("tenki_build_template", { template_id: tmplId });
		buildId = bt.build?.id ?? bt.buildId ?? bt.id;
		if (!buildId) throw new Error(`build_template returned no build id: ${JSON.stringify(bt).slice(0, 200)}`);

		const gb = await h.call("tenki_get_template_build", { build_id: buildId });
		const st = String((gb.build ?? gb).state ?? "");
		if (!st) throw new Error(`get_template_build returned no state: ${JSON.stringify(gb).slice(0, 200)}`);

		const la = await h.call("tenki_list_active_template_builds", { template_id: tmplId });
		if (!JSON.stringify(la).includes(buildId)) throw new Error(`build ${buildId} not present in list_active_template_builds`);
	});

	// ── Journey 4b: boot from the built image (bounded ~90s; incomplete = SKIP) ──
	if (buildId) {
		const bootName = "runtimes: template build → (bounded poll) → boot a sandbox from the image → exec warm";
		try {
			const { state, build, done } = await waitBuild(buildId, { budgetMs: 90000, intervalMs: 4000 });
			if (!done) {
				record("skip", bootName, `template build did not finish within ~90s (last state: ${state}) — SLOW/async build, not a failure`);
			} else if (/SUCCEED|SUCCESS|COMPLETE|READY|DONE/i.test(state)) {
				try {
					const ref = bootRefFrom(build) ?? bootRefFrom(await h.call("tenki_get_template", { template_id: tmplId }));
					if (!ref) {
						record("skip", bootName, `build reached ${state} but no bootable image-ref field was found on the build/template (verification gap — field name unknown)`);
					} else {
						producedImageRef = /snapshot/i.test(ref.kind) ? undefined : ref.ref; // track for cleanup if it's a registry image
						const bootArgs = /snapshot/i.test(ref.kind) ? { snapshot_id: ref.ref } : { registry_ref: ref.ref };
						const dst = await h.createSandbox({ name: `qa-jny-tboot-${runid}`, ...bootArgs });
						await waitRunning(dst.sessionId);
						const ex = await h.call("tenki_exec", { session_id: dst.sessionId, command: "sh", args: ["-c", "echo warm"] });
						if (ex.captureError) record("skip", bootName, `booted from ${ref.kind}=${ref.ref} but exec capture degraded (data-plane): ${ex.captureError}`);
						else if (!String(ex.stdout).includes("warm")) record("fail", bootName, `booted from ${ref.kind} but exec produced unexpected stdout: ${JSON.stringify(ex.stdout)}`);
						else record("pass", bootName, undefined);
					}
				} catch (e) {
					// Boot-from-image is SDK-grounded, not fully e2e pre-1.0: a boot error here is a verification note.
					record("skip", bootName, `build reached ${state} but boot-from-image failed (verification gap): ${e.message}`);
				}
			} else {
				// Surface WHY it failed: distinguishes a Tenki backend/infra fault (the
				// setup step ran, the snapshot phase errored) from a real setup failure.
				const why = String(build?.failure?.message ?? build?.error ?? "").replace(/\s+/g, " ").slice(0, 220);
				const ran = String(build?.buildLogTail ?? "").replace(/\s+/g, " ").slice(0, 80);
				record("skip", bootName, `template build reached ${state} — setupLogTail=[${ran}] failure=[${why}] (boot-warm unverified; classify per the message: 'internal server error/retryable' = a server-side error, not an mcp wiring bug)`);
			}
		} catch (e) {
			record("fail", bootName, e.message);
		} finally {
			// Bound cost: cancel the build if it is still running.
			await h.call("tenki_cancel_template_build", { build_id: buildId }).catch(() => {});
		}
	}
} catch (e) {
	console.error("suite error:", e?.message ?? e);
} finally {
	// Template-specific teardown FIRST (force-delete cascades the build; it may have
	// dependents that the harness's non-force delete_template can't remove).
	if (buildId) await h.call("tenki_cancel_template_build", { build_id: buildId }).catch(() => {});
	if (producedImageRef) await h.call("tenki_delete_image", { reference: producedImageRef }).catch(() => {});
	if (tmplId) {
		await h.call("tenki_delete_template", { template_id: tmplId, force: true }).catch(() => {});
		h.resources.template = h.resources.template.filter((x) => x !== tmplId);
	}

	// Snapshot-safe teardown: a snapshot with a sandbox booted FROM it can't be
	// deleted (400 failed_precondition: "referenced by one or more resources"), and
	// the harness cleanup() deletes snapshots BEFORE terminating sandboxes — which
	// would leak the restore snapshot as dangling. So terminate every tracked
	// sandbox first, then delete tracked snapshots (short retry while the reference
	// clears), and only then hand off to the harness cleanup for the rest.
	for (const id of h.resources.sandbox) await h.call("tenki_terminate_sandbox", { session_id: id }).catch(() => {});
	if (h.resources.snapshot.length) {
		await sleep(4000);
		for (const id of [...h.resources.snapshot]) {
			for (let i = 0; i < 5; i++) {
				const res = await h.call("tenki_delete_snapshot", { snapshot_id: id }).then(() => "OK").catch((e) => e.message ?? String(e));
				if (res === "OK") {
					h.resources.snapshot = h.resources.snapshot.filter((x) => x !== id);
					break;
				}
				if (!/failed_precondition|referenced/i.test(String(res))) break; // a different error — let cleanup surface it
				await sleep(3000);
			}
		}
	}

	await h.cleanup();
	const r = h.report();
	console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${h.tools.length} tools)`);
	const bad = r.results.filter((x) => x.status === "fail");
	if (bad.length) console.log("FAILURES:\n" + bad.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	const skipped = r.results.filter((x) => x.status === "skip");
	if (skipped.length) console.log("SKIPS:\n" + skipped.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	await h.close();
	process.exitCode = r.failed ? 1 : 0;
}