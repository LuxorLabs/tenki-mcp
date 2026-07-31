# Contributing to tenki-mcp

Thanks for your interest! This is the Model Context Protocol server for [Tenki Cloud](https://tenki.cloud).

## Development

```bash
git clone https://github.com/LuxorLabs/tenki-mcp.git && cd tenki-mcp
npm install
npm run build          # tsc → dist/
```

## Tests

There are two tiers:

- **Offline suites — no token, run in CI.** These prove the server boots, advertises a
  well-formed 84-tool surface, validates args pre-network, and enforces the security
  controls. They make zero network calls.

  ```bash
  npm test               # offline suite (test/offline.test.mjs); builds first
  node test/http-input.test.mjs      # HTTP body-limit regression
  node test/security.test.mjs        # annotations / read-only mode / denylist
  node scripts/parity-audit.mjs      # every API method has a tool
  ```

- **Live suites — need a real Tenki token.** These drive the actual MCP protocol against
  `api.tenki.cloud`. Set `TENKI_API_KEY` (or `TENKI_AUTH_TOKEN`) first.

  ```bash
  TENKI_API_KEY=tk_... npm run test:all
  ```

CI (`.github/workflows/ci.yml`) runs build + parity + the offline suites on Node 20 and 22.
It requires **no secrets** — the live suites are local-only by design.

## Adding a tool

Tools live in `src/tools/<domain>.ts`; each module exports a `register<Domain>(server, client)`
that calls `server.tool(name, description, zodShape, handler)`. Add new modules to the
`modules` array in `src/server.ts`. The parity audit will fail the build if an API method
has no tool. The expected tool count is asserted in the offline suites — update those if you
add or remove a tool.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a
public issue for security reports.
