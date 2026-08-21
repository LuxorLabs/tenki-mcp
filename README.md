# tenki-mcp — `@tenkicloud/mcp`

**A [Model Context Protocol](https://modelcontextprotocol.io) server for [Tenki Cloud](https://tenki.cloud).** Give any agent — Claude, Codex, Cursor — a disposable microVM it can create, run code in, read and write files, run git, and expose to the web. Sandboxes boot in ~2 seconds and are billed per second.

Part of making Tenki the execution layer coding agents reach for: the agent writes code and Tenki runs it in isolation. (Tenki's **Code Reviewer** and **Runners** — AI PR review and managed CI — are separate products; this server currently exposes the Sandbox.)

```
"Run this Python in a fresh sandbox and tell me what it prints."
        │
        ▼   tenki_run_code
   boots a microVM → runs it → returns stdout → tears it down
```

## Quickstart

```bash
export TENKI_API_KEY=tk_your_key_here
npx -y @tenkicloud/mcp     # speaks MCP over stdio
```

Nothing to clone or build. The package installs one command, `tenki-mcp`.

> **Heads up — pending first npm publish.** Until `@tenkicloud/mcp` lands on npm, use [Run it from a clone](#run-it-from-a-clone-instead) below. Every `npx -y @tenkicloud/mcp` form here activates the moment it's published.

### Use it in Claude Code

```bash
claude mcp add tenki --env TENKI_API_KEY=tk_your_key_here -- npx -y @tenkicloud/mcp
```

### Use it in Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tenki": {
      "command": "npx",
      "args": ["-y", "@tenkicloud/mcp"],
      "env": { "TENKI_API_KEY": "tk_your_key_here" }
    }
  }
}
```

### Use it in Cursor

Add the same block to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "tenki": {
      "command": "npx",
      "args": ["-y", "@tenkicloud/mcp"],
      "env": { "TENKI_API_KEY": "tk_your_key_here" }
    }
  }
}
```

### Use it in Codex

The OpenAI Codex CLI reads MCP servers from `~/.codex/config.toml`. Add:

```toml
[mcp_servers.tenki]
command = "npx"
args = ["-y", "@tenkicloud/mcp"]
env = { TENKI_API_KEY = "tk_your_key_here" }
```

### Confirm it's working

After adding the server, **start a fresh session** so the client loads it, then ask your agent one of:

- *"Check tenki auth status."* — confirms your credential was picked up.
- *"Run `print(2+2)` in a fresh Tenki sandbox."* — a full boot → run → teardown round-trip.

If the `tenki_*` tools don't show up, restart the client so it re-reads its config.

No key yet? Start the server without one and ask the agent to check `tenki_auth_status` — it reports what to set and where. See [Auth](#auth).

### Run it from a clone instead

For development, or to run an unreleased change:

```bash
git clone https://github.com/LuxorLabs/tenki-mcp.git && cd tenki-mcp
npm install && npm run build
TENKI_API_KEY=tk_your_key_here node dist/index.js
```

Substitute `node /absolute/path/to/tenki-mcp/dist/index.js` for the `npx` command in any of the configs above. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development loop.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TENKI_API_KEY` | — | API key (`tk_…`). One of this or `TENKI_AUTH_TOKEN` is required. |
| `TENKI_AUTH_TOKEN` | — | Session token (`ory_st_…` or cookie value). **Takes precedence over `TENKI_API_KEY`** when both are set. |
| `TENKI_API_ENDPOINT` | `https://api.tenki.cloud` | Control-plane base URL (`TENKI_API_URL` is an alias). |
| `TENKI_MCP_READONLY` | off | `1` registers only read tools (no create/run/delete/spend). |
| `TENKI_MCP_DISABLED_TOOLS` | — | Comma-separated tool names to skip registering. |
| `TENKI_MCP_AUDIT` | off | `1` logs each tool call name + arg keys to stderr. |
| `TENKI_MCP_TRANSPORT` | `stdio` | `http` serves Streamable HTTP instead (see below). |
| `PORT` | `3000` | HTTP transport port. |
| `TENKI_MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind host; non-loopback requires `TENKI_MCP_HTTP_TOKEN`. |
| `TENKI_MCP_HTTP_TOKEN` | — | Bearer token for the HTTP endpoint; optional on loopback, required on a non-loopback host. |

## Tools

**75 tools** — all 72 public unary API methods (enforced by a CI [parity audit](scripts/parity-audit.mjs)), two workflow helpers, and `tenki_auth_status`. Implementation-only control-plane methods are intentionally excluded. Grouped by domain:

| Domain | Tools |
|---|---|
| **Auth** | `tenki_auth_status` (which credential is configured, and does it work — the only tool available when none is) |
| **Identity** | `tenki_whoami` |
| **Run** | `tenki_run_code` (one-shot: boot → run shell/python/js → tear down) |
| **Sandboxes** | `tenki_create_sandbox` · `tenki_get_sandbox` · `tenki_list_sandboxes` · `tenki_terminate_sandbox` · `tenki_pause_sandbox` · `tenki_resume_sandbox` |
| **Session admin** | `tenki_extend_sandbox` · `tenki_update_sandbox` · `tenki_terminate_sandboxes` (bulk) · `tenki_report_sandbox_activity` · `tenki_list_workspace_sandboxes` · `tenki_list_project_sandboxes` |
| **Exec** | `tenki_exec` (stdout/stderr/exit inline) |
| **Files** | `tenki_read_file` · `tenki_write_file` · `tenki_list_files` · `tenki_stat_path` · `tenki_make_dir` · `tenki_remove_path` · `tenki_move_path` |
| **Git** | `tenki_git` (clone/checkout/diff/log — the API supports exactly these four; run other git commands via `tenki_exec`) |
| **Ports & previews** | expose · list-exposed · unexpose · create-preview-url · open-preview · list/get/delete-preview-url · touch-preview · bind/unbind-preview-url · resolve-preview-token |
| **Artifacts** (binary transfer) | `tenki_get_upload_url` · `tenki_get_download_url` (signed URLs for binary PUT/GET) |
| **SSH** | `tenki_update_ssh_keys` · `tenki_issue_ssh_cert` · `tenki_list_ssh_gateways` |
| **Snapshots** | create · get · list · list-session · list-project · list-workspace · list-dangling · update · delete · get-download-url |
| **Volumes** | create · get · list · list-project · update · delete · resize · attach · detach |
| **Templates** | create · get · list · list-project · update · delete · build · cancel-build · get-build · list-active-builds |
| **Workspace** | `tenki_get_workspace_usage` · `tenki_get_workspace_settings` · `tenki_update_workspace_settings` · `tenki_get_snapshot_retention_settings` · `tenki_update_snapshot_retention_settings` |

Full per-release breakdown in [CHANGELOG.md](CHANGELOG.md).

## Auth

Set one of `TENKI_API_KEY` or `TENKI_AUTH_TOKEN` — when both are set, `TENKI_AUTH_TOKEN` wins. The header is chosen by token prefix: `tk_…` → `Authorization: Bearer`, `ory_st_…` → `X-Session-Token`, otherwise a session cookie. Override the endpoint with `TENKI_API_ENDPOINT` (default `https://api.tenki.cloud`).

**Without a credential the server still starts**, registering only `tenki_auth_status` — so instead of an MCP client reporting an opaque "server failed to start", the agent can call that tool and get told what to set. Ask it "check tenki auth status" any time other tools return auth errors: it reports the credential kind (API key vs session token), the endpoint, and whether a live identity probe succeeded — never the token itself. It reports status only; get a credential with `tenki login` or from the dashboard.

## Host it over HTTP (v2.0-beta)

Besides stdio, the server speaks **Streamable HTTP** so it can be hosted for remote MCP clients:

```bash
TENKI_MCP_TRANSPORT=http PORT=3000 TENKI_API_KEY=… npx -y @tenkicloud/mcp
# → tenki-mcp running on http://127.0.0.1:3000/mcp (Streamable HTTP) [loopback only, no auth]
```

**Security — this endpoint is a capability.** In HTTP mode the process holds one shared `TENKI_API_KEY` and exposes every tool, including arbitrary code execution and credit spend. So by default it:

- **binds to loopback (`127.0.0.1`) only** — set `TENKI_MCP_HTTP_HOST=0.0.0.0` to expose it, but then
- it **requires a bearer token**: set `TENKI_MCP_HTTP_TOKEN` and send `Authorization: Bearer <token>`. It **refuses to start** on a non-loopback host without one.
- **DNS-rebinding protection** is on (Host-header allowlist), so a malicious web page can't drive your local server.

```bash
# expose to a network safely:
TENKI_MCP_TRANSPORT=http TENKI_MCP_HTTP_HOST=0.0.0.0 PORT=3000 \
  TENKI_MCP_HTTP_TOKEN=$(openssl rand -hex 32) TENKI_API_KEY=… npx -y @tenkicloud/mcp
```

Point an HTTP-capable MCP client at `/mcp`. v2.0-beta uses one shared `TENKI_API_KEY` for all sessions; per-request auth (multi-tenant hosting) is not yet implemented. Verified end-to-end (`test/http-transport.test.mjs`: auth gate, DNS-rebinding rejection, connect → tools/list → tool call over HTTP).

## How it works

Tenki's API is **ConnectRPC** — JSON over HTTP/1.1, not REST. Every control-plane call is `POST https://api.tenki.cloud/tenki.sandbox.v1.SandboxService/{Method}` with a lowerCamelCase JSON body. Per-session file I/O runs on a **separate data-plane endpoint** returned at create time, authenticated with a short-lived session certificate. This server owns both transports so the tools stay one-liners.

Command output: `tenki_exec` and `tenki_run_code` capture `stdout`/`stderr` by redirecting to files (`sh -c '… > out 2> err'`) and reading them back over the data plane, so you get the output inline through a plain HTTP client.

The wire details are ported from the live-verified [n8n community node](https://github.com/opencolin/n8n-nodes-tenki).

## Security

This server holds a Tenki API key and can run code + spend credits, so treat it as a capability. Full model + [CSA MCP Server Top-10](https://modelcontextprotocol-security.io/top10/server/) mapping in **[SECURITY.md](SECURITY.md)**. Quick controls:

- **Least privilege:** every tool carries MCP annotations (`readOnlyHint` / `destructiveHint`). Run `TENKI_MCP_READONLY=1` for an inspection-only server (read tools only), or `TENKI_MCP_DISABLED_TOOLS=tenki_run_code,…` to drop specific tools.
- **HTTP transport** is loopback-only by default and requires a bearer token to expose to a network (see [Host it over HTTP](#host-it-over-http-v20-beta)).
- **Audit:** `TENKI_MCP_AUDIT=1` logs each tool call's name to stderr.
- **Untrusted output:** `tenki_run_code`/`tenki_exec`/`tenki_read_file` return output from untrusted code — clients should treat tool results as data, not instructions.

Report vulnerabilities via a private [security advisory](https://github.com/LuxorLabs/tenki-mcp/security/advisories/new), not a public issue.

## Related

- **Tenki Sandbox** — the platform: https://tenki.cloud
- **n8n-nodes-tenki** — Tenki as an n8n node: https://github.com/opencolin/n8n-nodes-tenki

## License

MIT
