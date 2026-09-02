/**
 * Offline HTTP input-boundary regression.
 *
 * Proves an oversized chunked request is rejected without Tenki API access,
 * then verifies the same server still accepts a normal MCP initialization.
 */
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import http from "node:http";
import { once } from "node:events";

import { TenkiClient } from "../dist/client.js";
import { startHttp } from "../dist/http.js";

const server = startHttp(new TenkiClient("tk_offline_dummy"), 0);
if (!server.listening) await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string")
	throw new Error("HTTP server did not expose a TCP address.");
const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

function oversizedChunkedPost() {
	return new Promise((resolve, reject) => {
		const req = http.request(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Transfer-Encoding": "chunked",
			},
		});
		req.on("response", (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		});
		req.on("error", reject);
		req.write(`{"payload":"${"x".repeat(1024 * 1024)}`);
		req.end('"}');
	});
}

try {
	const oversized = await oversizedChunkedPost();
	if (oversized.status !== 413) {
		throw new Error(
			`oversized POST returned ${oversized.status}; expected 413`,
		);
	}
	if (!oversized.body.includes("Request body exceeds")) {
		throw new Error(
			`oversized POST returned an unexpected body: ${oversized.body.slice(0, 120)}`,
		);
	}

	const legacyTransport = new StreamableHTTPClientTransport(endpoint);
	const legacyClient = new Client(
		{ name: "http-input-legacy-test", version: "1.0.0" },
		{ versionNegotiation: { mode: "legacy" } },
	);
	await legacyClient.connect(legacyTransport);
	if (legacyClient.getProtocolEra() !== "legacy")
		throw new Error("legacy HTTP client did not negotiate the 2025 protocol");
	const legacyTools = await legacyClient.listTools();
	if (legacyTools.tools.length !== 71)
		throw new Error(
			`legacy MCP request returned ${legacyTools.tools.length} tools; expected 71`,
		);
	await legacyClient.close();

	const modernTransport = new StreamableHTTPClientTransport(endpoint);
	const modernClient = new Client(
		{ name: "http-input-modern-test", version: "1.0.0" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await modernClient.connect(modernTransport);
	if (modernClient.getProtocolEra() !== "modern")
		throw new Error("modern HTTP client did not negotiate the 2026 protocol");
	const modernTools = await modernClient.listTools();
	if (modernTools.tools.length !== 71)
		throw new Error(
			`modern MCP request returned ${modernTools.tools.length} tools; expected 71`,
		);
	await modernClient.close();

	console.log("✓ oversized chunked POST rejected with 413");
	console.log(
		"✓ legacy stateful HTTP still negotiates and advertises 71 tools",
	);
	console.log("✓ modern stateless HTTP negotiates and advertises 71 tools");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
