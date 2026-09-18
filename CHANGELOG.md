# Changelog

All notable changes to `@tenkicloud/mcp`. This project follows semantic versioning.

## [Unreleased]

- Remove `tenki_get_workspace_settings`, `tenki_update_workspace_settings`, `tenki_get_snapshot_retention_settings` and `tenki_update_snapshot_retention_settings`: their API methods were removed upstream and every call returned 404. Plan limits are visible through `tenki_get_workspace_usage`.
- Add `tenki_get_sandbox_metrics` (CPU/memory averages over a window) and `tenki_get_workspace_preview_domains` / `tenki_update_workspace_preview_domains` (wildcard preview domains).
- Fix `tenki_attach_volume` `read_only`, which the API silently ignored (wrong wire field name); the mount was always read-write.
- Fix `tenki_update_sandbox`: `max_duration_seconds` always failed (the API requires an explicit sticky value — sticky=false is now sent for you); `tags: []` now clears tags; new `sticky` and `clear_tags` arguments; `idle_timeout_minutes` removed because the API cannot change it after creation.
- Fix `tenki_list_ssh_gateways`: `workspace_id` did nothing; the tool now takes `region` and/or `session_id`.
- `tenki_get_download_url` no longer requires `session_id` (the API ignores it).
- `tenki_list_preview_urls` filters by `session_id` on the server instead of on the fetched page.
- `tenki_create_sandbox`: explicit `allow_inbound: false` / `allow_outbound: false` are sent; new `sticky`, `volumes`, `ssh_authorized_keys`, `metadata`, `egress_allow_domains` / `egress_allow_cidrs`, `template_spec_id`, `setup_env`, `setup_secrets`, `secret_overrides`; the server-side ready wait is used; API `warnings` are returned; `memory_mb` must be even and `disk_size_gb` 5-100.
- New optional arguments: `async` on `tenki_pause_sandbox` and `tenki_create_snapshot`; `tags` / `clear_tags` on `tenki_update_snapshot` and `tenki_update_volume`, plus `clear_expires_at` on snapshots; `force` on `tenki_detach_volume`; `mode` on `tenki_make_dir`; `expires_at` on `tenki_expose_port` and `tenki_bind_preview_url`; `slug` lookup on `tenki_get_preview_url`; `requested_ttl_seconds` / `source_addresses` on `tenki_issue_ssh_cert`; `tags` / `sticky` filters on the sandbox lists.
- Tool descriptions now flag the API-deprecated methods behind `tenki_expose_port`, `tenki_unexpose_port`, `tenki_list_exposed_ports`, `tenki_list_workspace_sandboxes` and `tenki_list_workspace_snapshots`, and point to the replacements.

## [0.2.0] — 2026-08-21

- Remove standalone image management tools. Template images remain available through template builds and sandbox creation.
- Use `image` when creating a sandbox from a template image; removed image-reference arguments are now rejected.
- Cap `tenki_exec` / `tenki_run_code` inline output at 64 KB per stream (override with `max_output_bytes` on `tenki_exec`). Larger output returns a head+tail preview with `stdoutTruncated`/`stderrTruncated` set, and the full capture file is kept in the sandbox at the reported `stdoutPath`/`stderrPath`.
- Remove the project-scoped surface — the `tenki_list_project_sandboxes`/`_templates`/`_volumes`/`_snapshots` tools (their API methods no longer exist) and the `project_id` arguments (ignored by the API). Use the workspace-scoped equivalents.
- Document the template-image path end to end: `image_name` builds require a typed template (`builder_spec`), and `tenki_create_sandbox`'s `image` takes the ready build's `imageDigestRef`.

## [0.1.0] — 2026-08-03 — Initial release

Model Context Protocol server for Tenki Cloud — disposable microVM sandboxes for AI agents. Published as **`@tenkicloud/mcp`**, matching the `@tenkicloud/sandbox` SDK. Install with `npx -y @tenkicloud/mcp`; the command it provides is `tenki-mcp`.

### Tools

- **85 tools covering the full Tenki unary API**, enforced by a CI parity audit (`scripts/parity-audit.mjs` fails the build if any SandboxService / DataPlane / SSHGateway method lacks a tool): sandbox lifecycle, code execution (`tenki_exec`, `tenki_run_code`), files, git, ports and preview URLs, snapshots, volumes, templates, SSH, artifacts, and workspace administration.
- **`tenki_git`** validates `operation` as an enum of what the API actually supports (`clone`, `checkout`, `diff`, `log`) with per-operation arg keys documented; other git commands go through `tenki_exec`.
- **`tenki_exec` returns structured output**: it declares an `outputSchema` and returns `structuredContent` (`stdout`/`stderr`/`exitCode`/`ok`) alongside a human-readable rendering in which control characters, bidi overrides, and zero-width marks are escaped to visible `\xNN`/`\uNNNN` — sandbox output is untrusted.
- **`tenki_auth_status`** reports whether a usable credential is configured, which kind (`api_key`, `oauth_session_token`, or `session_cookie`), which env var it came from, the endpoint targeted, and whether a live identity probe succeeded — without ever returning the token. The server boots without a credential with this as the only registered tool, so a misconfigured client can ask what is wrong instead of seeing an opaque "server failed to start".
- Shared, described input schemas across modules: session ids (trimmed, non-empty), ports (1–65535), preview slugs (matching the server's own validation), and file paths (blank rejected client-side, otherwise sent verbatim — no silent trimming of legal POSIX filenames).

### Transports

- **stdio** (default) and **Streamable HTTP** (`TENKI_MCP_TRANSPORT=http PORT=3000`), built from a shared `createServer()` factory.
- The HTTP transport is hardened: loopback-only by default (`TENKI_MCP_HTTP_HOST` to expose), bearer auth via `TENKI_MCP_HTTP_TOKEN` (constant-time checked; required to bind a non-loopback host), DNS-rebinding protection via a Host-header allowlist, a 1 MiB request-body cap enforced on both the header and the streamed byte count, session count cap with idle reaping, and SIGTERM/SIGINT graceful shutdown.

### Security posture

- **Tool annotations on every tool** (`readOnlyHint`, `destructiveHint`, `openWorldHint`) so clients can surface or gate dangerous tools.
- **Least-privilege env controls:** `TENKI_MCP_READONLY=1` registers only read tools (plus `tenki_auth_status`); `TENKI_MCP_DISABLED_TOOLS=a,b` drops named tools; `TENKI_MCP_AUDIT=1` logs each tool call's name and arg keys — never values, content, or tokens — to stderr. Applied centrally via a registration guard covering both SDK registration APIs.
- **SECURITY.md** documents the threat model, trust boundaries (the key and endpoint are capabilities; sandbox output is untrusted), and a CSA MCP Server Top-10 mapping.
- Importing the package cannot execute the server or exit the host process: the package is bin-only.

### Network layer

- **Every request carries a timeout** with one shared deadline per call (retries and backoff draw from it): 30s for unary calls (`TENKI_MCP_TIMEOUT_MS`), 600s for RPCs that block on storage work — snapshot creation and pause (`TENKI_MCP_SLOW_TIMEOUT_MS`) — and command execution follows the command's own timeout plus a 30s margin.
- **Retry policy shaped by double-apply risk:** methods that must never run twice (creates, builds, publishes, resumes, extends, exec) never retry transient failures; reads and idempotent teardown retry `unavailable`, gateway-shaped 502/503/504, and transport-level failures, with rate limits retried for every method under jittered backoff honoring `Retry-After`. Read-shaped data-plane methods retry under the same rules.
- **Session-credential cache** with expiry-aware refresh, single-flight minting, and invalidate-and-retry-once on a stale certificate (`permission_denied` deliberately does not re-mint).

### Client

- Dependency-free ConnectRPC client for the control and data planes; runtime dependencies are only `@modelcontextprotocol/sdk` and `zod`. Node ≥ 22.
- Offline regression suites (security, transport input handling, exec output, network behavior — local stubs, zero external network) run in CI via `npm test`; live end-to-end suites in `test/run.mjs`.
