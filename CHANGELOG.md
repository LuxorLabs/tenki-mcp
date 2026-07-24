# Changelog

All notable changes to tenki-mcp. This project follows semantic versioning.

## [Unreleased] — Registry/preview/artifact request-shape fixes

An API-contract review live-probed the write paths and found **11 more request-shape bugs** beyond the two already fixed — the registry module was almost entirely non-functional (it sent `reference` where the API wants `ref` / `imageId` / `imageRef`, failing 100%% of the time). All fixed and live-verified (each now reaches a clean not-found instead of a validation error); regression-guarded by test/registry-shapes.test.mjs.

- **registry** (9): `get_image`, `resolve_image_ref` (needs `ref`+`workspaceId`), `set_image_visibility` (needs `ref`+`REGISTRY_VISIBILITY_*` enum), `delete_image` (whole=`ref`; version=`imageId`+`snapshotId`), `share_image` (`imageRef`+`targetWorkspaceId`), `unshare_image` (`ref`), `revoke_image_share_grant` (`grantId`), `publish_image` (needs `ref`+`kind`+`snapshotId`/`sourceTemplateId`, not a session).
- **previews** (1): `touch_preview` takes a `previewToken`, not session/port.
- **artifacts** (1): `get_download_url` supports download-by-artifact-id only (the API rejects a path); the non-functional `path` option was removed.

Known-unverified (flagged for follow-up): `update_workspace_settings` / `update_snapshot_retention_settings` field names cannot be black-box verified (the server silently accepts unknown fields) — need checking against the SDK descriptor.

## [2.0.0-alpha.0] — 2026-07-21 — HTTP transport (v2 begins)

The server now speaks **Streamable HTTP** in addition to stdio, so it can be hosted for remote MCP clients (`TENKI_MCP_TRANSPORT=http PORT=3000`). Verified end-to-end (connect → tools/list → tool call over HTTP; stdio unchanged, 84 tools). Server construction refactored into a shared `createServer()` factory (src/server.ts) used by both transports.

**Gating experiment done:** Tenki's gateway accepts Connect *streaming* over HTTP/1.1 (application/connect+json → 200), so v2 streaming exec is feasible with plain fetch + envelope framing — no heavy dependency. Streaming exec (StreamCommandOutput) is designed + unblocked but not yet built; per-request HTTP auth is deferred. See docs/plans/V2-STATE.md. Alpha: not for production hosting yet.

## [1.0.2] — 2026-07-21 — Fixes from comprehensive testing

A PM-council test matrix (34 scenarios) executed via a worktree fan-out against live Tenki found **two real request-shape bugs**, both fixed and verified end-to-end:

- **tenki_attach_volume** sent a flat request; AttachVolumeRequest nests the target under a `volume` sub-message (`{sessionId, volume:{volumeId, mountPath, readOnly?}}`). Every attach was rejected — this broke the volume warm-cache workflow. Fixed.
- **tenki_list_image_share_grants** sent `reference`; the API field is `ref` (required). It was silently ignored, 400-ing every call and making the ACL-read surface unreachable. Fixed.

Also: a real MCP **test suite** (`test/`) — a cleanup-safe harness driving the actual MCP protocol + 5 suites (coverage, client-integration, errors-edge, journeys, admin-previews) — **68 checks, all green**. Doc fixes (workspace tool names; create_template setup_script). See docs/plans/TEST-REPORT.md. No tool count change (84).

## [1.0.1] — 2026-07-20 — Fix ResizeVolume field

Live-verifying the volume write path (once a workspace volume-quota block was cleared) surfaced one real bug: `tenki_resize_volume` sent `sizeBytes` but the API expects `newSizeBytes`, so resizes were rejected. Fixed. Full volume lifecycle (create → get → update → resize → delete) now live-verified end-to-end.

## [1.0.0] — 2026-07-20 — Full CLI parity

**84 tools — parity with the entire Tenki unary API**, enforced by a CI parity audit (scripts/parity-audit.mjs fails the build if any SandboxService / DataPlane / SSHGateway method lacks a tool; streaming methods are deferred to v2.0). This release closes the long tail on top of v0.7: binary artifact transfer (get_upload_url / get_download_url), SSH access (update_ssh_keys / issue_ssh_cert / list_ssh_gateways), the preview-URL primitives (get/delete/touch/bind/unbind/resolve), project-scoped list variants (volumes/snapshots/templates), snapshot-retention settings, and registry grant-revoke. New read paths live-verified against api.tenki.cloud; write/advanced additions are grounded in the decompiled SDK map and labeled where not exercised end-to-end.

**Tools:** +18 to reach 84 (artifacts x2, ssh x3, preview extras x6, list variants x4, retention x2, revoke-grant x1)

## [0.7.0] — 2026-07-20 — Workspace administration

Workspace-level administration: sandbox usage reporting and get/update of workspace sandbox settings. Live-verified. (SSH access + snapshot-retention settings are tracked for a follow-up — see docs/plans/STATE.md.)

**Tools:** tenki_get_workspace_usage, tenki_get_workspace_sandbox_settings, tenki_update_workspace_sandbox_settings

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

<!-- Upcoming releases are grouped per docs/plans/ROADMAP.md. -->
