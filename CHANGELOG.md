# Changelog

All notable changes to `@tenkicloud/mcp`. This project follows semantic versioning.

## [0.1.0] — 2026-08-03 — Initial release

Model Context Protocol server for Tenki Cloud — disposable microVM sandboxes for AI agents. Published as **`@tenkicloud/mcp`**, matching the `@tenkicloud/sandbox` SDK. Install with `npx -y @tenkicloud/mcp`; the command it provides is `tenki-mcp`.

### Tools

- **85 tools covering the full Tenki unary API**, enforced by a CI parity audit (`scripts/parity-audit.mjs` fails the build if any SandboxService / DataPlane / SSHGateway method lacks a tool): sandbox lifecycle, code execution (`tenki_exec`, `tenki_run_code`), files, git, ports and preview URLs, snapshots, volumes, templates, registry, SSH, artifacts, and workspace administration.
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
