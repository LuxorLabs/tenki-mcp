/**
 * OFFLINE network-behavior suite for TenkiClient — drives dist/client.js against
 * a local node:http stub. Zero external network, no token needed. Covers:
 *   - retry policy: rate limits retried for every method; `unavailable` retried
 *     ONLY for idempotent methods (a half-applied CreateSession must not re-run)
 *   - fetch timeouts: a hung connection fails with a clear error, promptly
 *   - session-credential cache: auth failure invalidates + retries once; a
 *     credential without a parseable expiry gets a finite TTL, not forever
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
	const c = new TenkiClient("tk_test", url, { credTtlMs: 100 });
	await c.data("sess", "Stat", { path: "/" });
	await c.data("sess", "Stat", { path: "/" }); // within TTL: cached
	const cachedWithinTtl = creds === 1;
	await new Promise((r) => setTimeout(r, 150));
	await c.data("sess", "Stat", { path: "/" }); // past TTL: re-minted
	check("missing expiresAt → cached within TTL, re-minted after it", cachedWithinTtl && creds === 2, `creds=${creds}`);
	stop(srv);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
