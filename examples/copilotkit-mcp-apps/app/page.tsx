"use client";

import { CopilotChat, useAgent, useConfigureSuggestions, useCopilotKit, useRenderTool } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

import { useSettings } from "./settings";
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

const HOW_PROMPT =
	"How does this demo actually work? Walk me through the path from my message to the app I'm looking at: CopilotKit and AG-UI, the MCP Apps middleware, the Tenki MCP server and its apps, and the sandboxes underneath. Add a little detail on what makes an MCP App different from a plain tool call.";

const LINKS = [
	{ label: "GitHub", href: "https://github.com/LuxorLabs/tenki-mcp", title: "The MCP server and this demo" },
	{ label: "Tenki docs", href: "https://docs.tenki.cloud", title: "Tenki Sandboxes" },
	{ label: "MCP Apps docs", href: "https://mcpui.dev/guide/introduction", title: "The MCP Apps extension" },
];

export default function Page() {
	const status = useStatus();
	const { setOpen, usingOwnTenki, usingOwnModel } = useSettings();
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
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src="/tenki-glyph.svg" width={26} height={26} alt="" />
					<span className="wm">tenki</span>
					<span className="x">×</span>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img className="ck" src="/copilot-kit-logo-white.svg" alt="CopilotKit" height={18} />
				</div>

				<h1>
					Real Linux VMs,
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

				<button className="prompt how" disabled={sending} onClick={() => send(HOW_PROMPT)}>
					<span className="picon">?</span>
					<span className="ptext">
						<span className="ptitle">How does this work?</span>
						<span className="pblurb">Ask the agent to explain the stack</span>
					</span>
					<span className="pgo">→</span>
				</button>

				<button className="byo" onClick={() => setOpen(true)}>
					<span className="byo-icon">⚙</span>
					<span className="ptext">
						<span className="ptitle">{usingOwnTenki || usingOwnModel ? "Your keys are in use" : "Use your own keys"}</span>
						<span className="pblurb">Your Tenki account and model provider</span>
					</span>
				</button>

				<div className="links">
					{LINKS.map((l) => (
						<a key={l.href} href={l.href} title={l.title} target="_blank" rel="noreferrer noopener">
							{l.label} <span className="ext">↗</span>
						</a>
					))}
				</div>

				<div className="status">
					<span className={`pill ${usingOwnTenki ? "live" : tenki}`}>
						<i />{" "}
						{usingOwnTenki
							? "Tenki · your key"
							: `Tenki ${tenki === "live" ? "live" : tenki === "simulated" ? "simulated (no key)" : tenki === "offline" ? "MCP server offline" : "…"}`}
					</span>
					<span className={`pill ${usingOwnModel || status?.model ? "live" : status ? "offline" : "checking"}`}>
						<i /> {usingOwnModel ? "model · your key" : (status?.model ?? (status ? "no model key" : "…"))}
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
