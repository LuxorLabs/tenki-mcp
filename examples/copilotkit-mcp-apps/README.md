# Tenki × CopilotKit — MCP Apps

Real Tenki Sandboxes, rendered as interactive **MCP Apps** inside a CopilotKit agent chat.

Ask the agent for anything that needs a computer. It boots a Tenki Sandbox (about half a second), and the answer comes back as an app you can use: a console with a live shell into the sandbox, a web app served from the sandbox and framed in the chat, or a fleet dashboard with teardown.

```
┌─ CopilotKit chat (Next.js, app/) ──────────────────────────────────────────┐
│  CopilotChat renders the MCP App iframe + a live "writing code" card        │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ AG-UI
┌─ Copilot Runtime (app/api/copilotkit) ─────────────────────────────────────┐
│  BuiltInAgent (claude-sonnet-5 via Aisa, or any key)                        │
│   ├─ ContinueAfterAppsMiddleware   lets the model read each app's result    │
│   └─ MCPAppsMiddleware             discovers UI tools, runs them, proxies   │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ MCP (Streamable HTTP)
┌─ Tenki MCP App server (tenki-server/, :3108) ──────────────────────────────┐
│  3 apps the model can open · 7 app-only tools the widgets call back into    │
└──────────────┬─────────────────────────────────────────────────────────────┘
               │ ConnectRPC (src/client.ts — the same client @tenkicloud/mcp ships)
         Tenki Sandboxes
```

## Quick start

```bash
cd examples/copilotkit-mcp-apps
npm install            # also installs tenki-server/
cp .env.example .env   # add TENKI_API_KEY and a model key
npm run dev            # Next.js on :3000, MCP server on :3108
```

Open http://localhost:3000. The two pills at the bottom of the side panel say whether Tenki is **live** (or **simulated** with no key) and which model is wired up.

Without a `TENKI_API_KEY` the MCP server runs **simulated**: the UI works, nothing executes, and every app shows a `SIMULATED` badge.

## What the MCP server exposes

| Tool | Who calls it | App it opens |
|---|---|---|
| `run_code_in_sandbox` | model | **Sandbox Console**: code, output, timings, a live shell into the sandbox, edit-and-rerun, "Ask Copilot to fix" |
| `launch_web_app` | model | **Live Preview**: the app served from the sandbox in a browser frame, "ask Copilot to change this app", files, server log |
| `show_sandbox_fleet` | model | **Fleet**: running demo sandboxes, per-sandbox and bulk teardown |
| `vm_exec`, `vm_run_code`, `vm_status`, `vm_logs`, `vm_destroy`, `fleet_list`, `fleet_destroy_all` | the apps only (`visibility: ["app"]`) | — |

The apps talk back two ways: `tools/call` (the terminal, rerun, destroy) proxied through CopilotKit to this server, and `ui/message` ("Ask Copilot to fix", "change this app"), which posts a user message and starts an agent turn. Everything lands in the same sandbox because the message carries its `sandbox_id`.

## Run of show (~5 minutes)

Click the prompts in the side panel, or type them.

1. **Prove it's a real machine.** Kernel, CPUs, memory, disk. Point at the timeline (`Boot 0.4s → Upload → Run`) and the agent's one-line summary, which comes from reading the actual output.
2. **Type in the console.** Click the terminal line and run `python3 --version && ls -la`. That's the app calling the MCP server directly: no model in the loop.
3. **Benchmark.** Code streams into the "Writing main.py" card while the model writes it, then the console shows the ranked table and the agent explains why the formula wins.
4. **Ship a web app.** The Pomodoro timer streams in as `index.html`, then goes live on a public `*.sb.tenki.sh` URL in about 3 seconds of Tenki time (`Boot → Upload → Serve → Expose`). Click Start inside the chat.
5. **Change it from inside the app.** In the preview's ask bar: *"switch the accent color to Tenki electric blue (#047BFF)"*. The agent redeploys into the same sandbox, and the preview URL stays the same.
6. **Fleet.** Show what's running, then **Destroy all demo sandboxes**.

Web apps take the longest, about 30s, and nearly all of that is the model writing the HTML. Tenki's share is 2–3s. The streaming card is there so the wait is watchable.

## Before you go on stage

```bash
npm run warm           # pre-boot 2 long-lived warm sandboxes (6h max, 4h idle)
npm run warm -- --list # check them
npm run capacity       # poll until Tenki can place a sandbox (if it couldn't)
```

If Tenki can't place a new sandbox mid-demo (`429 resource_exhausted: sandbox capacity unavailable`), the server falls back to a warm sandbox. The app's timeline says **warm pool** instead of a boot time, and the agent is told. Nothing pretends to boot. Bulk teardown skips warm sandboxes; drop them with `npm run warm -- --drop`.

To rehearse that failure without a real outage:

```bash
TENKI_SIMULATE=1 TENKI_SIMULATE_NO_CAPACITY=1 TENKI_SIMULATE_WARM=2 npm run dev
```

## Configuration

All in `.env` (read by both processes). See [.env.example](.env.example).

| Variable | Purpose |
|---|---|
| `TENKI_API_KEY` | Tenki key. Without it: simulated mode. |
| `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` | Any OpenAI-compatible endpoint. |
| `AISA_API_KEY` | Aisa shortcut (`https://api.aisa.one/v1`, default model `claude-sonnet-5`). |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | First-party keys (`LLM_MODEL` overrides the model). |
| `TENKI_POOL` | `fallback` (default), `prefer` (use warm sandboxes first, no boot), or `off`. |
| `TENKI_DEMO_TAG` | Tag on every sandbox the demo creates (default `copilotkit-mcp-apps`). |
| `TENKI_FLEET_ALLOW_ALL` | `1` lets the fleet list sandboxes this demo didn't create (read-only). Off by default: a shared workspace may hold other projects' sandboxes, and the fleet may be on a projector. |
| `MCP_PORT` | MCP server port (default 3108). |

**Safety.** Every sandbox the demo boots is tagged, auto-terminates after an hour (15 min idle), and the server refuses to run code in or destroy any sandbox without the tag.

## Checks

```bash
npm run typecheck
npm run smoke          # every tool against the running MCP server (live or simulated)
node scripts/agent-run.mjs "Run uname -a in a sandbox"   # one agent turn through the Copilot Runtime, printed as AG-UI events
```

## How it's put together (and the gotchas it works around)

- **Only UI tools reach the model.** `MCPAppsMiddleware` offers the model only tools with `_meta.ui.resourceUri`, so every model-facing tool here opens an app.
- **The model reads app results.** The middleware runs a UI tool after the model's turn has ended, so the model would never see its output. `app/continue-middleware.ts` wraps it, holds back `RUN_FINISHED`, and runs the model again with the tool results, stitched into one run (at most 3 continuations). That's what enables summaries and fix-and-retry.
- **Aisa tool-call indexes.** Relays in front of Anthropic models stream the first tool call as `index: 1` (Anthropic's content-block index, after the text block). The AI SDK expects 0-based indexes and crashes with `reading 'hasFinished'`. `app/stream-repair.ts` renumbers them.
- **Streaming code.** CopilotKit's partial-argument parsing streams top-level strings, so single-page apps are passed as a top-level `html` string (not nested in `files`). That's what the "Writing index.html" card renders.
- **One bundle, three views.** `tenki-server/ui` is a single Vite build inlined into one HTML file; the server stamps `window.__TENKI_VIEW__` per resource URI.
- **Servers outlive the exec.** Web apps run as transient systemd units (`ck-app-<port>`) in `~/web-<port>`, so a redeploy replaces exactly one server, and apps sharing a warm sandbox don't collide.

```
app/
  agent.ts                 model selection, system prompt, middleware order
  continue-middleware.ts   model continues after an MCP App result
  stream-repair.ts         OpenAI-compatible stream fix for tool-call indexes
  tool-call-card.tsx       live "writing code" card while arguments stream
  page.tsx, globals.css    side panel + CopilotChat
  api/copilotkit/…         Copilot Runtime endpoint
  api/status/route.ts      model + MCP server status for the pills
tenki-server/
  server.ts                MCP tools, resources, HTTP, warm-pool fallback
  tenki.ts                 live (Tenki) and simulated backends
  ui/                      the three apps (React, one inlined bundle)
  scripts/                 smoke test, warm pool, capacity watcher
scripts/agent-run.mjs      drive one agent turn over AG-UI from the terminal
```
