import { CopilotRuntime, InMemoryAgentRunner, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { handle } from "hono/vercel";

import { createDefaultAgent, keysFromRequest } from "../../../agent";

const runtime = new CopilotRuntime({
	// Built per request: a visitor can bring their own Tenki and model keys, which
	// arrive as headers and decide both the model and what the MCP server runs on.
	agents: ({ request }) => ({ default: createDefaultAgent(keysFromRequest(request)) }),
	runner: new InMemoryAgentRunner(),
});

const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
