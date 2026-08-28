import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { once } from "node:events";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const token = "ory_at_test";
const logoutChallenge = "logout-test";
let logoutRequestRead = false;
let logoutAccepted = false;

const introspection = http.createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	if (req.method === "GET" && url.pathname === "/admin/oauth2/auth/requests/logout") {
		logoutRequestRead = url.searchParams.get("logout_challenge") === logoutChallenge;
		res.writeHead(logoutRequestRead ? 200 : 400, { "Content-Type": "application/json" });
		res.end(JSON.stringify(logoutRequestRead ? { challenge: logoutChallenge, subject: userId } : { error: "bad challenge" }));
		return;
	}
	if (req.method === "PUT" && url.pathname === "/admin/oauth2/auth/requests/logout/accept") {
		logoutAccepted = url.searchParams.get("logout_challenge") === logoutChallenge;
		res.writeHead(logoutAccepted ? 200 : 400, { "Content-Type": "application/json" });
		res.end(JSON.stringify(logoutAccepted ? { redirect_to: "https://oauth.tenki.test/logged-out" } : { error: "bad challenge" }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/oauth2/register") {
		res.writeHead(201, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				client_id: "claude-dynamic",
				client_uri: "",
				policy_uri: "",
				contacts: null,
				registration_access_token: "registration-token",
				registration_client_uri: "https://oauth.tenki.test/oauth2/register/claude-dynamic",
			}),
		);
		return;
	}

	let body = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const valid = new URLSearchParams(body).get("token") === token;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify(
				valid
					? {
							active: true,
							sub: userId,
							client_id: "claude-test",
							scope: "mcp",
							aud: ["http://127.0.0.1/mcp"],
							ext: { workspace_id: workspaceId },
						}
					: { active: false },
			),
		);
	});
});
introspection.listen(0, "127.0.0.1");
await once(introspection, "listening");
const introspectionAddress = introspection.address();

process.env.TENKI_MCP_OAUTH_ISSUER = "https://oauth.tenki.test";
process.env.TENKI_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${introspectionAddress.port}/admin/oauth2/introspect`;
process.env.TENKI_MCP_HYDRA_ADMIN_URL = `http://127.0.0.1:${introspectionAddress.port}`;
process.env.TENKI_MCP_HYDRA_PUBLIC_URL = `http://127.0.0.1:${introspectionAddress.port}`;
process.env.TENKI_MCP_PUBLIC_URL = "http://127.0.0.1";
process.env.TENKI_MCP_OAUTH_RESOURCE = "http://127.0.0.1/mcp";

const { requestOriginAllowed } = await import("../dist/oauth.js");
const { startHttp } = await import("../dist/http.js");
const server = startHttp(null, 0);
if (!server.listening) await once(server, "listening");
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
	const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
	if (!metadata.ok) throw new Error(`metadata returned ${metadata.status}`);
	const resource = await metadata.json();
	if (resource.resource !== "http://127.0.0.1/mcp") throw new Error("protected-resource metadata has wrong resource");

	const unauthorized = await fetch(`${base}/mcp`, { method: "POST" });
	if (unauthorized.status !== 401) throw new Error(`unauthorized request returned ${unauthorized.status}`);
	if (!unauthorized.headers.get("www-authenticate")?.includes("resource_metadata=")) {
		throw new Error("401 challenge omitted resource_metadata");
	}

	const registration = await fetch(`${base}/oauth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"] }),
	});
	if (registration.status !== 201) throw new Error(`OAuth registration returned ${registration.status}`);
	const registeredClient = await registration.json();
	if (registeredClient.client_id !== "claude-dynamic" || registeredClient.registration_access_token !== "registration-token") {
		throw new Error("OAuth registration adapter dropped required fields");
	}
	if ("client_uri" in registeredClient || "policy_uri" in registeredClient || "contacts" in registeredClient) {
		throw new Error("OAuth registration adapter retained invalid optional fields");
	}

	const oauthError = await fetch(`${base}/oauth/error?error_description=${encodeURIComponent("Invalid <request>")}`);
	if (oauthError.status !== 400) throw new Error(`OAuth error page returned ${oauthError.status}`);
	const oauthErrorBody = await oauthError.text();
	if (!oauthErrorBody.includes("Invalid &lt;request&gt;") || oauthErrorBody.includes("Invalid <request>")) {
		throw new Error("OAuth error page did not escape its message");
	}
	if (!oauthErrorBody.includes('aria-label="Tenki"') || !oauthErrorBody.includes("--tenki-blue:#047bff")) {
		throw new Error("OAuth error page omitted Tenki branding");
	}

	for (const allowed of [undefined, "https://fabric.tenki.test", "https://fabric.tenki.test/", "https://fabric.tenki.test:443"]) {
		if (!requestOriginAllowed(allowed, "https://fabric.tenki.test")) {
			throw new Error(`OAuth consent rejected equivalent origin ${allowed}`);
		}
	}
	for (const rejected of ["null", "http://fabric.tenki.test", "https://evil.tenki.test", "https://fabric.tenki.test.evil.test"]) {
		if (requestOriginAllowed(rejected, "https://fabric.tenki.test")) {
			throw new Error(`OAuth consent allowed hostile origin ${rejected}`);
		}
	}

	const logout = await fetch(`${base}/oauth/logout?logout_challenge=${logoutChallenge}`, { redirect: "manual" });
	if (logout.status !== 302 || logout.headers.get("location") !== "https://oauth.tenki.test/logged-out") {
		throw new Error(`OAuth logout returned ${logout.status} ${logout.headers.get("location")}`);
	}
	if (!logoutRequestRead || !logoutAccepted) throw new Error("OAuth logout did not validate and accept the Hydra challenge");

	const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: "oauth-http-test", version: "1.0.0" });
	await client.connect(transport);
	const { tools } = await client.listTools();
	if (tools.length !== 71) throw new Error(`OAuth MCP advertised ${tools.length} tools; expected 71`);
	await client.close();

	console.log("✓ RFC 9728 protected-resource metadata is public");
	console.log("✓ unauthenticated MCP requests return an OAuth challenge");
	console.log("✓ Hydra dynamic registration responses are normalized for MCP clients");
	console.log("✓ branded OAuth errors are safely rendered and Hydra logout challenges are accepted");
	console.log("✓ OAuth consent accepts equivalent public origins and rejects cross-origin submissions");
	console.log("✓ an introspected workspace-bound token initializes MCP");
} finally {
	await new Promise((resolve) => server.close(resolve));
	await new Promise((resolve) => introspection.close(resolve));
}
