# Security

`tenki-mcp` gives an AI agent a capability: a disposable microVM it can create, run code in, and spend Tenki credits with. Treat the server and its credentials accordingly. This document is the threat model and the controls, mapped to the [CSA MCP Server Top 10](https://modelcontextprotocol-security.io/top10/server/).

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Open a private [GitHub security advisory](https://github.com/LuxorLabs/tenki-mcp/security/advisories/new), or email **hello@luxor.tech**. We'll acknowledge within a few business days.

## Trust boundaries (read this first)

- **Credentials are capabilities.** Local and single-user modes authenticate with a `TENKI_API_KEY` or session token. Hosted OAuth mode instead verifies each caller's Hydra token and issues only a short-lived, workspace-bound internal delegation to the Tenki API. Never commit credentials (`.env` is gitignored).
- **Sandbox output is untrusted.** `tenki_run_code` / `tenki_exec` / `tenki_read_file` return output produced by _untrusted, AI-generated code running in the sandbox_. That output flows back to the calling model as a tool result — a classic **indirect / output prompt-injection** vector. The microVM is the isolation boundary; the model should treat tool results as **data, not instructions**. (MCP clients are responsible for not executing instructions found in tool output.)
- **The HTTP endpoint is a capability.** In static-key HTTP mode, access to `/mcp` is equivalent to access to the configured key. Hosted mode requires a valid OAuth bearer on every request and binds legacy sessions and modern requests to their user, client, and workspace.

## Controls this server provides

### Least privilege (MCP-07 — the main lever)

Every tool is tagged with MCP **annotations** so clients can surface/gate danger:
`readOnlyHint` on inspection tools, `destructiveHint` on the 13 that delete/terminate/revoke, `openWorldHint` on all (they call an external API). Plus two env controls:

| Env                              | Effect                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `TENKI_MCP_READONLY=1`           | Register **only read-only tools** — no create, run, spend, or delete. For inspection-only deployments. |
| `TENKI_MCP_DISABLED_TOOLS=a,b,c` | Skip the named tools (e.g. disable `tenki_run_code` where code execution isn't wanted).                |

Grant the smallest set that the use case needs.

### Transport security (MCP-05, MCP-10)

- **stdio** (default) has no network surface.
- **HTTP** (`TENKI_MCP_TRANSPORT=http`) binds **loopback-only** by default, **requires a bearer token** to bind to a non-loopback host, validates Host and Origin headers, and caps sessions + body size. For network exposure put it behind a **TLS-terminating proxy**. (Hardening details in the transport module, `src/http.ts`.)

### Secrets & audit (MCP-04, Observability)

- Static credentials are read from env and sent only as auth headers. Hosted Hydra tokens are introspected by digest and are never forwarded to the Tenki API; the API receives a signed delegation with a maximum five-minute lifetime.
- `TENKI_MCP_AUDIT=1` logs each tool call's **name + argument keys** to stderr (never values, content, or the token) for an operator audit trail.

## CSA MCP Server Top-10 mapping

| #      | Risk                      | tenki-mcp posture                                                                                                                                                                                                                               |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP-01 | Prompt Injection          | zod-validates every tool arg pre-network; **sandbox output is untrusted** (treat tool results as data)                                                                                                                                          |
| MCP-02 | Confused Deputy           | static mode requires its own HTTP bearer; hosted mode authenticates every request and binds the session and API delegation to the authorized user, client, and workspace; `READONLY`/denylist further bound the blast radius                    |
| MCP-03 | Tool Poisoning            | tool descriptions are static and authored (no dynamic/remote descriptions); verify the package via its npm provenance attestation (published from GitHub Actions, linking each release to its source commit) + MCP-registry namespace ownership |
| MCP-04 | Credential/Token Exposure | credentials are never logged/committed/echoed; hosted Hydra tokens terminate at the MCP boundary and only short-lived internal delegations reach the API; audit logs keys not values                                                            |
| MCP-05 | Insecure Configuration    | HTTP transport is loopback + token + DNS-rebinding-protected + DoS-capped by default                                                                                                                                                            |
| MCP-06 | Supply Chain              | Official MCP v2 server/runtime packages and `zod`; lockfile committed; released only from CI with npm provenance, Actions pinned to commit SHAs                                                                                                 |
| MCP-07 | Excessive Permissions     | tool annotations + `TENKI_MCP_READONLY` + `TENKI_MCP_DISABLED_TOOLS`                                                                                                                                                                            |
| MCP-08 | Data Exfiltration         | microVM isolation; sandbox **outbound networking is off unless `allow_outbound` is set**; the server itself stores/forwards nothing                                                                                                             |
| MCP-09 | Context Spoofing          | tool results are raw API/sandbox output surfaced as data, not merged into instructions                                                                                                                                                          |
| MCP-10 | Insecure Communication    | control plane is HTTPS; run the HTTP transport behind TLS for any non-loopback use                                                                                                                                                              |

## Cost / resource notes

`tenki_run_code` is cost-guarded (1 vCPU, 1 GB, 10-min cap, 5-min idle) and self-terminates. `tenki_create_sandbox` and other create tools **spend real credits** — bound them with your **Tenki workspace limits**, `TENKI_MCP_READONLY`/denylist, and `TENKI_MCP_AUDIT` for visibility.
