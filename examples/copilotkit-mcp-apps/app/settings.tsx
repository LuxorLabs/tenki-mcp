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

/** Free credits for the event — the whole reason a visitor opens this dialog. */
export const TENKI_CREDITS_URL = "https://tenki.cloud/events/mcp-apps-night";
export const AISA_SIGNUP_URL = "https://aisa.one";
/**
 * One code per visitor, drawn at random and then kept: re-rendering or reopening
 * the dialog must not hand the same person a second code. Codes are finite, so
 * with more visitors than codes some will collide — first to redeem wins.
 */
export const AISA_PROMOS = [
	"PROMO-F2B159FD3B5C69DA",
	"PROMO-531FB3650DAC5BDC",
	"PROMO-406F5985D2105EAE",
	"PROMO-7F8BA6F3DD6508CC",
	"PROMO-362C006429FF20A2",
	"PROMO-62BF68FC3453ECFC",
	"PROMO-EE678AF201F132F0",
	"PROMO-F77F81D275DCFC55",
	"PROMO-B3853CC09A8D1367",
	"PROMO-E8621E8E4E66B9A6",
];
const STORAGE = "tenki-copilotkit-keys";
const PROMO_STORAGE = "tenki-copilotkit-promo";

/** The visitor's code: the one they were already given, or a fresh draw. */
function usePromoCode() {
	const [promo, setPromo] = useState<string | null>(null);
	// Drawn after mount, never during render: the server has no idea which code
	// this visitor holds, and drawing during render would trip hydration.
	useEffect(() => {
		try {
			const kept = localStorage.getItem(PROMO_STORAGE);
			if (kept && AISA_PROMOS.includes(kept)) {
				setPromo(kept);
				return;
			}
		} catch {
			/* private mode — draw one for this session instead */
		}
		const drawn = AISA_PROMOS[Math.floor(Math.random() * AISA_PROMOS.length)];
		setPromo(drawn);
		try {
			localStorage.setItem(PROMO_STORAGE, drawn);
		} catch {
			/* not persisting is fine; the code stays put for this page load */
		}
	}, []);
	return promo;
}

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
	const [copied, setCopied] = useState(false);
	const promo = usePromoCode();

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
			<div className="modal" role="dialog" aria-modal="true" aria-label="Get free API credits" onClick={(e) => e.stopPropagation()}>
				<div className="modal-head">
					<h2>Get FREE API Credits!</h2>
					<button className="modal-x" onClick={() => setOpen(false)} aria-label="Close">
						×
					</button>
				</div>

				<p className="modal-lede">
					Grab free credits, then run this demo on your own accounts. Keys are kept in this browser and sent with each request to this app, which
					passes the Tenki key to the MCP server for that call. They are never stored on the server. Leave a field empty to use the demo&rsquo;s own key.
				</p>

				<div className="offers">
					<div className="offer">
						<div className="offer-top">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src="/tenki-glyph.svg" width={20} height={20} alt="" />
							<b>Tenki</b>
							<span className="offer-tag">free sandbox credits</span>
						</div>
						<p>Claim credits for MCP Apps Night and create an API key — it starts with tk_.</p>
						<a className="offer-cta" href={TENKI_CREDITS_URL} target="_blank" rel="noreferrer noopener">
							Claim Tenki credits ↗
						</a>
					</div>

					<div className="offer">
						<div className="offer-top">
							<span className="offer-mark">A</span>
							<b>Aisa</b>
							<span className="offer-tag">$50 in model credits</span>
						</div>
						<p>
							Sign up, then apply this promo code for $50 of inference — Claude, GPT and others through one OpenAI-compatible endpoint.
						</p>
						<div className="promo">
							<code>{promo ?? "PROMO-…"}</code>
							<button
								className="copy"
								disabled={!promo}
								onClick={async () => {
									if (!promo) return;
									try {
										await navigator.clipboard.writeText(promo);
										setCopied(true);
										setTimeout(() => setCopied(false), 1500);
									} catch {
										/* clipboard blocked — the code is on screen to type */
									}
								}}
							>
								{copied ? "Copied" : "Copy"}
							</button>
						</div>
						<a className="offer-cta" href={AISA_SIGNUP_URL} target="_blank" rel="noreferrer noopener">
							Sign up at aisa.one ↗
						</a>
					</div>
				</div>

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
