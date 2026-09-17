/**
 * MCP App entry. One bundle renders three views; server.ts stamps
 * window.__TENKI_VIEW__ into the HTML for whichever resource the host fetched.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { Header, Spinner, type Structured } from "./common.tsx";
import { ConsoleView } from "./console.tsx";
import { FleetView } from "./fleet.tsx";
import { PreviewView } from "./preview.tsx";
import "./styles.css";

type View = "console" | "preview" | "fleet";
const VIEW = ((window as unknown as { __TENKI_VIEW__?: View }).__TENKI_VIEW__ ?? "console") as View;

const WAITING: Record<View, string> = {
	console: "Booting a Tenki Sandbox and running your code…",
	preview: "Booting a Tenki Sandbox and starting your app…",
	fleet: "Loading sandboxes…",
};

function Root() {
	const [input, setInput] = useState<Record<string, any> | null>(null);
	const [result, setResult] = useState<CallToolResult | null>(null);

	const { app, error } = useApp({
		appInfo: { name: "Tenki Sandboxes", version: "0.1.0" },
		capabilities: {},
		onAppCreated: (created) => {
			created.ontoolinput = (params) => setInput((params.arguments ?? {}) as Record<string, any>);
			created.ontoolresult = (params) => setResult(params as CallToolResult);
		},
	});

	if (error) {
		return (
			<div className="card">
				<Header view="error" />
				<div className="errorbox">
					<pre className="error-body">Could not connect to the host: {error.message}</pre>
				</div>
			</div>
		);
	}

	if (!app || !result) {
		return (
			<div className="card">
				<Header view={VIEW === "console" ? "Sandbox Console" : VIEW === "preview" ? "Live Preview" : "Fleet"} />
				<div className="waiting">
					<Spinner /> {WAITING[VIEW]}
				</div>
			</div>
		);
	}

	const data = (result.structuredContent ?? {}) as Structured;
	if (result.isError && !data.error) {
		const text = result.content?.find((c) => c.type === "text");
		data.error = text && "text" in text ? String(text.text) : "The tool call failed.";
	}

	if (VIEW === "preview") return <PreviewView app={app} data={data} input={input} />;
	if (VIEW === "fleet") return <FleetView app={app} data={data} />;
	return <ConsoleView app={app} data={data} />;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
