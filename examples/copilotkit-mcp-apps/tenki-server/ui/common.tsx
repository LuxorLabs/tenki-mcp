import type { App } from "@modelcontextprotocol/ext-apps";
import { Fragment, useEffect, useState, type ReactNode } from "react";

// ─── shared data shapes (mirror server.ts results) ──────────────────────────

export type Mode = "live" | "simulated";

export interface VmInfo {
	id: string;
	name: string;
	state: string;
	cpuCores: number;
	memoryMb: number;
	createdAt?: string;
	tags: string[];
	demo: boolean;
	warm?: boolean;
}

export interface RunOutput {
	command: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	ok: boolean;
	runMs: number;
	truncated: boolean;
}

export type Structured = Record<string, any> & { mode?: Mode; error?: string };

// ─── host bridge helpers ────────────────────────────────────────────────────

/** Call an app-only tool; resolves to structuredContent, rejects with the tool's error text. */
export async function callTool(app: App, name: string, args: Record<string, unknown>): Promise<Structured> {
	const res = await app.callServerTool({ name, arguments: args });
	const structured = (res.structuredContent ?? {}) as Structured;
	if (res.isError) {
		const text = res.content?.find((c) => c.type === "text");
		throw new Error(structured.error ?? (text && "text" in text ? String(text.text) : "Tool call failed"));
	}
	return structured;
}

/** Put a message in the host chat as the user and let the agent respond. */
export function askCopilot(app: App, text: string) {
	return app.sendMessage({ role: "user", content: [{ type: "text", text }] });
}

// ─── formatting ─────────────────────────────────────────────────────────────

export const secs = (ms?: number | null) => (ms === null || ms === undefined ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);
export const gb = (mb: number) => (mb >= 1024 || mb === 0 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
export const shortId = (id: string) => id.slice(0, 8);

export function useTicker(startMs: number | null, stopped: boolean) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (stopped || startMs === null) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [startMs, stopped]);
	if (startMs === null) return "";
	const s = Math.max(0, Math.floor((now - startMs) / 1000));
	const mm = String(Math.floor(s / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

// ─── chrome ─────────────────────────────────────────────────────────────────

/** The official Tenki glyph, inlined: the widget bundle is one self-contained file. */
export function TenkiMark() {
	return (
		<svg className="mark" width="20" height="20" viewBox="0 0 400 400" fill="none" aria-hidden="true">
			<g transform="translate(86.04 80) scale(1.4286)">
				<path d="M121.079 52.9158L77.5002 24.3368C73.1671 21.4951 73.4379 15.04 77.9937 12.5735L99.6985 0.822258C101.904 -0.371657 104.584 -0.258565 106.681 1.11692L156.459 33.761C158.392 35.0289 159.555 37.1909 159.551 39.5077L159.444 99.16C159.44 101.674 158.063 103.983 155.858 105.177L134.153 116.928C129.597 119.394 124.069 116.079 124.078 110.887L124.172 58.6625C124.176 56.3457 123.013 54.1837 121.079 52.9158Z" fill="#047BFF" />
				<path d="M64.0127 91.828L63.8881 161.127C63.8787 166.319 69.4075 169.635 73.9633 167.168L104.625 150.568C106.83 149.374 108.206 147.064 108.211 144.551L108.349 67.8238C108.353 65.507 107.19 63.345 105.256 62.0772L41.2304 20.089C39.133 18.7136 36.4531 18.6005 34.2479 19.7944L3.5862 36.3949C-0.969559 38.8615 -1.24034 45.3166 3.09275 48.1582L60.92 86.0813C62.8534 87.3491 64.0168 89.5111 64.0127 91.828Z" fill="#047BFF" />
				<path d="M24.4509 108.439C24.4472 110.466 25.4753 112.358 27.183 113.468L48.4633 127.29C49.3718 127.88 49.9185 128.886 49.9166 129.964L49.8771 151.477C49.8725 154.009 47.0436 155.526 44.911 154.14L2.8026 126.788C1.09473 125.679 0.0667493 123.787 0.0704284 121.76L0.161047 68.9713C0.165658 66.44 2.99458 64.923 5.12715 66.3082L23.0427 77.9452C23.9512 78.5353 24.4979 79.5416 24.496 80.6199L24.4509 108.439Z" fill="#047BFF" />
			</g>
		</svg>
	);
}

export function ModeBadge({ mode }: { mode?: Mode }) {
	if (mode === "simulated") {
		return (
			<span className="badge warn" title="No TENKI_API_KEY on the MCP server — nothing is executed">
				SIMULATED
			</span>
		);
	}
	return (
		<span className="badge live" title="Running on real Tenki Sandboxes">
			<span className="pulse" /> LIVE sandbox
		</span>
	);
}

export function StateDot({ state }: { state: string }) {
	const cls = state.includes("RUNNING") ? "ok" : state.includes("TERMINAT") ? "dead" : state.includes("PAUS") ? "idle" : "pending";
	return <span className={`dot ${cls}`} title={state} />;
}

export function Header({
	view,
	mode,
	vm,
	uptime,
	right,
}: {
	view: string;
	mode?: Mode;
	vm?: VmInfo | null;
	uptime?: string;
	right?: ReactNode;
}) {
	return (
		<header className="hdr">
			<div className="hdr-row">
				<div className="brand">
					<TenkiMark />
					<span className="wordmark">tenki</span>
					<span className="sep">/</span>
					<span className="view">{view}</span>
				</div>
				<div className="hdr-right">
					{right}
					<ModeBadge mode={mode} />
				</div>
			</div>
			{vm && (
				<div className="vmline">
					<StateDot state={vm.state} />
					<span className="vmname" title={vm.id}>
						{vm.name || shortId(vm.id)}
					</span>
					<span className="spec">{vm.cpuCores || 1} vCPU</span>
					<span className="spec">{gb(vm.memoryMb || 1024)}</span>
					<span className={`state ${vm.state.includes("RUNNING") ? "" : "off"}`}>{vm.state}</span>
					{uptime && <span className="uptime">up {uptime}</span>}
				</div>
			)}
		</header>
	);
}

export function Timeline({ steps }: { steps: { label: string; value: string; tone?: "ok" | "bad" | "muted" }[] }) {
	return (
		<div className="timeline">
			{steps.map((s, i) => (
				<Fragment key={s.label}>
					{i > 0 && <span className="arrow">→</span>}
					<span className={`step ${s.tone ?? ""}`}>
						<span className="step-label">{s.label}</span>
						<span className="step-value">{s.value}</span>
					</span>
				</Fragment>
			))}
		</div>
	);
}

export function Spinner() {
	return <span className="spinner" aria-label="working" />;
}

export function ErrorCard({ app, kind, error, retryHint }: { app: App; kind: string; error: string; retryHint: string }) {
	// A capacity failure is Tenki's, not the code's: offer a retry, not a fix.
	const capacity = /capacity|resource_exhausted/i.test(error);
	return (
		<div className="card">
			<Header view={kind} />
			<div className="errorbox">
				<div className="error-title">{capacity ? "Tenki couldn't place a sandbox right now" : "Something went wrong"}</div>
				<pre className="error-body">{error}</pre>
				{capacity ? (
					<button className="btn secondary" onClick={() => askCopilot(app, "Tenki had no capacity a moment ago. Please try that again now.")}>
						↻ Ask Copilot to retry
					</button>
				) : (
					<button className="btn primary" onClick={() => askCopilot(app, `${retryHint}\n\nThe error was:\n${error.slice(0, 1500)}`)}>
						✦ Ask Copilot to fix it
					</button>
				)}
			</div>
		</div>
	);
}

// ─── tiny syntax highlighter (enough for demo-sized programs) ───────────────

const KEYWORDS: Record<string, string[]> = {
	python: "def return if elif else for while in not and or import from as class try except finally with lambda yield None True False print range len pass break continue raise global async await".split(" "),
	javascript: "const let var function return if else for while of in new class try catch finally throw async await import export from default null undefined true false this typeof console require".split(" "),
	shell: "if then else fi for do done while case esac function in echo export local return cd exit set".split(" "),
};

const TOKEN = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

export function highlight(code: string, language: string): ReactNode[] {
	const kw = new Set(KEYWORDS[language] ?? []);
	const out: ReactNode[] = [];
	let last = 0;
	let key = 0;
	for (const m of code.matchAll(TOKEN)) {
		const [text, comment, str, num, ident] = m;
		const idx = m.index ?? 0;
		if (idx > last) out.push(code.slice(last, idx));
		if (comment !== undefined) {
			// `//` is not a comment in python/shell, `#` is not one in JS.
			const isComment = language === "javascript" ? !comment.startsWith("#") : comment.startsWith("#");
			out.push(isComment ? <span key={key++} className="tk-c">{text}</span> : text);
		} else if (str !== undefined) out.push(<span key={key++} className="tk-s">{text}</span>);
		else if (num !== undefined) out.push(<span key={key++} className="tk-n">{text}</span>);
		else if (ident !== undefined && kw.has(ident)) out.push(<span key={key++} className="tk-k">{text}</span>);
		else out.push(text);
		last = idx + text.length;
	}
	if (last < code.length) out.push(code.slice(last));
	return out;
}

export function CodeBlock({ code, language, maxHeight = 280 }: { code: string; language: string; maxHeight?: number }) {
	const lines = code.replace(/\n$/, "").split("\n").length;
	return (
		<div className="code" style={{ maxHeight }}>
			<div className="gutter" aria-hidden="true">
				{Array.from({ length: lines }, (_, i) => (
					<div key={i}>{i + 1}</div>
				))}
			</div>
			<pre className="src">{highlight(code.replace(/\n$/, ""), language)}</pre>
		</div>
	);
}
