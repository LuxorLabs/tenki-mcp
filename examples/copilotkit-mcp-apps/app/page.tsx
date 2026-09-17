"use client";

import { CopilotChat, useAgent, useConfigureSuggestions, useCopilotKit, useRenderTool } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

import { ToolCallCard } from "./tool-call-card";

const AGENT_ID = "default";

const PROMPTS = [
	{
		icon: "▶",
		title: "Run code",
		blurb: "Monte Carlo π, charted in the terminal",
		message: "Estimate π with a Monte Carlo simulation at 1k, 10k, 100k and 1M samples, and print the convergence as an ASCII bar chart.",
	},
	{
		icon: "◧",
		title: "Ship a web app",
		blurb: "A polished Pomodoro timer, live from a sandbox",
		message: "Build a beautiful Pomodoro timer web app with start/pause/reset, a progress ring and a session counter, and launch it.",
	},
	{
		icon: "⌁",
		title: "Prove it's a real machine",
		blurb: "Kernel, CPUs, memory, disk",
		message: "Show me this sandbox is real: run uname -a, nproc, free -m, df -h / and the uptime, then summarize the machine in one line.",
	},
	{
		icon: "⚡",
		title: "Benchmark",
		blurb: "Three ways to sum squares in Python",
		message: "Benchmark three ways to sum the squares of 0..5,000,000 in Python (for loop, generator with sum, and math formula) with timeit, and print a ranked table.",
	},
	{
		icon: "▦",
		title: "Fleet",
		blurb: "Everything running, with teardown",
		message: "Show me the fleet of sandboxes that are running.",
	},
];

interface Status {
	model: string | null;
	mcp: { up: boolean; mode?: string };
}

function useStatus() {
	const [status, setStatus] = useState<Status | null>(null);
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetch("/api/status", { cache: "no-store" })
				.then((r) => r.json())
				.then((s) => alive && setStatus(s))
				.catch(() => {});
		load();
		const t = setInterval(load, 10_000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);
	return status;
}

export default function Page() {
	const status = useStatus();
	const { agent } = useAgent({ agentId: AGENT_ID });
	const { copilotkit } = useCopilotKit();
	const [sending, setSending] = useState(false);

	// While the model is still streaming a tool call's arguments, show the code being written;
	// the MCP App itself renders below once the tool has run on the sandbox.
	useRenderTool({ name: "*", render: (props) => <ToolCallCard {...props} /> }, []);

	useConfigureSuggestions({
		available: "before-first-message",
		suggestions: PROMPTS.slice(0, 3).map((p) => ({ title: p.title, message: p.message })),
	});

	async function send(message: string) {
		if (sending || agent.isRunning) return;
		setSending(true);
		try {
			agent.addMessage({ id: crypto.randomUUID(), role: "user", content: message });
			await copilotkit.runAgent({ agent });
		} finally {
			setSending(false);
		}
	}

	const tenki = !status ? "checking" : !status.mcp.up ? "offline" : status.mcp.mode === "live" ? "live" : "simulated";

	return (
		<div className="shell">
			<aside className="side">
				<div className="brandrow">
					<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
						<rect x="1" y="1" width="22" height="22" rx="6" fill="#0b1b2d" stroke="#1d3450" />
						<path d="M12 5.2 17.8 8.5v6.9L12 18.8 6.2 15.4V8.5z" fill="none" stroke="#047BFF" strokeWidth="1.6" strokeLinejoin="round" />
						<path d="M6.4 8.6 12 11.9l5.6-3.3M12 11.9v6.7" fill="none" stroke="#7CC0FF" strokeWidth="1.3" strokeLinejoin="round" />
					</svg>
					<span className="wm">tenki</span>
					<span className="x">×</span>
					<span className="ck">CopilotKit</span>
				</div>

				<h1>
					Real Tenki Sandboxes,
					<br />
					rendered as <em>MCP Apps</em>.
				</h1>
				<p className="lede">
					Ask for anything that needs a computer. The agent boots a Tenki Sandbox in about two seconds, and the answer comes back as an app you can use,
					not a wall of text.
				</p>

				<div className="section-label">Try it</div>
				<div className="prompts">
					{PROMPTS.map((p) => (
						<button key={p.title} className="prompt" disabled={sending} onClick={() => send(p.message)}>
							<span className="picon">{p.icon}</span>
							<span className="ptext">
								<span className="ptitle">{p.title}</span>
								<span className="pblurb">{p.blurb}</span>
							</span>
							<span className="pgo">→</span>
						</button>
					))}
				</div>

				<div className="section-label">How it works</div>
				<ol className="stack">
					<li>
						<b>CopilotKit</b> chat renders the app
					</li>
					<li>
						<b>AG-UI</b> + MCP Apps middleware
					</li>
					<li>
						<b>Tenki MCP server</b>: 3 apps, 7 app-only tools
					</li>
					<li>
						<b>Tenki Sandboxes</b>: boot, run, serve
					</li>
				</ol>

				<div className="status">
					<span className={`pill ${tenki}`}>
						<i /> Tenki {tenki === "live" ? "live" : tenki === "simulated" ? "simulated (no key)" : tenki === "offline" ? "MCP server offline" : "…"}
					</span>
					<span className={`pill ${status?.model ? "live" : status ? "offline" : "checking"}`}>
						<i /> {status?.model ?? (status ? "no model key" : "…")}
					</span>
				</div>
			</aside>

			<main className="chat">
				<CopilotChat
					agentId={AGENT_ID}
					className="chatbox"
					labels={{
						chatInputPlaceholder: "Ask Tenki Copilot to run or build something…",
						welcomeMessageText: "What should we run on a sandbox?",
					}}
				/>
			</main>
		</div>
	);
}
