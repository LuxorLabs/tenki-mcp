# tenki-mcp

**A [Model Context Protocol](https://modelcontextprotocol.io) server for [Tenki Cloud](https://tenki.cloud).** Give any agent — Claude, Codex, Cursor — a disposable microVM it can create, run code in, read and write files, run git, and expose to the web. Sandboxes boot in ~2 seconds and are billed per second.

Part of making Tenki the execution layer coding agents reach for: the agent writes code, Tenki runs it in isolation, and (with Runners + Code Reviewer) tests and reviews it before it ships.

```
"Run this Python in a fresh sandbox and tell me what it prints."
        │
        ▼   tenki_run_code
   boots a microVM → runs it → returns stdout → tears it down
```

## Quickstart

```bash
npm install
npm run build
export TENKI_API_KEY=tk_your_key_here
node dist/index.js         # speaks MCP over stdio
```

### Use it in Claude Desktop / Cursor

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tenki": {
      "command": "node",
      "args": ["/absolute/path/to/tenki-mcp/dist/index.js"],
      "env": { "TENKI_API_KEY": "tk_your_key_here" }
    }
  }
}
```

Once published to npm this becomes `"command": "npx", "args": ["-y", "tenki-mcp"]`.

## Tools

**84 tools** — full parity with the Tenki unary API (enforced by a CI [parity audit](scripts/parity-audit.mjs)), grouped by domain:

| Domain | Tools |
|---|---|
| **Identity** | `tenki_whoami` |
| **Run** | `tenki_run_code` (one-shot: boot → run shell/python/js → tear down) |
| **Sandboxes** | `tenki_create_sandbox` · `tenki_get_sandbox` · `tenki_list_sandboxes` · `tenki_terminate_sandbox` · `tenki_pause_sandbox` · `tenki_resume_sandbox` |
| **Session admin** | `tenki_extend_sandbox` · `tenki_update_sandbox` · `tenki_terminate_sandboxes` (bulk) · `tenki_report_sandbox_activity` · `tenki_list_workspace_sandboxes` · `tenki_list_project_sandboxes` |
| **Exec** | `tenki_exec` (stdout/stderr/exit inline) |
| **Files** | `tenki_read_file` · `tenki_write_file` · `tenki_list_files` · `tenki_stat_path` · `tenki_make_dir` · `tenki_remove_path` · `tenki_move_path` |
| **Git** | `tenki_git` (clone/checkout/diff/log/status/add/commit/pull/push/fetchPR) |
| **Ports & previews** | expose · list-exposed · unexpose · create-preview-url · open-preview · list/get/delete-preview-url · touch-preview · bind/unbind-preview-url · resolve-preview-token |
| **Artifacts** (binary transfer) | `tenki_get_upload_url` · `tenki_get_download_url` (signed URLs for binary PUT/GET) |
| **SSH** | `tenki_update_ssh_keys` · `tenki_issue_ssh_cert` · `tenki_list_ssh_gateways` |
| **Snapshots** | create · get · list · list-session · list-dangling · update · delete · get-download-url |
| **Volumes** | create · get · list · update · delete · resize · attach · detach |
| **Templates** | create · get · list · update · delete · build · cancel-build · get-build · list-active-builds |
| **Registry** (custom images) | publish · get · list · set-visibility · delete · delete-version · resolve-ref · share · list-share-grants |
| **Workspace** | `tenki_get_workspace_usage` · `tenki_get_workspace_settings` · `tenki_update_workspace_settings` · `tenki_get_snapshot_retention_settings` · `tenki_update_snapshot_retention_settings` |

Full per-release breakdown in [CHANGELOG.md](CHANGELOG.md); the plan through v2.0 is in [docs/plans/ROADMAP.md](docs/plans/ROADMAP.md).

## Auth

Set one of `TENKI_API_KEY` or `TENKI_AUTH_TOKEN`. The header is chosen by token prefix: `tk_…` → `Authorization: Bearer`, `ory_st_…` → `X-Session-Token`, otherwise a session cookie. Override the endpoint with `TENKI_API_ENDPOINT` (default `https://api.tenki.cloud`).

## Host it over HTTP (v2.0-alpha)

Besides stdio, the server speaks **Streamable HTTP** so it can be hosted for remote MCP clients:

```bash
TENKI_MCP_TRANSPORT=http PORT=3000 TENKI_API_KEY=… node dist/index.js
# → tenki-mcp running on http://127.0.0.1:3000/mcp (Streamable HTTP) [loopback only, no auth]
```

**Security — this endpoint is a capability.** In HTTP mode the process holds one shared `TENKI_API_KEY` and exposes every tool, including arbitrary code execution and credit spend. So by default it:

- **binds to loopback (`127.0.0.1`) only** — set `TENKI_MCP_HTTP_HOST=0.0.0.0` to expose it, but then
- it **requires a bearer token**: set `TENKI_MCP_HTTP_TOKEN` and send `Authorization: Bearer <token>`. It **refuses to start** on a non-loopback host without one.
- **DNS-rebinding protection** is on (Host-header allowlist), so a malicious web page can't drive your local server.

```bash
# expose to a network safely:
TENKI_MCP_TRANSPORT=http TENKI_MCP_HTTP_HOST=0.0.0.0 PORT=3000 \
  TENKI_MCP_HTTP_TOKEN=$(openssl rand -hex 32) TENKI_API_KEY=… node dist/index.js
```

Point an HTTP-capable MCP client at `/mcp`. v2.0-alpha uses one shared `TENKI_API_KEY` for all sessions; per-request auth (multi-tenant hosting) is a later step. Verified end-to-end (`test/http-transport.test.mjs`: auth gate, DNS-rebinding rejection, connect → tools/list → tool call over HTTP). Streaming exec (`StreamCommandOutput`) is designed and proven feasible over `fetch` — see `docs/plans/V2-STATE.md`.

## How it works

Tenki's API is **ConnectRPC** — JSON over HTTP/1.1, not REST. Every control-plane call is `POST https://api.tenki.cloud/tenki.sandbox.v1.SandboxService/{Method}` with a lowerCamelCase JSON body. Per-session file I/O runs on a **separate data-plane endpoint** returned at create time, authenticated with a short-lived session certificate. This server owns both transports so the tools stay one-liners.

One sharp edge worth knowing: on the current gateway `ExecuteCommand` reports status and exit code but does **not** return output artifacts (the SDK streams output over gRPC, which a plain HTTP client can't speak). So `tenki_exec` and `tenki_run_code` capture output by redirecting to files (`sh -c '… > out 2> err'`) and reading them back over the data plane. It's transparent to the caller — you get `stdout`/`stderr` inline.

The wire details are ported from the live-verified [n8n community node](https://github.com/opencolin/n8n-nodes-tenki).

## Roadmap

Shipped v0.2→v1.0: filesystem completion, session/fleet control, preview URLs, snapshots+volumes, templates+registry, workspace admin, and full-parity v1.0 (84 tools, CI-enforced parity audit — no API method without a tool). v1.0.1/1.0.2 fixed two request-shape bugs found by the test suite. **v2.0.0-alpha.0** ships the HTTP/SSE transport (Streamable HTTP; `TENKI_MCP_TRANSPORT=http`) — the server is hostable, not just local-stdio. See [CHANGELOG.md](CHANGELOG.md) and [ROADMAP.md](docs/plans/ROADMAP.md). Still ahead:

- **v2.0 GA** — streaming exec (`StreamCommandOutput` via Connect length-prefixed envelopes over `fetch`; feasibility proven, see [docs/plans/V2-STATE.md](docs/plans/V2-STATE.md)); per-request HTTP auth (multi-tenant hosting); interactive shells (`Run`/`Dial`, needs a gRPC/HTTP2 or WebSocket path)
- npm publish + MCP-registry listings (`server.json` at repo root; awaiting the human `npm publish` + `mcp-publisher login/publish` steps)

## Security

This server holds a Tenki API key and can run code + spend credits, so treat it as a capability. Full model + [CSA MCP Server Top-10](https://modelcontextprotocol-security.io/top10/server/) mapping in **[SECURITY.md](SECURITY.md)**. Quick controls:

- **Least privilege:** every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`). Run `TENKI_MCP_READONLY=1` for an inspection-only server (read tools only), or `TENKI_MCP_DISABLED_TOOLS=tenki_run_code,…` to drop specific tools.
- **HTTP transport** is loopback-only by default and requires a bearer token to expose to a network (see [Host it over HTTP](#host-it-over-http-v20-alpha)).
- **Audit:** `TENKI_MCP_AUDIT=1` logs each tool call's name to stderr.
- **Untrusted output:** `tenki_run_code`/`tenki_exec`/`tenki_read_file` return output from untrusted code — clients should treat tool results as data, not instructions.

Report vulnerabilities via a private [security advisory](https://github.com/LuxorLabs/tenki-mcp/security/advisories/new), not a public issue.

## Related

- **Tenki Sandbox** — the platform: https://tenki.cloud
- **n8n-nodes-tenki** — Tenki as an n8n node: https://github.com/opencolin/n8n-nodes-tenki

## License

MIT
