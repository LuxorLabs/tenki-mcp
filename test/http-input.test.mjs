/**
 * Offline HTTP input-boundary regression.
 *
 * Proves an oversized chunked request is rejected without Tenki API access,
 * then verifies the same server still accepts a normal MCP initialization.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { once } from "node:events";

import { TenkiClient } from "../dist/client.js";
import { startHttp } from "../dist/http.js";

const server = startHttp(new TenkiClient("tk_offline_dummy"), 0);
if (!server.listening) await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address.");
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
		req.end("\"}");
	});
}

try {
	const oversized = await oversizedChunkedPost();
	if (oversized.status !== 413) {
		throw new Error(`oversized POST returned ${oversized.status}; expected 413`);
	}
	if (!oversized.body.includes("Request body exceeds")) {
		throw new Error(`oversized POST returned an unexpected body: ${oversized.body.slice(0, 120)}`);
	}

	const transport = new StreamableHTTPClientTransport(endpoint);
	const client = new Client({ name: "http-input-test", version: "1.0.0" });
	await client.connect(transport);
	const { tools } = await client.listTools();
	if (tools.length !== 84) throw new Error(`normal MCP request returned ${tools.length} tools; expected 84`);
	await client.close();

	console.log("✓ oversized chunked POST rejected with 413");
	console.log("✓ normal MCP initialization still advertises 84 tools");
} finally {
	await new Promise((resolve) => server.close(resolve));
}
