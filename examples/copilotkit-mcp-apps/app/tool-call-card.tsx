"use client";

import { useEffect, useRef } from "react";

const FILE_FOR: Record<string, string> = { python: "main.py", javascript: "main.js", shell: "main.sh" };

interface Props {
	name: string;
	status: "inProgress" | "executing" | "complete";
	parameters?: Record<string, any>;
	args?: Record<string, any>;
	result?: string;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * The tool call as it happens: the code streaming in while the model writes it,
 * then the sandbox steps while the tool runs, then a one-line receipt (the MCP
 * App below it carries the real result).
 */
export function ToolCallCard({ name, status, parameters, args, result }: Props) {
	const p = parameters ?? args ?? {};
	const codeRef = useRef<HTMLPreElement>(null);

	const isWeb = name === "launch_web_app";
	const isRun = name === "run_code_in_sandbox";
	const files: { path?: string; content?: string }[] = isWeb
		? [...(typeof p.html === "string" ? [{ path: "index.html", content: p.html }] : []), ...(Array.isArray(p.files) ? p.files : [])]
		: [];
	const current = isWeb ? files[files.length - 1] : undefined;
	const file = isWeb ? current?.path || "index.html" : FILE_FOR[p.language as string] || "main";
	const code = (isWeb ? current?.content : p.code) || "";
	const bytes = isWeb ? files.reduce((n, f) => n + (f.content?.length ?? 0), 0) : code.length;

	useEffect(() => {
		codeRef.current?.scrollTo({ top: codeRef.current.scrollHeight });
	}, [code]);

	if (!isWeb && !isRun) {
		if (status === "complete") return null;
		return (
			<div className="tc tc-line">
				<span className="tc-spin" /> Checking the fleet…
			</div>
		);
	}

	// The server's error results start with "<kind> failed:" (server.ts `failure`).
	if (status === "complete" && typeof result === "string" && /^[\w-]+ failed:/.test(result)) {
		return (
			<div className="tc tc-line tc-failed">
				<span className="tc-x">✗</span>
				{isWeb ? "Couldn't deploy" : `Couldn't run ${file}`}. Details below.
				<span className="tc-meta">{kb(bytes)}</span>
			</div>
		);
	}

	if (status === "complete") {
		return (
			<div className="tc tc-line tc-done">
				<span className="tc-check">✓</span>
				{isWeb ? `Deployed ${files.length} file${files.length === 1 ? "" : "s"}` : `Ran ${file}`} on a Tenki Sandbox
				<span className="tc-meta">{kb(bytes)}</span>
			</div>
		);
	}

	const writing = status === "inProgress";
	return (
		<div className="tc">
			<div className="tc-head">
				<span className="tc-spin" />
				{writing ? (
					<span>
						Writing <b>{file}</b>
						{isWeb && files.length > 1 ? <span className="tc-meta"> · file {files.length}</span> : null}
					</span>
				) : (
					<span className="tc-steps">
						<b>Tenki</b> {isWeb ? "booting sandbox → uploading → starting server → exposing port" : "booting sandbox → uploading → running"}
					</span>
				)}
				<span className="tc-meta tc-right">{kb(bytes)}</span>
			</div>
			{writing && (
				<pre className="tc-code" ref={codeRef}>
					{code}
					<span className="tc-caret" />
				</pre>
			)}
		</div>
	);
}
