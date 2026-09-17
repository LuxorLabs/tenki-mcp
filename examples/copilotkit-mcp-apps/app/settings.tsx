"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Keys a visitor brings themselves.
 *
 * They live in this browser's localStorage and ride along as headers on each
 * request to this app, which passes the Tenki key to the MCP server and uses the
 * model key for that turn. Nothing is stored server-side — which is worth saying
 * plainly in the dialog, because a hosted runtime is a server the keys pass through.
 */
export interface Keys {
	tenkiKey: string;
	llmKey: string;
	llmBaseUrl: string;
	llmModel: string;
}

const EMPTY: Keys = { tenkiKey: "", llmKey: "", llmBaseUrl: "", llmModel: "" };
const STORAGE = "tenki-copilotkit-keys";

export const PROVIDERS = [
	{ id: "aisa", label: "Aisa", baseUrl: "https://api.aisa.one/v1", model: "claude-sonnet-5" },
	{ id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1" },
	{ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
	{ id: "custom", label: "Custom", baseUrl: "", model: "" },
] as const;

interface Ctx {
	keys: Keys;
	save: (keys: Keys) => void;
	clear: () => void;
	open: boolean;
	setOpen: (open: boolean) => void;
	usingOwnTenki: boolean;
	usingOwnModel: boolean;
	headers: Record<string, string>;
}

const SettingsContext = createContext<Ctx | null>(null);
export const useSettings = () => {
	const ctx = useContext(SettingsContext);
	if (!ctx) throw new Error("useSettings outside SettingsProvider");
	return ctx;
};

export function SettingsProvider({ children }: { children: ReactNode }) {
	const [keys, setKeys] = useState<Keys>(EMPTY);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		try {
			const raw = localStorage.getItem(STORAGE);
			if (raw) setKeys({ ...EMPTY, ...JSON.parse(raw) });
		} catch {
			/* private mode, or corrupt value — the demo keys still work */
		}
	}, []);

	const save = useCallback((next: Keys) => {
		setKeys(next);
		try {
			localStorage.setItem(STORAGE, JSON.stringify(next));
		} catch {
			/* not persisting is survivable; the keys still apply this session */
		}
	}, []);

	const clear = useCallback(() => {
		setKeys(EMPTY);
		try {
			localStorage.removeItem(STORAGE);
		} catch {
			/* ignore */
		}
	}, []);

	const value = useMemo<Ctx>(() => {
		const headers: Record<string, string> = {};
		if (keys.tenkiKey.trim()) headers["x-tenki-key"] = keys.tenkiKey.trim();
		if (keys.llmKey.trim()) {
			headers["x-llm-key"] = keys.llmKey.trim();
			if (keys.llmBaseUrl.trim()) headers["x-llm-base-url"] = keys.llmBaseUrl.trim();
			if (keys.llmModel.trim()) headers["x-llm-model"] = keys.llmModel.trim();
		}
		return {
			keys,
			save,
			clear,
			open,
			setOpen,
			usingOwnTenki: Boolean(keys.tenkiKey.trim()),
			usingOwnModel: Boolean(keys.llmKey.trim()),
			headers,
		};
	}, [keys, save, clear, open]);

	return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function SettingsDialog() {
	const { keys, save, clear, open, setOpen, usingOwnTenki, usingOwnModel } = useSettings();
	const [draft, setDraft] = useState<Keys>(keys);
	const [provider, setProvider] = useState<string>("aisa");

	useEffect(() => {
		if (!open) return;
		setDraft(keys);
		const match = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === keys.llmBaseUrl);
		setProvider(keys.llmBaseUrl ? (match?.id ?? "custom") : "aisa");
	}, [open, keys]);

	if (!open) return null;

	const preset = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
	const pickProvider = (id: string) => {
		setProvider(id);
		const p = PROVIDERS.find((x) => x.id === id);
		if (p && p.id !== "custom") setDraft((d) => ({ ...d, llmBaseUrl: p.baseUrl, llmModel: d.llmModel || p.model }));
		if (p && p.id === "custom") setDraft((d) => ({ ...d, llmBaseUrl: "" }));
	};

	return (
		<div className="modal-backdrop" onClick={() => setOpen(false)}>
			<div className="modal" role="dialog" aria-modal="true" aria-label="Use your own keys" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Use your own keys</h2>
					<button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
						×
					</button>
				</div>

				<p className="modal-lede">
					Run the demo on your own Tenki account and model provider. Keys are kept in this browser and sent with each request to this app, which
					passes the Tenki key to the MCP server for that call. They are never stored on the server. Leave a field empty to use the demo&rsquo;s own key.
				</p>

				<label className="field">
					<span>
						Tenki API key{" "}
						<a href="https://docs.tenki.cloud" target="_blank" rel="noreferrer noopener">
							docs
						</a>
					</span>
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						placeholder="tk_…"
						value={draft.tenkiKey}
						onChange={(e) => setDraft({ ...draft, tenkiKey: e.target.value })}
					/>
					<small>Sandboxes are created in your workspace, on your bill.</small>
				</label>

				<div className="field">
					<span>Model provider</span>
					<div className="chips">
						{PROVIDERS.map((p) => (
							<button key={p.id} className={`chip ${provider === p.id ? "on" : ""}`} onClick={() => pickProvider(p.id)}>
								{p.label}
							</button>
						))}
					</div>
				</div>

				{provider === "custom" && (
					<label className="field">
						<span>OpenAI-compatible base URL</span>
						<input
							placeholder="https://your-endpoint/v1"
							autoComplete="off"
							spellCheck={false}
							value={draft.llmBaseUrl}
							onChange={(e) => setDraft({ ...draft, llmBaseUrl: e.target.value })}
						/>
					</label>
				)}

				<div className="field-row">
					<label className="field">
						<span>Model API key</span>
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="sk-…"
							value={draft.llmKey}
							onChange={(e) => setDraft({ ...draft, llmKey: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>Model</span>
						<input
							autoComplete="off"
							spellCheck={false}
							placeholder={preset.model || "model id"}
							value={draft.llmModel}
							onChange={(e) => setDraft({ ...draft, llmModel: e.target.value })}
						/>
					</label>
				</div>

				<div className="modal-foot">
					<span className="modal-state">
						{usingOwnTenki || usingOwnModel
							? `Using your ${[usingOwnTenki && "Tenki", usingOwnModel && "model"].filter(Boolean).join(" and ")} key${usingOwnTenki && usingOwnModel ? "s" : ""}.`
							: "Using the demo's keys."}
					</span>
					<button className="mbtn ghost" onClick={() => { clear(); setOpen(false); }}>
						Clear
					</button>
					<button
						className="mbtn primary"
						onClick={() => {
							const p = PROVIDERS.find((x) => x.id === provider);
							save({
								...draft,
								llmBaseUrl: draft.llmKey.trim() ? draft.llmBaseUrl || p?.baseUrl || "" : draft.llmBaseUrl,
								llmModel: draft.llmModel || (draft.llmKey.trim() ? (p?.model ?? "") : ""),
							});
							setOpen(false);
						}}
					>
						Save
					</button>
				</div>
			</div>
		</div>
	);
}
