import { MCP_URL, resolveModel } from "../../agent";

export const dynamic = "force-dynamic";

/** What the header pills show: which model, and whether the MCP server is up and live or simulated. No secrets. */
export async function GET() {
	const model = resolveModel();
	let mcp: { up: boolean; mode?: string } = { up: false };
	try {
		const res = await fetch(MCP_URL.replace(/\/mcp$/, "/healthz"), { cache: "no-store", signal: AbortSignal.timeout(1500) });
		if (res.ok) mcp = { up: true, ...(await res.json()) };
	} catch {
		/* server not running */
	}
	return Response.json({ model: model?.label ?? null, mcp });
}
