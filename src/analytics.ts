/**
 * Optional PostHog MCP Analytics (https://posthog.com/docs/mcp-analytics).
 *
 * OFF unless a project token is configured:
 *   LUXOR_MCP_POSTHOG_TOKEN   — PostHog project token (phc_…). Unset → no analytics, no network.
 *   LUXOR_MCP_POSTHOG_HOST    — ingestion host (default https://us.i.posthog.com)
 *   LUXOR_MCP_ANALYTICS=0     — force off even when a token is set
 *   DO_NOT_TRACK=1            — force off (https://consoledonottrack.com)
 * (TENKI_* names work as the legacy fallback, like every other setting.)
 *
 * What is sent: one `$mcp_tool_call` per tool call (tool name, duration,
 * error flag, client name/version, protocol version, argument NAMES), the
 * agent's stated intent (`$mcp_intent`, from an injected `context` argument),
 * the calling model when the client reports it, plus `$mcp_initialize`,
 * `$mcp_tools_list` and `$exception` events. In OAuth-hosted mode the event is
 * attributed to the OAuth subject and grouped by workspace.
 *
 * What is NOT sent: tool argument VALUES and tool RESULTS. Sandbox commands,
 * file contents, git output and signed URLs routinely carry customer code and
 * secrets that pattern-based redaction cannot reliably catch, so beforeSend
 * drops `$mcp_parameters` and `$mcp_response` from every event. Error messages
 * are kept (already credential-redacted by the SDK) but truncated.
 */
import { PostHog, instrument } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { readEnv } from "./env.js";

/** Who a hosted session belongs to, from the verified OAuth exchange. */
export interface AnalyticsIdentity {
	subject: string;
	workspaceId: string;
	clientId?: string;
}

const DEFAULT_HOST = "https://us.i.posthog.com";
const MAX_ERROR_MESSAGE = 300;

const falsy = (v?: string) => v === "0" || /^(false|off|no)$/i.test(v ?? "");
const truthy = (v?: string) => v === "1" || /^(true|on|yes)$/i.test(v ?? "");

/** True when analytics would be sent: a token is set and nothing opts out. */
export function analyticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (truthy(env.DO_NOT_TRACK)) return false;
	if (falsy(env.LUXOR_MCP_ANALYTICS ?? env.TENKI_MCP_ANALYTICS)) return false;
	return Boolean(readEnv("MCP_POSTHOG_TOKEN"));
}

let client: PostHog | undefined;

/** One PostHog client per process, shared by every per-session server. */
function posthog(): PostHog | null {
	if (client) return client;
	if (!analyticsEnabled()) return null;
	client = new PostHog(readEnv("MCP_POSTHOG_TOKEN")!, {
		host: readEnv("MCP_POSTHOG_HOST") || DEFAULT_HOST,
		// Tool calls are bursty and low-volume; flush small batches promptly.
		flushAt: 20,
		flushInterval: 10_000,
	});
	return client;
}

type CaptureEvent = { event: string; properties?: Record<string, unknown> };

/** Strip argument values and results; keep only metadata. Exported for tests. */
export function scrubEvent<E extends CaptureEvent>(event: E): E {
	const p = event.properties;
	if (!p) return event;
	delete p.$mcp_parameters;
	delete p.$mcp_response;
	if (typeof p.$mcp_error_message === "string" && p.$mcp_error_message.length > MAX_ERROR_MESSAGE) {
		p.$mcp_error_message = `${p.$mcp_error_message.slice(0, MAX_ERROR_MESSAGE)}…`;
	}
	return event;
}

/**
 * Instrument a freshly built server. Must run BEFORE tools are registered so
 * the SDK sees every tool schema. No-op when analytics is off.
 */
export function instrumentServer(server: McpServer, version: string, identity?: AnalyticsIdentity): void {
	const ph = posthog();
	if (!ph) return;
	instrument(server, ph, {
		serverBuild: version,
		// Intent is the main reason to use this SDK. The injected `context`
		// argument is stripped before our handlers run.
		context: {
			description: "Briefly, why are you calling this tool? Describe the user's goal, not the tool.",
		},
		captureModel: true,
		// Adds a visible JSON block to tool results; our results are already
		// contract-tested (structuredContent + JSON text), so keep them clean.
		enableConversationId: false,
		// Adds a get_more_tools tool; leave the advertised tool set unchanged for now.
		reportMissing: false,
		identify: identity
			? {
					distinctId: identity.subject,
					groups: { workspace: identity.workspaceId },
					...(identity.clientId ? { properties: { mcp_oauth_client_id: identity.clientId } } : {}),
				}
			: null,
		beforeSend: (event) => scrubEvent(event as CaptureEvent) as typeof event,
	});
}

/** Flush queued events; call on shutdown. Never throws. */
export async function shutdownAnalytics(timeoutMs = 3_000): Promise<void> {
	if (!client) return;
	try {
		await client.shutdown(timeoutMs);
	} catch {
		/* analytics must never block exit */
	}
}
