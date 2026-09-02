import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceToken = "ory_at_test";
const refreshedSourceToken = "ory_at_refreshed";
const delegationSecret = "0123456789abcdef0123456789abcdef";
let delegatedRequests = 0;
let authorizationProxyRequests = 0;
let registrationAudienceBound = false;

function verifyDelegation(header, audience) {
	if (!header?.startsWith("Bearer "))
		throw new Error("backend request omitted Bearer delegation");
	const token = header.slice("Bearer ".length);
	if (
		[sourceToken, refreshedSourceToken].some(
			(source) => token === source || token.includes(source),
		)
	) {
		throw new Error("MCP access token was passed through to the backend");
	}
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("backend credential is not a JWT");
	const expected = createHmac("sha256", delegationSecret)
		.update(`${parts[0]}.${parts[1]}`)
		.digest();
	const actual = Buffer.from(parts[2], "base64url");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error("backend delegation signature is invalid");
	const payload = JSON.parse(
		Buffer.from(parts[1], "base64url").toString("utf8"),
	);
	if (payload.iss !== "http://127.0.0.1" || payload.aud !== audience)
		throw new Error("backend delegation issuer/audience is invalid");
	if (
		payload.sub !== userId ||
		payload.workspace_id !== workspaceId ||
		payload.client_id !== "claude-test"
	) {
		throw new Error(
			"backend delegation lost its user, workspace, or client binding",
		);
	}
	if (
		!String(payload.scope).split(" ").includes("mcp") ||
		payload.exp - payload.iat > 60
	) {
		throw new Error("backend delegation has invalid scope or lifetime");
	}
	delegatedRequests++;
}

const api = http.createServer((req, res) => {
	verifyDelegation(
		req.headers.authorization,
		`http://127.0.0.1:${api.address().port}`,
	);
	res.writeHead(200, { "Content-Type": "application/json" });
	if (req.url?.endsWith("/WhoAmI")) {
		res.end(
			JSON.stringify({
				ownerType: "USER",
				ownerId: userId,
				workspaces: [{ workspaceId, name: "Test" }],
			}),
		);
		return;
	}
	res.end(JSON.stringify({ usage: {} }));
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const apiAddress = api.address();

const hydra = http.createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	if (req.method === "POST" && url.pathname === "/oauth2/register") {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			registrationAudienceBound =
				JSON.parse(body).audience?.[0] === "http://127.0.0.1/mcp";
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					client_id: "claude-dynamic",
					client_uri: "",
					policy_uri: "",
					contacts: null,
					registration_access_token: "registration-token",
					registration_client_uri:
						"https://oauth.tenki.test/oauth2/register/claude-dynamic",
				}),
			);
		});
		return;
	}
	if (req.method === "GET" && url.pathname === "/oauth2/auth") {
		if (
			url.searchParams.get("audience") !== "http://127.0.0.1/mcp" ||
			url.searchParams.has("resource")
		) {
			throw new Error(
				"authorization adapter did not translate the resource into Hydra's audience parameter",
			);
		}
		authorizationProxyRequests++;
		res.writeHead(302, {
			Location: "https://app.tenki.test/mcp/oauth/login?login_challenge=test",
			"Set-Cookie":
				"oauth_session=test; Path=/; HttpOnly; Secure; SameSite=Lax",
		});
		res.end();
		return;
	}

	let body = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		const presentedToken = new URLSearchParams(body).get("token");
		const valid =
			presentedToken === sourceToken || presentedToken === refreshedSourceToken;
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
							exp: Math.floor(Date.now() / 1000) + 3600,
							ext: { workspace_id: workspaceId },
						}
					: { active: false },
			),
		);
	});
});
hydra.listen(0, "127.0.0.1");
await once(hydra, "listening");
const hydraAddress = hydra.address();

process.env.TENKI_MCP_OAUTH_ISSUER = "https://oauth.tenki.test";
process.env.TENKI_MCP_OAUTH_INTROSPECTION_URL = `http://127.0.0.1:${hydraAddress.port}/admin/oauth2/introspect`;
process.env.TENKI_MCP_HYDRA_PUBLIC_URL = `http://127.0.0.1:${hydraAddress.port}`;
process.env.TENKI_MCP_PUBLIC_URL = "http://127.0.0.1";
process.env.TENKI_MCP_OAUTH_RESOURCE = "http://127.0.0.1/mcp";
process.env.TENKI_MCP_API_DELEGATION_SECRET = delegationSecret;
process.env.TENKI_API_ENDPOINT = `http://127.0.0.1:${apiAddress.port}`;

const { authorizationBinding } = await import("../dist/oauth.js");
const { startHttp } = await import("../dist/http.js");
const server = startHttp(null, 0);
if (!server.listening) await once(server, "listening");
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
	const metadata = await fetch(
		`${base}/.well-known/oauth-protected-resource/mcp`,
	);
	if (!metadata.ok) throw new Error(`metadata returned ${metadata.status}`);
	const resource = await metadata.json();
	if (resource.resource !== "http://127.0.0.1/mcp")
		throw new Error("protected-resource metadata has wrong resource");

	const unauthorized = await fetch(`${base}/mcp`, { method: "POST" });
	if (unauthorized.status !== 401)
		throw new Error(`unauthorized request returned ${unauthorized.status}`);
	if (
		!unauthorized.headers
			.get("www-authenticate")
			?.includes("resource_metadata=")
	) {
		throw new Error("401 challenge omitted resource_metadata");
	}

	const authorizationMetadata = await fetch(
		`${base}/.well-known/oauth-authorization-server`,
	);
	if (!authorizationMetadata.ok)
		throw new Error(
			`authorization metadata returned ${authorizationMetadata.status}`,
		);
	const authorizationServer = await authorizationMetadata.json();
	if (
		authorizationServer.authorization_endpoint !==
		"https://oauth.tenki.test/mcp/oauth2/auth"
	) {
		throw new Error(
			"authorization metadata did not advertise the resource adapter",
		);
	}

	const registration = await fetch(`${base}/oauth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ redirect_uris: ["http://127.0.0.1/callback"] }),
	});
	if (registration.status !== 201)
		throw new Error(`OAuth registration returned ${registration.status}`);
	const registeredClient = await registration.json();
	if (
		registeredClient.client_id !== "claude-dynamic" ||
		registeredClient.registration_access_token !== "registration-token"
	) {
		throw new Error("OAuth registration adapter dropped required fields");
	}
	if (
		"client_uri" in registeredClient ||
		"policy_uri" in registeredClient ||
		"contacts" in registeredClient
	) {
		throw new Error(
			"OAuth registration adapter retained invalid optional fields",
		);
	}
	if (!registrationAudienceBound)
		throw new Error(
			"dynamic registration was not restricted to the MCP resource audience",
		);

	const authorize = await fetch(
		`${base}/mcp/oauth2/auth?client_id=claude-dynamic&response_type=code&resource=${encodeURIComponent("http://127.0.0.1/mcp")}`,
		{ redirect: "manual" },
	);
	if (authorize.status !== 302 || authorizationProxyRequests !== 1) {
		throw new Error("resource-bound authorization was not forwarded to Hydra");
	}
	if (!authorize.headers.get("set-cookie")?.includes("oauth_session=")) {
		throw new Error("authorization adapter dropped Hydra's session cookie");
	}
	const invalidTarget = await fetch(
		`${base}/mcp/oauth2/auth?client_id=claude-dynamic&response_type=code&resource=https%3A%2F%2Fapi.attacker.test`,
		{ redirect: "manual" },
	);
	if (invalidTarget.status !== 400 || authorizationProxyRequests !== 1) {
		throw new Error(
			"authorization adapter forwarded an invalid OAuth resource",
		);
	}

	const oldConsentRoute = await fetch(`${base}/oauth/consent`);
	if (oldConsentRoute.status !== 404)
		throw new Error("MCP server still hosts the browser consent route");

	const requestHeaders = new Headers({
		Authorization: `Bearer ${sourceToken}`,
	});
	const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
		requestInit: { headers: requestHeaders },
	});
	const client = new Client(
		{ name: "oauth-http-legacy-test", version: "1.0.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	await client.connect(transport);
	if (client.getProtocolEra() !== "legacy") {
		throw new Error("MCP client did not negotiate the legacy 2025 protocol");
	}
	const { tools } = await client.listTools();
	if (tools.length !== 71)
		throw new Error(`OAuth MCP advertised ${tools.length} tools; expected 71`);
	requestHeaders.set("Authorization", `Bearer ${refreshedSourceToken}`);
	await client.callTool({ name: "tenki_get_workspace_usage", arguments: {} });
	if (delegatedRequests < 2)
		throw new Error(
			"tool call did not reach the backend with delegated authentication",
		);
	if (
		authorizationBinding({
			tokenDigest: "first",
			subject: userId,
			workspaceId,
			clientId: "claude-test",
			scope: ["mcp"],
		}) !==
		authorizationBinding({
			tokenDigest: "refreshed",
			subject: userId,
			workspaceId,
			clientId: "claude-test",
			scope: ["mcp"],
		})
	) {
		throw new Error("an OAuth token refresh changes the MCP session binding");
	}
	await client.close();

	const modernTransport = new StreamableHTTPClientTransport(
		new URL(`${base}/mcp`),
		{ requestInit: { headers: requestHeaders } },
	);
	const modernClient = new Client(
		{ name: "oauth-http-modern-test", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await modernClient.connect(modernTransport);
	if (modernClient.getProtocolEra() !== "modern") {
		throw new Error("MCP client did not negotiate the 2026-07-28 protocol");
	}
	const modernTools = await modernClient.listTools();
	if (modernTools.tools.length !== 71) {
		throw new Error(
			`Modern OAuth MCP advertised ${modernTools.tools.length} tools; expected 71`,
		);
	}
	await modernClient.callTool({
		name: "tenki_get_workspace_usage",
		arguments: {},
	});
	await modernClient.close();

	console.log("✓ RFC 9728 protected-resource metadata is public");
	console.log(
		"✓ RFC 8707 resources are translated into Hydra-bound token audiences",
	);
	console.log("✓ unauthenticated MCP requests return an OAuth challenge");
	console.log(
		"✓ Hydra dynamic registration responses are normalized for MCP clients",
	);
	console.log("✓ browser login and consent are no longer hosted by tenki-mcp");
	console.log(
		"✓ MCP tokens are translated into short-lived, workspace-bound API delegations",
	);
	console.log(
		"✓ OAuth token refresh preserves the authenticated MCP session binding",
	);
	console.log("✓ OAuth-authenticated legacy clients remain supported");
	console.log(
		"✓ OAuth-authenticated clients negotiate and call tools over MCP 2026-07-28",
	);
} finally {
	await new Promise((resolve) => server.close(resolve));
	await new Promise((resolve) => hydra.close(resolve));
	await new Promise((resolve) => api.close(resolve));
}
