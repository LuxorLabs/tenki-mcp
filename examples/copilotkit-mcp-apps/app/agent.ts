import { createOpenAI } from "@ai-sdk/openai";
import { MCPAppsMiddleware } from "@ag-ui/mcp-apps-middleware";
import { BuiltInAgent } from "@copilotkit/runtime/v2";

import { ContinueAfterAppsMiddleware } from "./continue-middleware";
import { repairingFetch } from "./stream-repair";

export const MCP_URL = process.env.MCP_URL || `http://localhost:${process.env.MCP_PORT || 3108}/mcp`;

const SYSTEM_PROMPT = `You are Tenki Copilot, the agent in a live demo of MCP Apps inside a CopilotKit app.

You control real Tenki Sandboxes: isolated sandboxes that boot in about two seconds. Each tool opens an MCP App — an interactive UI rendered right here in the chat, backed by the VM.

Tools:
- run_code_in_sandbox: run Python, Node.js or shell. Use it whenever something should be computed, tested, benchmarked, simulated or proven with code. The user gets a console with the code, its output, timings and a live shell into the VM.
- launch_web_app: build a web app and serve it from a sandbox; the running app appears in the chat. For anything visual (games, dashboards, visualizations, tools, landing pages) pass ONE self-contained page as \`html\`, with inline CSS and JS and no external requests. Make it look polished (modern typography, good spacing, tasteful color, a layout that fits a ~460px-tall frame and a narrow width) but keep it compact, well under 250 lines, so it ships fast.
- show_sandbox_fleet: show which sandboxes are running, or clean them up.

How to behave:
- Before a tool call, write one short sentence about what you're doing. After it returns, reply in one or two sentences with the insight (what the result means), not a recap: the UI already shows code, output and timings.
- If a run fails because of a bug in your code, fix it and run again in the same sandbox without asking. Stop after two attempts and explain.
- To change, fix or extend something, pass the sandbox_id from the earlier result so the work stays in the same VM.
- Programs are self-contained and print their results. Use only the standard library unless asked. If packages are needed, set allow_internet: true and use a shell program, e.g. "pip install -q rich && python3 - <<'PY' ... PY".
- For a backend (an API, websockets, anything dynamic), put the server in \`files\`, use python http.server or node http, listen on 0.0.0.0 and the port you pass, and set start_command.
- If a result says SIMULATED, tell the user no Tenki key is configured, so nothing actually ran.
- Keep a demo pace: small, striking examples over long ones.`;

/**
 * Claude buffers each tool-input value until it is complete, so a 7 KB `html`
 * argument would land in one burst after ~25s of silence. Fine-grained tool
 * streaming makes it trickle in (verified through Aisa), which is what lets the
 * "Writing index.html" card show the code being written. A plain object, not a
 * function: CopilotKit resolves provider headers once.
 */
const streamingHeaders = (model: string): Record<string, string> =>
	/claude/i.test(model) && process.env.LLM_FINE_GRAINED_TOOL_STREAMING !== "0"
		? { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" }
		: {};

/** The model, from whichever key is configured. Also reported (without secrets) by /api/status. */
export function resolveModel() {
	const model = process.env.LLM_MODEL;
	if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
		const provider = createOpenAI({
			baseURL: process.env.LLM_BASE_URL,
			apiKey: process.env.LLM_API_KEY,
			headers: streamingHeaders(model || "claude-sonnet-5"),
			fetch: repairingFetch,
		});
		// .chat(): an OpenAI-compatible relay speaks /chat/completions, not the Responses API.
		return { model: provider.chat(model || "claude-sonnet-5"), label: `${model || "claude-sonnet-5"} · ${new URL(process.env.LLM_BASE_URL).host}` };
	}
	if (process.env.AISA_API_KEY) {
		const provider = createOpenAI({
			baseURL: process.env.AISA_BASE_URL || "https://api.aisa.one/v1",
			apiKey: process.env.AISA_API_KEY,
			headers: streamingHeaders(model || "claude-sonnet-5"),
			fetch: repairingFetch,
		});
		return { model: provider.chat(model || "claude-sonnet-5"), label: `${model || "claude-sonnet-5"} · Aisa` };
	}
	if (process.env.ANTHROPIC_API_KEY) {
		const id = `anthropic/${model || "claude-sonnet-5"}`;
		return { model: id, label: id };
	}
	if (process.env.OPENAI_API_KEY) {
		const id = `openai/${model || "gpt-4.1"}`;
		return { model: id, label: id };
	}
	return null;
}

export function createDefaultAgent(): BuiltInAgent {
	const resolved = resolveModel();
	const agent = new BuiltInAgent({
		// With no key the agent still constructs, so the page renders and the
		// status pill can say what's missing; the first message fails with a clear error.
		model: resolved?.model ?? "openai/gpt-4.1",
		prompt: SYSTEM_PROMPT,
		maxSteps: 4,
	});
	// Order matters: the first middleware is the outermost. The continuation wraps
	// the MCP Apps middleware so it can see the tool results that middleware emits.
	agent.use(
		new ContinueAfterAppsMiddleware(3),
		new MCPAppsMiddleware({
			mcpServers: [
				{
					type: "http",
					url: MCP_URL,
					serverId: "tenki",
					// Set when the MCP server is hosted (see scripts/deploy-sandbox.mts); empty for localhost.
					...(process.env.MCP_TOKEN ? { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } : {}),
				},
			],
		}),
	);
	return agent;
}
