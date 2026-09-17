import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

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
	type RunOutput,
	type Structured,
	type VmInfo,
} from "./common.tsx";

interface Entry {
	id: number;
	command: string;
	run?: RunOutput;
	error?: string;
	pending?: boolean;
}

const LANG_LABEL: Record<string, string> = { python: "Python", javascript: "Node.js", shell: "Shell" };

export function ConsoleView({ app, data }: { app: App; data: Structured }) {
	if (data.error) {
		return (
			<ErrorCard
				app={app}
				kind="Sandbox Console"
				error={data.error}
				retryHint={`Running "${data.title ?? "the program"}" in a Tenki Sandbox failed. Please fix the problem and try again.`}
			/>
		);
	}
	return <Console app={app} data={data} />;
}

function Console({ app, data }: { app: App; data: Structured }) {
	const initialRun = data.run as RunOutput;
	const [vm, setVm] = useState<VmInfo>(data.sandbox as VmInfo);
	const [code, setCode] = useState<string>(data.code);
	const [draft, setDraft] = useState<string>(data.code);
	const [editing, setEditing] = useState(false);
	const [entries, setEntries] = useState<Entry[]>([{ id: 0, command: initialRun.command, run: initialRun }]);
	const [input, setInput] = useState("");
	const [history, setHistory] = useState<string[]>([]);
	const [histIdx, setHistIdx] = useState(-1);
	const [busy, setBusy] = useState(false);
	const [confirmDestroy, setConfirmDestroy] = useState(false);
	const termRef = useRef<HTMLDivElement>(null);
	const nextId = useRef(1);

	const dead = vm.state.includes("TERMINAT");
	const bornAt = useMemo(() => {
		const created = vm.createdAt ? Date.parse(vm.createdAt) : NaN;
		return Number.isFinite(created) ? created : Date.now() - (data.timings?.totalMs ?? 0);
	}, [vm.createdAt, data.timings?.totalMs]);
	const uptime = useTicker(bornAt, dead);
	const prompt = `tenki@${(vm.name || "vm").slice(0, 22)}:~/app$`;
	const last = [...entries].reverse().find((e) => e.run || e.error);
	const lastFailed = Boolean(last && (last.error || (last.run && last.run.exitCode !== 0)));

	useEffect(() => {
		termRef.current?.scrollTo({ top: termRef.current.scrollHeight, behavior: "smooth" });
	}, [entries]);

	async function execute(command: string, call: () => Promise<Structured>) {
		const id = nextId.current++;
		setBusy(true);
		setEntries((e) => [...e, { id, command, pending: true }]);
		try {
			const res = await call();
			setEntries((e) => e.map((x) => (x.id === id ? { id, command, run: res.run as RunOutput } : x)));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setEntries((e) => e.map((x) => (x.id === id ? { id, command, error: message } : x)));
			if (/not found|TERMINAT|refusing/i.test(message)) setVm((v) => ({ ...v, state: "TERMINATED" }));
		} finally {
			setBusy(false);
		}
	}

	const runShell = (command: string) => execute(command, () => callTool(app, "vm_exec", { sandbox_id: vm.id, command }));

	const runProgram = (source: string) => {
		setCode(source);
		setEditing(false);
		return execute(initialRun.command, () => callTool(app, "vm_run_code", { sandbox_id: vm.id, language: data.language, code: source }));
	};

	function onKey(e: KeyboardEvent<HTMLInputElement>) {
		if (e.key === "Enter" && input.trim() && !busy) {
			const cmd = input.trim();
			if (cmd === "clear") {
				setEntries([]);
			} else {
				void runShell(cmd);
			}
			setHistory((h) => [cmd, ...h].slice(0, 50));
			setHistIdx(-1);
			setInput("");
		} else if (e.key === "ArrowUp" && history.length) {
			e.preventDefault();
			const i = Math.min(histIdx + 1, history.length - 1);
			setHistIdx(i);
			setInput(history[i]);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			const i = histIdx - 1;
			setHistIdx(Math.max(i, -1));
			setInput(i >= 0 ? history[i] : "");
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
			setEntries((e) => [...e, { id: nextId.current++, command: "# destroy", error: err instanceof Error ? err.message : String(err) }]);
		} finally {
			setBusy(false);
			setConfirmDestroy(false);
		}
	}

	function handBack() {
		const tail = last?.run ? `${last.run.stdout}\n${last.run.stderr}`.trim().slice(-2500) : (last?.error ?? "");
		const status = last?.run ? `exit code ${last.run.exitCode}` : "an error";
		const text = lastFailed
			? `In Tenki sandbox ${vm.id}, \`${last?.command}\` failed with ${status}:\n\n${tail}\n\nPlease fix it and run it again in the same sandbox (sandbox_id: ${vm.id}).`
			: `Here's the latest output from Tenki sandbox ${vm.id} (\`${last?.command}\`):\n\n${tail}\n\nWhat does this tell us, and what should we try next? Use sandbox_id ${vm.id} if you run more code.`;
		void askCopilot(app, text);
	}

	const t = data.timings ?? {};
	const firstRun = initialRun;
	const steps = [
		data.pooled
			? { label: "Sandbox", value: "warm pool", tone: "muted" as const }
			: data.reused
				? { label: "Sandbox", value: "reused", tone: "muted" as const }
				: { label: "Boot", value: secs(t.bootMs) },
		{ label: "Upload", value: secs(t.uploadMs) },
		{ label: "Run", value: secs(t.runMs) },
		{ label: "Exit", value: String(firstRun.exitCode), tone: firstRun.exitCode === 0 ? ("ok" as const) : ("bad" as const) },
	];

	return (
		<div className="card">
			<Header view="Sandbox Console" mode={data.mode} vm={vm} uptime={uptime} />

			<div className="titlebar">
				<div className="title">{data.title}</div>
				<Timeline steps={steps} />
			</div>
			{data.replaced && <div className="note">The earlier sandbox had shut down, so this run booted a fresh sandbox.</div>}

			<section className="panel">
				<div className="panel-head">
					<span className="file">
						{data.file} <span className="lang">{LANG_LABEL[data.language] ?? data.language}</span>
					</span>
					<div className="panel-actions">
						{editing ? (
							<>
								<button className="btn ghost sm" onClick={() => { setDraft(code); setEditing(false); }}>
									Cancel
								</button>
								<button className="btn primary sm" disabled={busy || dead} onClick={() => runProgram(draft)}>
									▶ Save &amp; run
								</button>
							</>
						) : (
							<>
								<button className="btn ghost sm" disabled={dead} onClick={() => { setDraft(code); setEditing(true); }}>
									Edit
								</button>
								<button className="btn ghost sm" disabled={busy || dead} onClick={() => runProgram(code)}>
									↻ Run again
								</button>
							</>
						)}
					</div>
				</div>
				{editing ? (
					<textarea
						className="editor"
						value={draft}
						spellCheck={false}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void runProgram(draft);
						}}
						rows={Math.min(18, Math.max(6, draft.split("\n").length + 1))}
					/>
				) : (
					<CodeBlock code={code} language={data.language} />
				)}
			</section>

			<section className="terminal" ref={termRef}>
				{entries.map((e) => (
					<div className="entry" key={e.id}>
						<div className="cmd">
							<span className="ps1">{prompt}</span> {e.command}
						</div>
						{e.pending && (
							<div className="running">
								<Spinner /> running in the sandbox…
							</div>
						)}
						{e.run && (
							<>
								{e.run.stdout && <pre className="out">{e.run.stdout}</pre>}
								{e.run.stderr && <pre className="err">{e.run.stderr}</pre>}
								<div className={`exit ${e.run.exitCode === 0 ? "ok" : "bad"}`}>
									{e.run.exitCode === 0 ? "✓" : "✗"} exit {e.run.exitCode} · {secs(e.run.runMs)}
									{e.run.truncated ? " · output truncated" : ""}
								</div>
							</>
						)}
						{e.error && <pre className="err">{e.error}</pre>}
					</div>
				))}
				<div className="inputline">
					<span className="ps1">{dead ? "[sandbox terminated]" : prompt}</span>
					<input
						value={input}
						disabled={dead}
						placeholder={dead ? "" : busy ? "running…" : "type a command — ls, cat main.py, uname -a"}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={onKey}
						spellCheck={false}
						autoCapitalize="off"
						autoComplete="off"
					/>
				</div>
			</section>

			<footer className="actions">
				<button className={`btn ${lastFailed ? "primary" : "secondary"}`} disabled={!last} onClick={handBack}>
					✦ {lastFailed ? "Ask Copilot to fix" : "Send output to Copilot"}
				</button>
				<span className="grow" />
				<span className="hint">{dead ? "sandbox terminated" : "auto-shuts down after 15 min idle"}</span>
				<button className="btn danger" disabled={busy || dead} onClick={destroy}>
					{confirmDestroy ? "Click again to destroy" : "Destroy sandbox"}
				</button>
			</footer>
		</div>
	);
}
