# Security

`tenki-mcp` gives an AI agent a capability: a disposable microVM it can create, run code in, and spend Tenki credits with. Treat the server — and the API key it holds — accordingly. This document is the threat model and the controls, mapped to the [CSA MCP Server Top 10](https://modelcontextprotocol-security.io/top10/server/).

## Reporting a vulnerability
Please **do not** open a public issue for security reports. Open a private [GitHub security advisory](https://github.com/LuxorLabs/tenki-mcp/security/advisories/new), or email the maintainers. We'll acknowledge within a few business days.

## Trust boundaries (read this first)
- **The API key is a capability.** In every mode the process authenticates to Tenki with one `TENKI_API_KEY` and can create sandboxes, run arbitrary code, and spend credits. Anyone who can invoke the server can do those things. Scope the key if your Tenki plan allows it; never commit it (`.env` is gitignored).
- **Sandbox output is untrusted.** `tenki_run_code` / `tenki_exec` / `tenki_read_file` return output produced by *untrusted, AI-generated code running in the sandbox*. That output flows back to the calling model as a tool result — a classic **indirect / output prompt-injection** vector. The microVM is the isolation boundary; the model should treat tool results as **data, not instructions**. (MCP clients are responsible for not executing instructions found in tool output.)
- **The HTTP endpoint is a capability.** In HTTP mode the `/mcp` endpoint is equivalent to handing out the key — protect it (below).

## Controls this server provides

### Least privilege (MCP-07 — the main lever)
Every tool is tagged with MCP **annotations** so clients can surface/gate danger:
`readOnlyHint` on inspection tools, `destructiveHint` on the 13 that delete/terminate/revoke, `openWorldHint` on all (they call an external API). Plus two env controls:

| Env | Effect |
|---|---|
| `TENKI_MCP_READONLY=1` | Register **only read-only tools** — no create, run, spend, or delete. For inspection-only deployments. |
| `TENKI_MCP_DISABLED_TOOLS=a,b,c` | Skip the named tools (e.g. disable `tenki_run_code` where code execution isn't wanted). |

Grant the smallest set that the use case needs.

### Transport security (MCP-05, MCP-10)
- **stdio** (default) has no network surface.
- **HTTP** (`TENKI_MCP_TRANSPORT=http`) binds **loopback-only** by default, **requires a bearer token** to bind to a non-loopback host, has **DNS-rebinding protection**, and caps sessions + body size. For network exposure put it behind a **TLS-terminating proxy**. (See `docs/plans/V2-STATE.md`; hardening details in the transport module.)

### Secrets & audit (MCP-04, Observability)
- The key is read from env and sent only as an auth header — never logged, never in error responses.
- `TENKI_MCP_AUDIT=1` logs each tool call's **name + argument keys** to stderr (never values, content, or the token) for an operator audit trail.

## CSA MCP Server Top-10 mapping

| # | Risk | tenki-mcp posture |
|---|---|---|
| MCP-01 | Prompt Injection | zod-validates every tool arg pre-network; **sandbox output is untrusted** (treat tool results as data) |
| MCP-02 | Confused Deputy | single shared key; HTTP endpoint requires its own bearer token; `READONLY`/denylist bound the blast radius; per-request auth is a roadmap item |
| MCP-03 | Tool Poisoning | tool descriptions are static and authored (no dynamic/remote descriptions); verify the package via its npm provenance + MCP-registry namespace ownership |
| MCP-04 | Credential/Token Exposure | key via env only; never logged/committed/echoed; audit logs keys not values |
| MCP-05 | Insecure Configuration | HTTP transport is loopback + token + DNS-rebinding-protected + DoS-capped by default |
| MCP-06 | Supply Chain | 2 runtime deps (`@modelcontextprotocol/sdk`, `zod`), lockfile committed; publish with npm provenance; pin/vet deps |
| MCP-07 | Excessive Permissions | tool annotations + `TENKI_MCP_READONLY` + `TENKI_MCP_DISABLED_TOOLS` |
| MCP-08 | Data Exfiltration | microVM isolation; sandbox **outbound networking is off unless `allow_outbound` is set**; the server itself stores/forwards nothing |
| MCP-09 | Context Spoofing | tool results are raw API/sandbox output surfaced as data, not merged into instructions |
| MCP-10 | Insecure Communication | control plane is HTTPS; run the HTTP transport behind TLS for any non-loopback use |

## Cost / resource notes
`tenki_run_code` is cost-guarded (1 vCPU, 1 GB, 10-min cap, 5-min idle) and self-terminates. `tenki_create_sandbox` and other create tools **spend real credits** — bound them with your **Tenki workspace limits**, `TENKI_MCP_READONLY`/denylist, and `TENKI_MCP_AUDIT` for visibility.
