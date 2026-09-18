import type { App } from "@modelcontextprotocol/ext-apps";
import { useMemo, useState } from "react";

import {
	CodeBlock,
	ErrorCard,
	Header,
	Spinner,
	Timeline,
	askCopilot,
	callTool,
	secs,
	useTicker,
	type Structured,
	type VmInfo,
} from "./common.tsx";

type Tab = "files" | "log" | "details";

const langOf = (path: string) => (/\.(m?js|ts|jsx|tsx)$/.test(path) ? "javascript" : /\.py$/.test(path) ? "python" : /\.sh$/.test(path) ? "shell" : "text");

export function PreviewView({ app, data, input }: { app: App; data: Structured; input: Record<string, any> | null }) {
	if (data.error) {
		return (
			<ErrorCard
				app={app}
				kind="Live Preview"
				error={data.error}
				retryHint={`Launching the web app "${data.title ?? "app"}" in a Tenki Sandbox failed${data.sandbox?.id ? ` (sandbox_id: ${data.sandbox.id})` : ""}. Please fix it and launch it again.`}
			/>
		);
	}
	return <Preview app={app} data={data} input={input} />;
}

function Preview({ app, data, input }: { app: App; data: Structured; input: Record<string, any> | null }) {
	const [vm, setVm] = useState<VmInfo>(data.sandbox as VmInfo);
	const [frameKey, setFrameKey] = useState(0);
	const [loading, setLoading] = useState(true);
	const [tab, setTab] = useState<Tab | null>(null);
	const [log, setLog] = useState<string>(data.log ?? "");
	const [logBusy, setLogBusy] = useState(false);
	const [openFile, setOpenFile] = useState<string | null>(null);
	const [ask, setAsk] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmDestroy, setConfirmDestroy] = useState(false);
	const [copied, setCopied] = useState(false);

	const dead = vm.state.includes("TERMINAT");
	const bornAt = useMemo(() => {
		const created = vm.createdAt ? Date.parse(vm.createdAt) : NaN;
		return Number.isFinite(created) ? created : Date.now() - (data.timings?.totalMs ?? 0);
	}, [vm.createdAt, data.timings?.totalMs]);
	const uptime = useTicker(bornAt, dead);
	const url: string = data.previewUrl;
	const host = useMemo(() => {
		try {
			const u = new URL(url);
			return { scheme: u.protocol === "https:" ? "https://" : "http://", rest: u.host + (u.pathname === "/" ? "" : u.pathname) };
		} catch {
			return { scheme: "", rest: url };
		}
	}, [url]);

	const files: { path: string; content: string }[] = input
		? [...(typeof input.html === "string" ? [{ path: "index.html", content: input.html }] : []), ...(Array.isArray(input.files) ? input.files : [])]
		: (data.files ?? []).map((p: string) => ({ path: p, content: "" }));
	const t = data.timings ?? {};

	async function refreshLog() {
		setLogBusy(true);
		try {
			const res = await callTool(app, "vm_logs", { sandbox_id: vm.id, port: data.port });
			setLog(res.log ?? "");
		} catch (err) {
			setLog(err instanceof Error ? err.message : String(err));
		} finally {
			setLogBusy(false);
		}
	}

	async function destroy() {
		if (!confirmDestroy) {
			setConfirmDestroy(true);
			setTimeout(() => setConfirmDestroy(false), 3000);
			return;
		}
		setBusy(true);
		try {
			await callTool(app, "vm_destroy", { sandbox_id: vm.id });
			setVm((v) => ({ ...v, state: "TERMINATED" }));
		} catch (err) {
			setLog(err instanceof Error ? err.message : String(err));
			setTab("log");
		} finally {
			setBusy(false);
			setConfirmDestroy(false);
		}
	}

	function sendChange() {
		const change = ask.trim();
		if (!change) return;
		setAsk("");
		void askCopilot(
			app,
			`Update the "${data.title}" web app running in Tenki sandbox ${vm.id}: ${change}\n\nRedeploy it into the same sandbox (sandbox_id: ${vm.id}, port ${data.port}).`,
		);
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard blocked in this frame — the URL is visible anyway */
		}
	}

	const steps = [
		data.pooled
			? { label: "Sandbox", value: "warm pool", tone: "muted" as const }
			: data.reused
				? { label: "Sandbox", value: "reused", tone: "muted" as const }
				: { label: "Boot", value: secs(t.bootMs) },
		{ label: "Upload", value: secs(t.uploadMs) },
		{ label: "Serve", value: secs(t.startMs) },
		{ label: "Expose", value: secs(t.exposeMs) },
		{ label: "Live", value: `${secs(t.totalMs)}`, tone: "ok" as const },
	];

	return (
		<div className="card">
			<Header view="Live Preview" mode={data.mode} vm={vm} uptime={uptime} />

			<div className="titlebar">
				<div className="title">{data.title}</div>
				<Timeline steps={steps} />
			</div>

			<div className="browser">
				<div className="chrome">
					<span className="lights">
						<i />
						<i />
						<i />
					</span>
					<button className="icon" title="Reload" disabled={dead} onClick={() => { setLoading(true); setFrameKey((k) => k + 1); }}>
						↻
					</button>
					<div className="urlbar" title={url}>
						<span className="lock">{host.scheme === "https://" ? "🔒" : "ⓘ"}</span>
						<span className="scheme">{host.scheme}</span>
						<span className="hostname">{host.rest}</span>
					</div>
					<button className="icon" title="Copy URL" onClick={copy}>
						{copied ? "✓" : "⧉"}
					</button>
					<button className="icon" title="Open in new tab" onClick={() => app.openLink({ url })}>
						↗
					</button>
				</div>
				<div className="viewport">
					{dead ? (
						<div className="frame-dead">
							<div>This sandbox was terminated — the preview is gone with it.</div>
						</div>
					) : (
						<>
							{loading && (
								<div className="frame-loading">
									<Spinner /> loading from the sandbox…
								</div>
							)}
							<iframe
								key={frameKey}
								src={url}
								title={data.title}
								onLoad={() => setLoading(false)}
								sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
							/>
						</>
					)}
				</div>
			</div>

			<div className="askbar">
				<span className="spark">✦</span>
				<input
					value={ask}
					disabled={dead}
					placeholder="Ask Copilot to change this app — e.g. “add a dark mode toggle”"
					onChange={(e) => setAsk(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && sendChange()}
				/>
				<button className="btn primary sm" disabled={!ask.trim() || dead} onClick={sendChange}>
					Send
				</button>
			</div>

			<nav className="tabs">
				<button className={tab === "files" ? "on" : ""} onClick={() => setTab(tab === "files" ? null : "files")}>
					Files <span className="count">{files.length}</span>
				</button>
				<button
					className={tab === "log" ? "on" : ""}
					onClick={() => {
						const next = tab === "log" ? null : "log";
						setTab(next);
						if (next && !dead) void refreshLog();
					}}
				>
					Server log
				</button>
				<button className={tab === "details" ? "on" : ""} onClick={() => setTab(tab === "details" ? null : "details")}>
					Details
				</button>
				<span className="grow" />
				<button className="btn danger sm" disabled={busy || dead} onClick={destroy}>
					{confirmDestroy ? "Click again to destroy" : "Destroy sandbox"}
				</button>
			</nav>

			{tab === "files" && (
				<section className="tabbody">
					<div className="filelist">
						{files.map((f) => (
							<button key={f.path} className={`filechip ${openFile === f.path ? "on" : ""}`} onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
								{f.path}
							</button>
						))}
					</div>
					{openFile && <CodeBlock code={files.find((f) => f.path === openFile)?.content || "(contents not available)"} language={langOf(openFile)} maxHeight={320} />}
				</section>
			)}
			{tab === "log" && (
				<section className="tabbody">
					<div className="logbar">
						<span>{data.startCommand}</span>
						<button className="btn ghost sm" disabled={logBusy || dead} onClick={refreshLog}>
							{logBusy ? <Spinner /> : "↻"} Refresh
						</button>
					</div>
					<pre className="log">{log || "(no output yet)"}</pre>
				</section>
			)}
			{tab === "details" && (
				<section className="tabbody details">
					<dl>
						<dt>Sandbox</dt>
						<dd>{vm.id}</dd>
						<dt>Command</dt>
						<dd>
							<code>{data.startCommand}</code>
						</dd>
						<dt>Port</dt>
						<dd>{data.port}</dd>
						<dt>Preview URL</dt>
						<dd>{url}</dd>
						<dt>Time to live URL</dt>
						<dd>{secs(t.totalMs)}</dd>
					</dl>
				</section>
			)}
		</div>
	);
}
