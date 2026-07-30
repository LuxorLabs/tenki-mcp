# Changelog

All notable changes to tenki-mcp. This project follows semantic versioning.

## [Unreleased]

### Network-layer hardening (timeouts, retry policy, credential cache)

- **Every fetch now carries a timeout** — a hung control- or data-plane connection fails the tool call with a clear `timed out after Nms` error instead of blocking it forever. Unary calls default to 30s; `ExecuteCommand` follows the command's own timeout + 30s margin (630s when the command has none). Tunable via `TenkiClient` options.
- **`unavailable` is no longer retried on non-idempotent methods.** A half-applied `CreateSession` retried on `unavailable` could boot and bill a second sandbox; now only idempotent (read-shaped) methods retry it. Rate-limit rejections still retry for every method, with jittered backoff and `Retry-After` honored (capped at 30s).
- **Session-credential cache can no longer go permanently stale.** A credential whose expiry the API omits (or that fails to parse) was previously cached *forever* — once the cert actually expired, every file operation for that session failed for the life of the process. Now: missing expiry → 60s TTL; known expiry → refreshed 30s early; and an auth failure on a data-plane call invalidates the cached credential and retries once with a fresh one (never loops).
- New offline regression suite `test/client-net.test.mjs` (local `node:http` stub, zero external network) covering all of the above; wired into `npm test` and CI.

### Structured tool output (first tool: `tenki_exec`)

- **`tenki_exec` now declares an `outputSchema` and returns `structuredContent`** alongside a plain-text rendering, so MCP clients can consume `stdout`/`stderr`/`exitCode`/`ok` as typed JSON instead of re-parsing a stringified blob. The text block carries the full output (headed by `exit <code>` and byte-count markers) for clients that don't support structured content. The SDK validates every successful result against the schema. Terminal control characters in the text rendering are escaped to visible `\xNN` (sandbox output is untrusted; the previous JSON.stringify rendering escaped them implicitly) — `structuredContent` keeps the raw strings.
- **Registration guard extended to `registerTool`** — the modern SDK registration API (required for `outputSchema`) now passes through the same least-privilege guard as the legacy `.tool()` form: name-derived annotations, `TENKI_MCP_READONLY`, `TENKI_MCP_DISABLED_TOOLS`, and `TENKI_MCP_AUDIT` all apply. Previously a module using `registerTool` would have silently bypassed all four.
- **Behavior change:** `tenki_exec` / `tenki_run_code` results now report `ok: false` when the command ran but its output could not be read back (`captureError` set). Previously a capture failure with exit code 0 reported `ok: true` with empty stdout/stderr, which read as a clean silent success.
- Offline regression checks: `tenki_exec` advertises the schema, still carries guard annotations via the `registerTool` path, and exactly one tool declares an `outputSchema` (bump the count when migrating more tools).

### Fixed

- **Sandbox creation was broken for workspace-scoped API keys.** `resolveOwner` forwarded WhoAmI's `ownerType` verbatim into `CreateSession`, but the API validates `owner_type ∈ {SERVICE, USER}` and now returns `WORKSPACE` for workspace-scoped keys → every `tenki_create_sandbox`/`tenki_run_code` failed with `400 invalid_argument`. Fix: send the same placeholder the first-party SDKs hardcode (`"SERVICE"`/`"self"`) when WhoAmI returns a type CreateSession rejects — the server derives the real owner from the authenticated identity regardless. Verified live: create → exec (structured) → terminate, 12/12 checks.
- `test/http-transport.test.mjs` no longer asserts `ownerType === "USER"` (stale against the same API change); it accepts any authenticated owner type.

## [2.0.0-alpha.2] — 2026-07-27 — MCP security hardening + registry fixes

### MCP security hardening (least privilege + annotations)

Applies MCP-native security controls, mapped to the CSA MCP Server Top-10 (esp. MCP-07 excessive permissions). See SECURITY.md.

- **Tool annotations** on all 84 tools (`readOnlyHint` on 36 read tools, `destructiveHint` on the 13 delete/terminate/revoke tools, `openWorldHint` on all) so clients can surface/gate dangerous tools.
- **Least-privilege env controls:** `TENKI_MCP_READONLY=1` registers only read tools (no create/run/delete/spend); `TENKI_MCP_DISABLED_TOOLS=a,b` drops named tools. Applied centrally via a registration guard — no change to the tool modules.
- **Audit logging:** `TENKI_MCP_AUDIT=1` logs each tool call name + arg keys (never values/content/token) to stderr.
- **SECURITY.md** — threat model, trust boundaries (the key + endpoint are capabilities; sandbox output is untrusted), and a full CSA Top-10 mapping. README security section + disclosure policy.
- Regression test `test/security.test.mjs` (10 offline checks).

### Registry/preview/artifact request-shape fixes

An API-contract review of the write paths found **11 more request-shape bugs** beyond the two already fixed — the registry module was almost entirely non-functional (it sent `reference` where the API wants `ref` / `imageId` / `imageRef`). All fixed and verified (each now reaches a clean not-found instead of a validation error); regression-guarded by test/registry-shapes.test.mjs.

- **registry** (9): `get_image`, `resolve_image_ref` (needs `ref`+`workspaceId`), `set_image_visibility` (needs `ref`+`REGISTRY_VISIBILITY_*` enum), `delete_image` (whole=`ref`; version=`imageId`+`snapshotId`), `share_image` (`imageRef`+`targetWorkspaceId`), `unshare_image` (`ref`), `revoke_image_share_grant` (`grantId`), `publish_image` (needs `ref`+`kind`+`snapshotId`/`sourceTemplateId`, not a session).
- **previews** (1): `touch_preview` takes a `previewToken`, not session/port.
- **artifacts** (1): `get_download_url` supports download-by-artifact-id only (the API rejects a path); the non-functional `path` option was removed.

## [2.0.0-alpha.1] — 2026-07-21 — Harden the HTTP transport (security)

An independent security review of the v2.0.0-alpha.0 HTTP transport found three coupled HIGH issues (the endpoint holds a shared TENKI_API_KEY and exposes code-execution + credit-spend tools). All fixed:

- **Loopback-only by default** — binds `127.0.0.1`, not `0.0.0.0`; the banner now shows the real host. Expose with `TENKI_MCP_HTTP_HOST`.
- **Bearer auth** — set `TENKI_MCP_HTTP_TOKEN` (constant-time checked); the server **refuses to bind to a non-loopback host without it**.
- **DNS-rebinding protection ON** — Host-header allowlist, so a malicious web page cannot drive the local server (verified: forged Host → 403).

Also: session count cap + idle reaping (init-flood DoS), a 1 MiB request-body cap enforced on both the Content-Length header and the streamed byte count (memory DoS), malformed JSON → JSON-RPC `-32700`/400, no internals in error responses, and SIGTERM/SIGINT graceful shutdown. Offline regression `test/http-input.test.mjs` asserts the 413 + a clean init; `test/http-transport.test.mjs` asserts the auth gate + rebinding rejection (7/7). stdio + tool parity unchanged (84).

## [2.0.0-alpha.0] — 2026-07-21 — HTTP transport (v2 begins)

The server now speaks **Streamable HTTP** in addition to stdio, so it can be hosted for remote MCP clients (`TENKI_MCP_TRANSPORT=http PORT=3000`). Verified end-to-end (connect → tools/list → tool call over HTTP; stdio unchanged, 84 tools). Server construction refactored into a shared `createServer()` factory (src/server.ts) used by both transports.

Streaming exec (`StreamCommandOutput`) and per-request HTTP auth are not yet implemented. Alpha: not for production hosting yet.

## [1.0.2] — 2026-07-21 — Fixes from comprehensive testing

A 34-scenario test matrix run against live Tenki found **two real request-shape bugs**, both fixed and verified end-to-end:

- **tenki_attach_volume** sent a flat request; AttachVolumeRequest nests the target under a `volume` sub-message (`{sessionId, volume:{volumeId, mountPath, readOnly?}}`). Every attach was rejected — this broke the volume warm-cache workflow. Fixed.
- **tenki_list_image_share_grants** sent `reference`; the API field is `ref` (required). It was silently ignored, 400-ing every call and making the ACL-read surface unreachable. Fixed.

Also: a real MCP **test suite** (`test/`) — a cleanup-safe harness driving the actual MCP protocol + 5 suites (coverage, client-integration, errors-edge, journeys, admin-previews) — **68 checks, all green**. Doc fixes (workspace tool names; create_template setup_script). No tool count change (84).

## [1.0.1] — 2026-07-20 — Fix ResizeVolume field

Live-verifying the volume write path (once a workspace volume-quota block was cleared) surfaced one real bug: `tenki_resize_volume` sent `sizeBytes` but the API expects `newSizeBytes`, so resizes were rejected. Fixed. Full volume lifecycle (create → get → update → resize → delete) now live-verified end-to-end.

## [1.0.0] — 2026-07-20 — Full CLI parity

**84 tools — parity with the entire Tenki unary API**, enforced by a CI parity audit (scripts/parity-audit.mjs fails the build if any SandboxService / DataPlane / SSHGateway method lacks a tool; streaming methods are deferred to v2.0). This release closes the long tail on top of v0.7: binary artifact transfer (get_upload_url / get_download_url), SSH access (update_ssh_keys / issue_ssh_cert / list_ssh_gateways), the preview-URL primitives (get/delete/touch/bind/unbind/resolve), project-scoped list variants (volumes/snapshots/templates), snapshot-retention settings, and registry grant-revoke. New read paths live-verified against api.tenki.cloud; write/advanced additions are grounded in the published API surface and labeled where not exercised end-to-end.

**Tools:** +18 to reach 84 (artifacts x2, ssh x3, preview extras x6, list variants x4, retention x2, revoke-grant x1)

## [0.7.0] — 2026-07-20 — Workspace administration

Workspace-level administration: sandbox usage reporting and get/update of workspace sandbox settings. Live-verified.

**Tools:** tenki_get_workspace_usage, tenki_get_workspace_settings, tenki_update_workspace_settings

## [0.6.0] — 2026-07-20 — Custom runtimes — templates & registry

Bring-your-own-runtime: define an environment once and boot into it warm. Templates add the platform's first async job surface (build, poll, cancel). The registry publishes versioned custom images with a private-by-default ACL surface. List paths live-verified.

**Tools:** 9 template tools (create/get/list/update/delete + build/cancel-build/get-build/list-active-builds) + 9 registry tools (publish/get/list/set-visibility/delete/delete-version/resolve-ref/share/list-share-grants)

## [0.5.0] — 2026-07-20 — Persistent state — snapshots & volumes

Persistent state for the iterative agent loop. Snapshots checkpoint a known-good sandbox to branch or roll back from; volumes are durable disks that carry a cache or dataset across otherwise-ephemeral sandboxes. Destructive verbs are explicit-target-only. Snapshots live-verified; volume shapes verified against the SDK (write path blocked only by a workspace volume quota during testing).

**Tools:** 8 snapshot tools + 8 volume tools (create/get/list/update/delete/resize/attach/detach)

## [0.4.0] — 2026-07-20 — Preview URLs — the ship surface

The ship surface: turn an exposed port into a public, shareable preview URL an agent can hand back. Project-scoped (live-verified: requires projectId + a validated slug). Completes the ports resource with unexpose.

**Tools:** tenki_create_preview_url, tenki_open_preview, tenki_list_preview_urls, tenki_unexpose_port

## [0.3.0] — 2026-07-20 — Session lifecycle & fleet control

Extended session control: extend a sandbox's wall-clock lifetime, update mutable fields (name/tags/idle-timeout/max-duration), bulk-terminate (explicit-id-only, irreversible), an activity heartbeat, and workspace/project-scoped fleet listing. Live-verified.

**Tools:** tenki_extend_sandbox, tenki_update_sandbox, tenki_terminate_sandboxes, tenki_report_sandbox_activity, tenki_list_workspace_sandboxes, tenki_list_project_sandboxes

## [0.2.0] — 2026-07-20 — Filesystem completion (data plane)

Data-plane filesystem metadata + mutation, completing the file surface beyond read/write/list: stat, mkdir (recursive), remove (recursive), and move (exec-backed mv, since the data plane exposes no Move RPC). Live-verified against api.tenki.cloud.

**Tools:** tenki_stat_path, tenki_make_dir, tenki_remove_path, tenki_move_path

## [0.1.0] — 2026-07-20
Initial release. **15 MCP tools over stdio, live-verified against `api.tenki.cloud`.**

- `tenki_whoami`
- `tenki_run_code` — ephemeral sandbox: boot → run shell/python/javascript → terminate
- Sandbox lifecycle: `tenki_create_sandbox`, `tenki_get_sandbox`, `tenki_list_sandboxes`, `tenki_terminate_sandbox`, `tenki_pause_sandbox`, `tenki_resume_sandbox`
- `tenki_exec` — run a command in a sandbox (stdout/stderr/exit inline)
- Files: `tenki_read_file`, `tenki_write_file`, `tenki_list_files`
- `tenki_git`
- Ports: `tenki_expose_port`, `tenki_list_exposed_ports`

Dependency-free ConnectRPC client (control + data plane), ported from the live-verified [n8n node](https://github.com/opencolin/n8n-nodes-tenki). Tools organized into self-registering modules under `src/tools/`.
