# tenki-mcp v2.0 — forward plan & state (pick up here)

_Resumable state for the v2.0 work (streaming + HTTP transport). Design rationale: `docs/plans/v2-streaming.md`._

## ✅ Gating experiment — DONE (2026-07-21), and it's the good outcome
**Question:** does Tenki's gateway accept Connect *streaming* over HTTP/1.1 (usable from `fetch`) or only gRPC/HTTP2 (needs a bundled `@connectrpc/connect-node`)?

**Answer — it accepts Connect streaming over HTTP/1.1.** Probing `SandboxService/StreamCommandOutput` with a real running session:
- `Content-Type: application/json` (unary) → **HTTP 415** (rejected — it's a streaming method)
- `Content-Type: application/connect+json` (streaming) → **HTTP 200**, response `application/connect+json`, body `{"error":{"code":"invalid_argument","message":"protocol error: promised 577987955 bytes in enveloped message, got 47 bytes"}}` — i.e. the gateway spoke Connect-streaming back and only complained my body wasn't **envelope-framed**.
- `application/grpc-web+json` → HTTP 200 too.

**Implication:** implement streaming with `fetch` + a **Connect length-prefixed envelope** codec — NO new heavy dependency. Envelope = `[flags:1 byte][length:4 bytes big-endian][message bytes]`; the final response frame sets flag bit `0x02` (EndStream) carrying trailers/error as JSON.

## v2 workstreams (independent — ship in either order)

### A. HTTP/SSE server transport — IN PROGRESS
Make the server hostable (remote clients, not just local stdio) via the MCP SDK's `StreamableHTTPServerTransport`, selected by `TENKI_MCP_TRANSPORT=http` + `PORT`. Independent of Tenki streaming. Single shared env token for v2.0.0-alpha (per-request auth = a later, decision-gated step). **Ship as v2.0.0-alpha, tested with the SDK's `StreamableHTTPClientTransport` (tools/list + a tool call over HTTP).**

### B. Streaming exec (`tenki_stream_exec`) — DESIGNED, feasibility PROVEN, not built
Now unblocked by the gating result. Add a Connect-streaming path to the client (envelope reader/writer over `fetch`'s `ReadableStream` body) for server-streaming methods: `StreamCommandOutput` first (live stdout/stderr), then `ReadFileStream`. Once `StreamCommandOutput` works, `exec`/`run_code` can drop the `sh -c` redirect capture hack.
- **Bidi** (`Run`/`Dial`/`HostPortTunnel`, interactive shells) stays deferred — full duplex over `fetch` is limited; needs `connect-node` or a WebSocket bridge. Scope after server-streaming lands.

## Tick log (30s cadence)
- **T1** — ran the gating experiment → Connect-streaming over HTTP/1.1 is accepted (fetch + envelope framing viable). No heavy dep needed.
- **T2** — writing this forward-plan; next: refactor `index.ts` to a shared `createServer(client)` + add the HTTP transport mode.
- **T3** — refactored to `src/server.ts` `createServer()`; added `src/http.ts` (StreamableHTTPServerTransport, stateful per-session) + `TENKI_MCP_TRANSPORT` switch in index.ts.
- **T4** — built; stdio regression-checked (84 tools); HTTP transport test green (5/5: start → connect → tools/list(84) → whoami → close). Cut **v2.0.0-alpha.0**. Next (new session): build streaming exec (`StreamCommandOutput` via fetch envelope codec) — feasibility proven in T1; then per-request HTTP auth; then bidi/interactive.

- **T5** — independent security review of the HTTP transport → hardened (loopback default, bearer auth, DNS-rebinding protection, DoS caps, graceful shutdown). Test asserts the gates (7/7). Cut 2.0.0-alpha.1 (PR).
