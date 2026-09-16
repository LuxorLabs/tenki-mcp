import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import http from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceToken = "ory_at_test";
const refreshedSourceToken = "ory_at_refreshed";
const identityServiceToken = "identity-service-token";
const delegationSecret = "0123456789abcdef0123456789abcdef";
let delegatedRequests = 0;
let refreshedDelegatedRequests = 0;
let identityExchanges = 0;

function signDelegation(audience, generation) {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "tenki-mcp-delegation+jwt" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: "http://127.0.0.1",
			aud: audience,
			sub: userId,
			workspace_id: workspaceId,
			client_id: "claude-test",
			scope: "mcp",
			generation,
			iat: now,
			exp: now + 60,
			jti: randomUUID(),
		}),
	).toString("base64url");
	const signature = createHmac("sha256", delegationSecret).update(`${header}.${payload}`).digest("base64url");
	return `${header}.${payload}.${signature}`;
}

function verifyDelegation(header, audience) {
	if (!header?.startsWith("Bearer ")) throw new Error("backend request omitted Bearer delegation");
	const token = header.slice("Bearer ".length);
	if ([sourceToken, refreshedSourceToken].some((source) => token === source || token.includes(source))) {
		throw new Error("MCP access token was passed through to the backend");
	}
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("backend credential is not a JWT");
	const expected = createHmac("sha256", delegationSecret).update(`${parts[0]}.${parts[1]}`).digest();
	const actual = Buffer.from(parts[2], "base64url");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		throw new Error("backend delegation signature is invalid");
	}
	const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	if (payload.iss !== "http://127.0.0.1" || payload.aud !== audience) {
		throw new Error("backend delegation issuer/audience is invalid");
	}
	if (payload.sub !== userId || payload.workspace_id !== workspaceId || payload.client_id !== "claude-test") {
		throw new Error("backend delegation lost its user, workspace, or client binding");
	}
	if (!String(payload.scope).split(" ").includes("mcp") || payload.exp - payload.iat > 60) {
		throw new Error("backend delegation has invalid scope or lifetime");
	}
	if (payload.generation === "refreshed") refreshedDelegatedRequests++;
	delegatedRequests++;
}

const api = http.createServer((req, res) => {
	verifyDelegation(req.headers.authorization, `http://127.0.0.1:${api.address().port}`);
	res.writeHead(200, { "Content-Type": "application/json" });
	if (req.url?.endsWith("/WhoAmI")) {
		res.end(JSON.stringify({ ownerType: "USER", ownerId: userId, workspaces: [{ workspaceId, name: "Test" }] }));
		return;
	}
	res.end(JSON.stringify({ usage: {} }));
});
api.listen(0, "127.0.0.1");
await once(api, "listening");
const apiAddress = api.address();

const identity = http.createServer((req, res) => {
	if (
		req.method !== "POST" ||
		req.url !== "/tenki.cloud.identity.private.v1beta1.IdentityPrivateService/ExchangeMcpOAuthToken"
	) {
		res.writeHead(404).end();
		return;
	}
	if (req.headers["x-service-token"] !== identityServiceToken) {
		res.writeHead(401).end();
		return;
	}
	let raw = "";
	req.setEncoding("utf8");
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const presentedToken = JSON.parse(raw).accessToken;
		if (presentedToken !== sourceToken && presentedToken !== refreshedSourceToken) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ code: "unauthenticated", message: "invalid token" }));
			return;
		}
		identityExchanges++;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				subject: userId,
				workspaceId,
				clientId: "claude-test",
				scopes: ["mcp"],
				expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
				apiDelegationToken: signDelegation(
					`http://127.0.0.1:${apiAddress.port}`,
					presentedToken === refreshedSourceToken ? "refreshed" : "initial",
				),
			}),
		);
	});
});
identity.listen(0, "127.0.0.1");
await once(identity, "listening");
const identityAddress = identity.address();

process.env.TENKI_MCP_OAUTH_ISSUER = "https://oauth.tenki.test";
process.env.TENKI_MCP_IDENTITY_URL = `http://127.0.0.1:${identityAddress.port}`;
process.env.TENKI_MCP_IDENTITY_SERVICE_TOKEN = identityServiceToken;
process.env.TENKI_MCP_PUBLIC_URL = "http://127.0.0.1";
process.env.TENKI_MCP_OAUTH_RESOURCE = "http://127.0.0.1/mcp";
process.env.TENKI_API_ENDPOINT = `http://127.0.0.1:${apiAddress.port}`;

const { authorizationBinding } = await import("../dist/oauth.js");
const { startHttp } = await import("../dist/http.js");
const server = startHttp(null, 0);
if (!server.listening) await once(server, "listening");
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
	const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
	if (!metadata.ok) throw new Error(`metadata returned ${metadata.status}`);
	const resource = await metadata.json();
	if (resource.resource !== "http://127.0.0.1/mcp") {
		throw new Error("protected-resource metadata has wrong resource");
	}

	const unauthorized = await fetch(`${base}/mcp`, { method: "POST" });
	if (unauthorized.status !== 401) throw new Error(`unauthorized request returned ${unauthorized.status}`);
	if (!unauthorized.headers.get("www-authenticate")?.includes("resource_metadata=")) {
		throw new Error("401 challenge omitted resource_metadata");
	}

	for (const path of ["/.well-known/oauth-authorization-server", "/oauth/register", "/mcp/oauth2/auth"]) {
		const response = await fetch(`${base}${path}`);
		if (response.status !== 404) throw new Error(`MCP server still owns OAuth provider route ${path}`);
	}

	const requestHeaders = new Headers({ Authorization: `Bearer ${sourceToken}` });
	const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
		requestInit: { headers: requestHeaders },
	});
	const client = new Client({ name: "oauth-http-test", version: "1.0.0" });
	await client.connect(transport);
	const { tools } = await client.listTools();
	if (tools.length !== 71) throw new Error(`OAuth MCP advertised ${tools.length} tools; expected 71`);
	requestHeaders.set("Authorization", `Bearer ${refreshedSourceToken}`);
	await client.callTool({ name: "tenki_get_workspace_usage", arguments: {} });
	if (delegatedRequests < 2) throw new Error("tool call did not reach the backend with delegated authentication");
	if (refreshedDelegatedRequests < 1) throw new Error("the MCP session did not adopt its refreshed API delegation");
	if (identityExchanges < 2) throw new Error("MCP access tokens were not exchanged through Tenki Identity");
	if (
		authorizationBinding({
			tokenDigest: "first",
			subject: userId,
			workspaceId,
			clientId: "claude-test",
			scope: ["mcp"],
			apiDelegationToken: "first-delegation",
		}) !==
		authorizationBinding({
			tokenDigest: "refreshed",
			subject: userId,
			workspaceId,
			clientId: "claude-test",
			scope: ["mcp"],
			apiDelegationToken: "refreshed-delegation",
		})
	) {
		throw new Error("an OAuth token refresh changes the MCP session binding");
	}
	await client.close();

	console.log("✓ RFC 9728 protected-resource metadata is public");
	console.log("✓ OAuth provider routes are owned by Tenki Identity");
	console.log("✓ unauthenticated MCP requests return an OAuth challenge");
	console.log("✓ MCP access tokens are exchanged through Tenki Identity");
	console.log("✓ only short-lived, workspace-bound API delegations reach the backend");
	console.log("✓ OAuth token refresh preserves the authenticated MCP session binding");
} finally {
	await new Promise((resolve) => server.close(resolve));
	await new Promise((resolve) => identity.close(resolve));
	await new Promise((resolve) => api.close(resolve));
}
