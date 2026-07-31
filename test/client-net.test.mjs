/**
 * OFFLINE network-behavior suite for TenkiClient — drives dist/client.js against
 * a local node:http stub. Zero external network, no token needed. Covers:
 *   - retry policy: rate limits retried for every method; transient failures
 *     (`unavailable`, gateway 502/503/504, transport errors) retried for every
 *     method that cannot double-apply — teardown included — but NEVER for
 *     Create or Execute methods (a half-applied CreateSession must not re-run)
 *   - data-plane retries for read-shaped methods (ReadFile/Stat/List)
 *   - one shared deadline per call: attempts + backoffs can't stack past it
 *   - fetch timeouts: a hung connection OR a stalled response body fails with
 *     a clear error naming the method, promptly
 *   - session-credential cache: 401 invalidates + re-mints once (permission
 *     denied does NOT); missing expiry → finite TTL; an already-expired
 *     credential is not cached; concurrent cold-cache calls share one mint
 *
 *   npm run build && node test/client-net.test.mjs
 */
import { createServer } from "node:http";
import { TenkiClient } from "../dist/client.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
	if (cond) { console.log(`  ✓ ${name}`); pass++; }
	else { console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

const startStub = (handler) =>
	new Promise((resolve) => {
		const srv = createServer(handler);
		srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
	});
const json = (res, status, body, headers = {}) => {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
};
const stop = (srv) => { srv.closeAllConnections?.(); srv.close(); };

// 1) 429 is retried for EVERY method, honoring Retry-After
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		if (calls === 1) return json(res, 429, { code: "rate_limited", message: "slow down" }, { "retry-after": "0" });
		json(res, 200, { ok: true });
	});
	const c = new TenkiClient("tk_test", url);
	const out = await c.control("CreateSession", {});
	check("429 (+Retry-After) is retried even on CreateSession", calls === 2 && out.ok === true, `calls=${calls}`);
	stop(srv);
}

// 2) `unavailable` on CreateSession is NOT retried — no double-boot/double-spend
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		json(res, 503, { code: "unavailable", message: "downstream" });
	});
	const c = new TenkiClient("tk_test", url);
	let msg = "";
	try { await c.control("CreateSession", {}); } catch (e) { msg = e.message; }
	check("unavailable on CreateSession is NOT retried", calls === 1 && /unavailable/.test(msg), `calls=${calls} msg=${msg}`);
	stop(srv);
}

// 3) `unavailable` on an idempotent method IS retried
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		if (calls < 3) return json(res, 503, { code: "unavailable" });
		json(res, 200, { session: { id: "s" } });
	});
	const c = new TenkiClient("tk_test", url);
	const out = await c.control("GetSession", { sessionId: "s" });
	check("unavailable on GetSession IS retried to success", calls === 3 && !!out.session, `calls=${calls}`);
	stop(srv);
}

// 4) a hung control-plane connection times out with a clear error, promptly
{
	const { srv, url } = await startStub(() => { /* hold the socket open forever */ });
	const c = new TenkiClient("tk_test", url, { timeoutMs: 300 });
	let msg = "";
	const t0 = Date.now();
	try { await c.control("WhoAmI", {}); } catch (e) { msg = e.message; }
	const elapsed = Date.now() - t0;
	check("hung control call → clear timeout error", /WhoAmI timed out after 300ms/.test(msg), msg);
	check("timeout fires promptly (not the OS socket timeout)", elapsed < 5000, `${elapsed}ms`);
	stop(srv);
}

// 5) data-plane auth failure invalidates the cached credential and retries ONCE
{
	let creds = 0, reads = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, { credential: { credential: `cert${creds}` }, dataPlaneEndpoint: url });
		}
		if (req.url.includes("ReadFile")) {
			reads++;
			if (req.headers["x-tenki-session-cert"] === "cert1") return json(res, 401, { code: "unauthenticated" });
			return json(res, 200, { response: { content: Buffer.from("hi", "utf8").toString("base64") } });
		}
		json(res, 404, {});
	});
	const c = new TenkiClient("tk_test", url);
	const text = await c.readTextFile("sess", "/f");
	check("401 on data plane → credential re-minted once, call succeeds", text === "hi" && creds === 2 && reads === 2, `creds=${creds} reads=${reads} text=${JSON.stringify(text)}`);
	stop(srv);
}

// 6) a persistent auth failure does NOT loop — exactly one re-mint, then the error surfaces
{
	let creds = 0, reads = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, { credential: { credential: "always-bad" }, dataPlaneEndpoint: url });
		}
		reads++;
		json(res, 401, { code: "unauthenticated", message: "nope" });
	});
	const c = new TenkiClient("tk_test", url);
	let threw = false;
	try { await c.data("sess", "ReadFile", { path: "/f" }); } catch { threw = true; }
	check("persistent 401 → one re-mint then error (no retry loop)", threw && creds === 2 && reads === 2, `creds=${creds} reads=${reads}`);
	stop(srv);
}

// 7) a credential without a parseable expiry gets a finite TTL — re-minted after credTtlMs
{
	let creds = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, { credential: { credential: "c" }, dataPlaneEndpoint: url }); // no expiresAt
		}
		json(res, 200, { response: {} });
	});
	const c = new TenkiClient("tk_test", url, { credTtlMs: 200 });
	await c.data("sess", "Stat", { path: "/" });
	await c.data("sess", "Stat", { path: "/" }); // within TTL: cached
	const cachedWithinTtl = creds === 1;
	await new Promise((r) => setTimeout(r, 300));
	await c.data("sess", "Stat", { path: "/" }); // past TTL: re-minted
	check("missing expiresAt → cached within TTL, re-minted after it", cachedWithinTtl && creds === 2, `creds=${creds}`);
	stop(srv);
}

// 8) a transport failure (connection reset) on an idempotent method IS retried.
// (A reset fails fast, leaving budget for the retry — a fully HUNG call instead
// consumes the whole shared deadline; that behavior is pinned in test 12.)
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		if (calls === 1) return res.destroy(); // kill the first request at the socket
		json(res, 200, { session: { id: "s" } });
	});
	const c = new TenkiClient("tk_test", url, { timeoutMs: 5000 });
	const out = await c.control("GetSession", { sessionId: "s" });
	check("connection reset on GetSession is retried to success", calls === 2 && !!out.session, `calls=${calls}`);
	stop(srv);
}

// 9) a transport failure on CreateSession is NOT retried — the request may have applied
{
	let calls = 0;
	const { srv, url } = await startStub(() => { calls++; /* never respond */ });
	const c = new TenkiClient("tk_test", url, { timeoutMs: 300 });
	let msg = "";
	try { await c.control("CreateSession", {}); } catch (e) { msg = e.message; }
	check("timeout on CreateSession is NOT retried", calls === 1 && /timed out/.test(msg), `calls=${calls} msg=${msg}`);
	stop(srv);
}

// 10) a credential with less remaining life than the skew is still cached (floored TTL)
{
	let creds = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			// expires in 10s — less than the 30s skew; naive skew would past-date it
			return json(res, 200, {
				credential: { credential: "c", expiresAt: new Date(Date.now() + 10_000).toISOString() },
				dataPlaneEndpoint: url,
			});
		}
		json(res, 200, { response: {} });
	});
	const c = new TenkiClient("tk_test", url);
	await c.data("s", "Stat", { path: "/" });
	await c.data("s", "Stat", { path: "/" });
	check("short-lived credential (< skew) is still cached, not re-minted per call", creds === 1, `creds=${creds}`);
	stop(srv);
}

// 11) teardown IS retried on `unavailable` — a skipped retry here silently
// leaks a billing sandbox (runCode's finally swallows terminate errors)
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		if (calls === 1) return json(res, 503, { code: "unavailable" });
		json(res, 200, {});
	});
	const c = new TenkiClient("tk_test", url);
	await c.control("TerminateSession", { sessionId: "s" });
	check("unavailable on TerminateSession IS retried (teardown is safe to repeat)", calls === 2, `calls=${calls}`);
	stop(srv);
}

// 12) a 503 with an HTML body (load balancer, no ConnectRPC code) is retried
{
	let calls = 0;
	const { srv, url } = await startStub((req, res) => {
		calls++;
		if (calls === 1) {
			res.writeHead(503, { "content-type": "text/html" });
			return res.end("<html><body>503 Service Temporarily Unavailable</body></html>");
		}
		json(res, 200, { session: { id: "s" } });
	});
	const c = new TenkiClient("tk_test", url);
	const out = await c.control("GetSession", { sessionId: "s" });
	check("bodyless/HTML 503 on GetSession is retried", calls === 2 && !!out.session, `calls=${calls}`);
	stop(srv);
}

// 13) the whole call draws from ONE deadline: a hung idempotent call fails
// within the call's budget instead of per-attempt-timeout × retries
{
	let calls = 0;
	const { srv, url } = await startStub(() => { calls++; /* hang forever */ });
	const c = new TenkiClient("tk_test", url, { timeoutMs: 300 });
	let msg = "";
	const t0 = Date.now();
	try { await c.control("GetSession", { sessionId: "s" }); } catch (e) { msg = e.message; }
	const elapsed = Date.now() - t0;
	check("hung GetSession fails within the shared deadline (attempts don't stack)", elapsed < 1500 && /timed out/.test(msg), `elapsed=${elapsed}ms calls=${calls} msg=${msg}`);
	stop(srv);
}

// 14) a stalled response BODY gets the same friendly, method-naming error as a
// stalled connection (body reads run inside the guarded section)
{
	const { srv, url } = await startStub((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write('{"session":'); // headers + partial body, then stall forever
	});
	const c = new TenkiClient("tk_test", url, { timeoutMs: 300 });
	let msg = "";
	try { await c.control("GetSession", { sessionId: "s" }); } catch (e) { msg = e.message; }
	check("stalled response body → friendly timeout naming the method", /GetSession timed out after/.test(msg), msg);
	stop(srv);
}

// 15) data plane: 429 on ReadFile is retried
{
	let creds = 0, reads = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, { credential: { credential: "c" }, dataPlaneEndpoint: url });
		}
		reads++;
		if (reads === 1) return json(res, 429, { code: "rate_limited", message: "slow down" }, { "retry-after": "0" });
		json(res, 200, { response: { content: Buffer.from("hi", "utf8").toString("base64") } });
	});
	const c = new TenkiClient("tk_test", url);
	const text = await c.readTextFile("sess", "/f");
	check("429 on data-plane ReadFile is retried", text === "hi" && reads === 2, `reads=${reads}`);
	stop(srv);
}

// 16) data plane: a transport failure on a read-shaped method is retried
{
	let reads = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			return json(res, 200, { credential: { credential: "c" }, dataPlaneEndpoint: url });
		}
		reads++;
		if (reads === 1) return res.destroy();
		json(res, 200, { response: { content: Buffer.from("hi", "utf8").toString("base64") } });
	});
	const c = new TenkiClient("tk_test", url, { timeoutMs: 5000 });
	const text = await c.readTextFile("sess", "/f");
	check("connection reset on data-plane ReadFile is retried", text === "hi" && reads === 2, `reads=${reads}`);
	stop(srv);
}

// 17) permission_denied does NOT re-mint the credential — a denied path is a
// user error a fresh cert can never fix
{
	let creds = 0, ops = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, { credential: { credential: "c" }, dataPlaneEndpoint: url });
		}
		ops++;
		json(res, 403, { code: "permission_denied", message: "path outside sandbox root" });
	});
	const c = new TenkiClient("tk_test", url);
	let msg = "";
	try { await c.data("sess", "Remove", { path: "/etc" }); } catch (e) { msg = e.message; }
	check("permission_denied → error surfaces, NO credential re-mint", creds === 1 && ops === 1 && /permission|403/.test(msg), `creds=${creds} ops=${ops}`);
	stop(srv);
}

// 18) an ALREADY-expired credential is not cached — the next call re-mints
// instead of serving a known-dead cert for the floor's duration
{
	let creds = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return json(res, 200, {
				credential: { credential: "c", expiresAt: new Date(Date.now() - 60_000).toISOString() },
				dataPlaneEndpoint: url,
			});
		}
		json(res, 200, { response: {} });
	});
	const c = new TenkiClient("tk_test", url);
	await c.data("s", "Stat", { path: "/" });
	await c.data("s", "Stat", { path: "/" });
	check("past-dated credential is not cached (re-minted per call)", creds === 2, `creds=${creds}`);
	stop(srv);
}

// 19) credential minting is single-flight: concurrent cold-cache calls share one mint
{
	let creds = 0;
	const { srv, url } = await startStub((req, res) => {
		if (req.url.includes("CreateSessionCredential")) {
			creds++;
			return setTimeout(() => json(res, 200, { credential: { credential: "c" }, dataPlaneEndpoint: url }), 50);
		}
		json(res, 200, { response: {} });
	});
	const c = new TenkiClient("tk_test", url);
	await Promise.all([c.data("s", "Stat", { path: "/" }), c.data("s", "Stat", { path: "/" }), c.data("s", "Stat", { path: "/" })]);
	check("3 concurrent cold-cache data calls → exactly 1 credential mint", creds === 1, `creds=${creds}`);
	stop(srv);
}

// 20) ExecuteCommand timeout math: the command's own timeout + 30s margin,
// falling back to execTimeoutMs when absent or zero
{
	const c = new TenkiClient("tk_test", "http://127.0.0.1:9");
	check("timeoutFor: ExecuteCommand timeout '30s' → 60s budget", c.timeoutFor("ExecuteCommand", { timeout: "30s" }) === 60_000, `${c.timeoutFor("ExecuteCommand", { timeout: "30s" })}`);
	check("timeoutFor: ExecuteCommand timeout '0s' → exec default", c.timeoutFor("ExecuteCommand", { timeout: "0s" }) === 630_000);
	check("timeoutFor: ExecuteCommand with no timeout → exec default", c.timeoutFor("ExecuteCommand", {}) === 630_000);
	check("timeoutFor: unary method → unary default", c.timeoutFor("GetSession", {}) === 30_000);
	// Slow storage/VM operations must NOT get the 30s unary budget: the RPC does not
	// return until the operation finishes, and a client-side timeout leaves the
	// resource created but its id unknown to the caller (measured e2e on both).
	for (const m of ["CreateSnapshot", "PauseSession"]) {
		check(`timeoutFor: ${m} → slow budget (600s), not 30s`, c.timeoutFor(m, {}) === 600_000, `${c.timeoutFor(m, {})}`);
	}
	check("timeoutFor: GetSnapshot (a read) stays on the unary default", c.timeoutFor("GetSnapshot", {}) === 30_000);
	// Async methods return a handle in <1s; a long budget would only delay a hung call.
	for (const m of ["BuildTemplate", "PublishRegistryImage", "ResumeSession", "ResizeVolume"]) {
		check(`timeoutFor: ${m} (async/fast) stays on the unary default`, c.timeoutFor(m, {}) === 30_000, `${c.timeoutFor(m, {})}`);
	}
	{
		const tuned = new TenkiClient("tk_test", "http://127.0.0.1:1", { timeoutMs: 1234, slowTimeoutMs: 5678 });
		check("timeoutFor: slowTimeoutMs option is honored", tuned.timeoutFor("CreateSnapshot", {}) === 5678);
		check("timeoutFor: timeoutMs option is honored", tuned.timeoutFor("GetSession", {}) === 1234);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
