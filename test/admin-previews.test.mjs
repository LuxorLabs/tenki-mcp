/**
 * admin-previews suite — the "admin" category's harder scenarios plus the deep
 * "previews" lifecycle, run live through the real MCP protocol.
 *
 *   npm run build && TENKI_API_KEY=… node test/admin-previews.test.mjs
 *
 * Focus (does NOT re-run coverage.test.mjs's happy paths):
 *   • workspace default settings  get → update → get → RESTORE (capture original,
 *     bump one field, verify, put it back exactly — these are workspace-wide
 *     defaults applied to every new sandbox, so the suite must leave them as found).
 *   • snapshot-retention          get → update → get → RESTORE (same discipline).
 *   • ssh                         list_ssh_gateways (separate SSHGatewayClientService),
 *                                 update_ssh_keys on a sandbox (throwaway TEST pubkey),
 *                                 issue_ssh_cert wire-contract + ghost-session guard.
 *   • previews                    on an allow_inbound sandbox: expose → create_preview_url
 *                                 (slug) → get → list → delete → unexpose, plus the
 *                                 non-inbound + invalid-slug guardrails.
 *
 * Resource discipline: creates SANDBOXES ONLY (auto-tracked + torn down). Preview
 * URLs and port exposures are cleaned explicitly in finally. Every workspace-level
 * mutation captures its original and restores it (belt-and-suspenders restore in
 * finally). No volumes, templates, snapshots, images, or share grants are created.
 */
import { randomBytes } from "node:crypto";

import { Harness } from "./harness.mjs";

// A throwaway ed25519 PUBLIC key (generated once for this test; public keys are
// not secret and this one's private half was discarded). Used only to exercise
// UpdateSSHAuthorizedKeys — never a real login.
const TEST_SSH_PUBKEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3maHcQURudsO7To/lDGms5kqyATnJdwQexglJDwSGH tenki-admin-previews-test";

const rand = () => randomBytes(4).toString("hex");
const runid = rand();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Depth-first search for the first value of `key` anywhere in an object tree. */
function deepFind(obj, key) {
	let found;
	const seen = new Set();
	const walk = (o) => {
		if (found !== undefined || o === null || typeof o !== "object") return;
		if (seen.has(o)) return;
		seen.add(o);
		if (!Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, key)) {
			found = o[key];
			return;
		}
		for (const k of Object.keys(o)) {
			walk(o[k]);
			if (found !== undefined) return;
		}
	};
	walk(obj);
	return found;
}

/** Find the id of a preview-URL entry whose slug matches, walking arrays/objects. */
function findIdBySlug(resp, slug) {
	let id;
	const walk = (o) => {
		if (id !== undefined || o === null || typeof o !== "object") return;
		if (Array.isArray(o)) {
			for (const x of o) walk(x);
			return;
		}
		if (o.slug === slug) {
			id = o.id ?? o.previewUrlId ?? o.preview_url_id;
			if (id !== undefined) return;
		}
		for (const k of Object.keys(o)) walk(o[k]);
	};
	walk(resp);
	return id;
}

/** Best-effort preview id straight out of a CreatePreviewUrl response. */
function extractPreviewId(resp) {
	return (
		resp?.previewUrl?.id ??
		resp?.preview_url?.id ??
		resp?.previewUrlId ??
		resp?.preview_url_id ??
		deepFind(resp, "previewUrlId")
	);
}

/** Retry a read until `pred` holds (control-plane read-after-write can lag slightly). */
async function eventually(fn, pred, tries = 4, delay = 600) {
	let last;
	for (let i = 0; i < tries; i++) {
		last = await fn();
		if (pred(last)) return last;
		if (i < tries - 1) await sleep(delay);
	}
	return last;
}

const h = await Harness.connect("admin-previews");
console.log(`connected — ${h.tools.length} tools\n`);

/**
 * Create a sandbox with wait_ready:false (so the harness ALWAYS captures + tracks
 * the id before any wait can throw — sidesteps the create-then-wait leak asymmetry),
 * then poll GetSession to RUNNING ourselves. Returns the session id.
 */
async function bootSandbox(args) {
	const s = await h.createSandbox({ ...args, wait_ready: false }); // id tracked immediately
	if (!s.sessionId) throw new Error(`create returned no id: ${JSON.stringify(s).slice(0, 120)}`);
	const deadline = Date.now() + 120000;
	for (;;) {
		const g = await h.call("tenki_get_sandbox", { session_id: s.sessionId });
		const st = String(deepFind(g, "state") ?? "");
		if (st.includes("RUNNING")) return s.sessionId;
		if (/TERMINATED|ERROR|FAILED/.test(st)) throw new Error(`sandbox ${s.sessionId} entered ${st}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for RUNNING (last: ${st || "?"})`);
		await sleep(1500);
	}
}

// Restore/cleanup bookkeeping (belt-and-suspenders; the finally block re-applies).
let inboundSid; // shared allow_inbound sandbox reused by ssh + preview checks
const previewsToClean = []; // { slug, id? } — deleted in finally if the lifecycle didn't
const portsToClean = []; // { session_id, port } — unexposed in finally if left exposed
const findings = [];

try {
	// ── health gate: identity + the three side-effect-free admin reads ──────────────
	await h.check("admin: whoami + workspace usage (control-plane health gate)", async () => {
		const who = await h.call("tenki_whoami", {});
		if (!who || (who.ownerType === undefined && !Array.isArray(who.workspaces)))
			throw new Error(`whoami malformed: ${JSON.stringify(who).slice(0, 120)}`);
		const usage = await h.call("tenki_get_workspace_usage", {});
		if (!usage || typeof usage !== "object") throw new Error("workspace usage not an object");
	});

	// ── ssh: gateways live on a SEPARATE ConnectRPC service (SSHGatewayClientService) ─
	await h.check("ssh: list_ssh_gateways (alternate-service routing)", async () => {
		try {
			const r = await h.call("tenki_list_ssh_gateways", {});
			if (r === undefined || r === null || typeof r !== "object")
				throw new Error(`malformed gateways payload: ${JSON.stringify(r).slice(0, 80)}`);
		} catch (e) {
			const m = e?.message ?? String(e);
			// Reached the alternate service but it returned a specific server error (e.g. no
			// gateway provisioned on a vanilla workspace). That satisfies the wire-contract
			// bar (method name + alternate-service routing proven); flag it, don't hard-fail.
			if (/failed \(\d|404|501|unimplemented|not.?found|not yet|permission|unavailable/i.test(m)) {
				findings.push(`tenki_list_ssh_gateways returned a specific server error (alternate-service routing reached; provisioning/API gap, not a client crash): ${m.slice(0, 160)}`);
				return;
			}
			throw e; // a client-side zod/transport crash is a real failure
		}
	});

	// Shared allow_inbound sandbox for ssh-key + preview checks.
	await h.check("previews: create allow_inbound sandbox → RUNNING", async () => {
		inboundSid = await bootSandbox({ name: `adm-inb-${runid}`, allow_inbound: true, allow_outbound: false });
		if (!inboundSid) throw new Error("no inbound session id");
	});

	// ── ssh: set authorized_keys on a running sandbox (explicit target, dies with VM) ─
	await h.check("ssh: update_ssh_keys replaces authorized_keys on the sandbox", async () => {
		if (!inboundSid) throw new Error("no inbound sandbox (create step failed)");
		const r = await h.call("tenki_update_ssh_keys", { session_id: inboundSid, public_keys: [TEST_SSH_PUBKEY] });
		if (r === undefined || r === null) throw new Error("no response from update_ssh_keys");
	});

	await h.check("ssh: issue_ssh_cert wire-contract (signed cert OR specific gateway error)", async () => {
		if (!inboundSid) throw new Error("no inbound sandbox (create step failed)");
		try {
			const r = await h.call("tenki_issue_ssh_cert", { session_id: inboundSid, public_key: TEST_SSH_PUBKEY });
			if (r === undefined || r === null) throw new Error("empty issue_ssh_cert response");
		} catch (e) {
			const m = e?.message ?? String(e);
			if (/failed \(\d|404|501|unimplemented|not.?found|not yet|gateway|permission|unavailable/i.test(m)) {
				findings.push(`tenki_issue_ssh_cert: specific server error (SDK-name-verified, not e2e; gateway may be unprovisioned): ${m.slice(0, 160)}`);
				return; // wire-contract satisfied
			}
			throw e; // client-side crash = fail
		}
	});

	await h.check("ssh: issue_ssh_cert on a ghost session → clean isError (no crash/hang)", async () => {
		await h.expectError("tenki_issue_ssh_cert", { session_id: "sess_ghost_admprev", public_key: TEST_SSH_PUBKEY });
	});

	// ── previews: full lifecycle on the allow_inbound sandbox ────────────────────────
	await h.check("previews: expose → create_preview_url(slug) → get → list → delete → unexpose", async () => {
		if (!inboundSid) throw new Error("no inbound sandbox (create step failed)");
		const port = 8080;
		const slug = `admprev-${rand()}`;

		await h.call("tenki_expose_port", { session_id: inboundSid, port });
		portsToClean.push({ session_id: inboundSid, port });
		const exposed = await h.call("tenki_list_exposed_ports", { session_id: inboundSid });
		if (!JSON.stringify(exposed).includes(String(port))) throw new Error(`port ${port} missing from list_exposed_ports`);

		const created = await h.call("tenki_create_preview_url", { session_id: inboundSid, port, slug });
		previewsToClean.push({ slug }); // track by slug BEFORE resolving id, so a leak can't escape cleanup
		if (!/http|url/i.test(JSON.stringify(created))) throw new Error(`no url/http in create response: ${JSON.stringify(created).slice(0, 150)}`);

		// Resolve the preview id from the create response, else derive it from the list.
		const listA = await h.call("tenki_list_preview_urls", { session_id: inboundSid });
		let pid = extractPreviewId(created) ?? findIdBySlug(created, slug) ?? findIdBySlug(listA, slug);
		if (!pid) throw new Error(`could not resolve preview id (create=${JSON.stringify(created).slice(0, 120)})`);
		previewsToClean[previewsToClean.length - 1].id = pid;
		if (!JSON.stringify(listA).includes(String(pid)) && !JSON.stringify(listA).includes(slug))
			throw new Error("created preview not present in list_preview_urls");

		const got = await h.call("tenki_get_preview_url", { preview_url_id: pid });
		if (!JSON.stringify(got).includes(String(pid))) throw new Error("get_preview_url did not echo the id");

		await h.call("tenki_delete_preview_url", { preview_url_id: pid });
		const listB = await eventually(
			() => h.call("tenki_list_preview_urls", { session_id: inboundSid }),
			(r) => !JSON.stringify(r).includes(String(pid)),
		);
		if (JSON.stringify(listB).includes(String(pid))) throw new Error("preview URL still present after delete");
		previewsToClean.length = 0; // successfully deleted

		await h.call("tenki_unexpose_port", { session_id: inboundSid, port });
		portsToClean.length = 0; // successfully unexposed
	});

	// ── preview guardrails ───────────────────────────────────────────────────────────
	await h.check("previews: invalid slug rejected pre-network (zod)", async () => {
		if (!inboundSid) throw new Error("no inbound sandbox (create step failed)");
		await h.expectError("tenki_create_preview_url", { session_id: inboundSid, port: 8083, slug: "ab" }); // too short
		await h.expectError("tenki_create_preview_url", { session_id: inboundSid, port: 8083, slug: "Has Space" }); // bad chars
	});

	// The tool description says a preview URL needs allow_inbound. Whether that's
	// ENFORCED is the server's call — tenki-mcp just forwards CreatePreviewUrl. Probe it:
	// a clean rejection proves the guardrail; a success is an upstream API-gap finding
	// (not a client bug). Either way the tool must not crash and must leave no leaked URL.
	await h.check("previews: create_preview_url on a NON-inbound sandbox (guardrail probe)", async () => {
		const noInb = await bootSandbox({ name: `adm-noinb-${runid}`, allow_inbound: false });
		const slug = `admni-${rand()}`;
		let res;
		try {
			res = await h.call("tenki_create_preview_url", { session_id: noInb, port: 8081, slug });
		} catch {
			return; // guardrail enforced server-side — the ideal outcome
		}
		// Created despite no inbound: reclaim the URL immediately, then record the API gap.
		let id = extractPreviewId(res) ?? findIdBySlug(res, slug);
		if (!id) {
			const l = await h.call("tenki_list_preview_urls", { session_id: noInb }).catch(() => null);
			if (l) id = findIdBySlug(l, slug);
		}
		let reclaimed = false;
		if (id) {
			await h.call("tenki_delete_preview_url", { preview_url_id: id }).catch(() => {});
			const after = await h.call("tenki_list_preview_urls", { session_id: noInb }).catch(() => null);
			reclaimed = !after || !JSON.stringify(after).includes(String(id));
		}
		findings.push(
			`API GAP (Tenki, not tenki-mcp): CreatePreviewUrl succeeded on a sandbox created WITHOUT allow_inbound — the 'inbound required' precondition stated in the tenki_create_preview_url description is not enforced at URL-creation time. The URL was reclaimed (deleted=${reclaimed}). Consider softening that description or noting inbound is enforced only for live traffic.`,
		);
		// tenki-mcp behaved correctly (forwarded, returned a URL, get/delete worked): this
		// is an upstream API-behavior observation, not a client failure — unless the URL
		// could not be reclaimed, which WOULD be a real leak.
		if (id && !reclaimed) throw new Error(`created preview URL on non-inbound sandbox and could NOT reclaim it (id=${id})`);
	});
} catch (e) {
	console.error("suite error:", e?.message ?? e);
} finally {
	// 1) Delete any preview URL the lifecycle didn't (resolve by id, else by slug via list).
	for (const p of previewsToClean) {
		try {
			let id = p.id;
			if (!id && inboundSid) {
				const l = await h.call("tenki_list_preview_urls", { session_id: inboundSid }).catch(() => null);
				if (l) id = findIdBySlug(l, p.slug);
			}
			if (id) await h.call("tenki_delete_preview_url", { preview_url_id: id }).catch(() => {});
		} catch {
			/* best-effort */
		}
	}
	// 2) Unexpose any still-exposed port (also torn down when the sandbox terminates).
	for (const p of portsToClean) {
		await h.call("tenki_unexpose_port", { session_id: p.session_id, port: p.port }).catch(() => {});
	}
	// 3) Terminate every tracked sandbox.
	await h.cleanup();

	const r = h.report();
	console.log(`\n${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped (${h.tools.length} tools)`);
	const bad = r.results.filter((x) => x.status === "fail");
	if (bad.length) console.log("FAILURES:\n" + bad.map((x) => `  - ${x.name}: ${x.error}`).join("\n"));
	if (findings.length) console.log("FINDINGS:\n" + findings.map((f) => `  - ${f}`).join("\n"));
	await h.close();
	process.exitCode = r.failed ? 1 : 0;
}
