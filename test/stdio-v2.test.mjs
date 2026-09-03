import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "dist",
  "index.js",
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    TENKI_API_KEY: "",
    TENKI_AUTH_TOKEN: "",
    TENKI_MCP_TRANSPORT: "stdio",
  },
});
const client = new Client(
  { name: "stdio-modern-test", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

try {
  await client.connect(transport);
  if (client.getProtocolEra() !== "modern") {
    throw new Error("stdio did not negotiate the 2026-07-28 protocol");
  }
  const { tools } = await client.listTools();
  if (tools.length !== 1 || tools[0].name !== "tenki_auth_status") {
    throw new Error(
      `modern stdio advertised unexpected tools: ${tools.map((tool) => tool.name).join(", ")}`,
    );
  }
  console.log("✓ stdio negotiates MCP 2026-07-28");
  console.log("✓ modern stdio lists tools from the shared server factory");
} finally {
  await client.close();
}
