/**
 * The sandbox backend the MCP App tools call.
 *
 * Live mode drives real Tenki Sandboxes through the repo's own TenkiClient
 * (src/client.ts — the same client @tenkicloud/mcp ships). Simulated mode
 * exists so the UI can be developed and rehearsed without a Tenki key: it
 * never executes anything, and every result it returns carries
 * `mode: "simulated"`, which the widgets render as a visible badge.
 */
import { randomUUID } from "node:crypto";

import { TenkiClient } from "../../../src/client.ts";

/** Every sandbox this demo creates carries this tag; mutations are refused on anything without it. */
export const DEMO_TAG = process.env.TENKI_DEMO_TAG || "copilotkit-mcp-apps";
/** Pre-booted, long-lived demo sandboxes (`npm run warm`) also carry this tag. */
export const WARM_TAG = "warm";
/**
 * The sandbox that HOSTS this MCP server when it is deployed (scripts/deploy-sandbox.mts).
 * It deliberately does NOT carry DEMO_TAG: "destroy all demo sandboxes" would
 * otherwise terminate the server serving that very request (it did, once).
 */
export const HOST_TAG = "mcp-host";
export const SANDBOX_HOME = "/home/tenki";
/** Where run_code_in_sandbox writes its program. */
export const APP_DIR = `${SANDBOX_HOME}/app`;
/** Each web app gets its own directory, keyed by port, so apps sharing a VM don't overwrite each other. */
export const webDir = (port: number) => `${SANDBOX_HOME}/web-${port}`;

export type Mode = "live" | "simulated";
export type Language = "python" | "javascript" | "shell";

export interface VmInfo {
	id: string;
	name: string;
	state: string;
	cpuCores: number;
	memoryMb: number;
	createdAt?: string;
	tags: string[];
	demo: boolean;
	warm: boolean;
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

export interface CreateOptions {
	name: string;
	cpuCores: number;
	memoryMb: number;
	allowInbound: boolean;
	allowOutbound: boolean;
	/** A long-lived pool VM rather than a per-request one. */
	warm?: boolean;
}

export interface Backend {
	mode: Mode;
	create(opts: CreateOptions): Promise<{ vm: VmInfo; bootMs: number }>;
	get(id: string): Promise<VmInfo>;
	list(includeAll: boolean): Promise<VmInfo[]>;
	writeFiles(id: string, files: { path: string; content: string }[]): Promise<number>;
	exec(id: string, script: string, timeoutSeconds?: number): Promise<RunOutput>;
	startServer(id: string, command: string, port: number): Promise<{ log: string }>;
	waitForPort(id: string, port: number): Promise<boolean>;
	expose(id: string, port: number): Promise<string>;
	readLog(id: string, port: number): Promise<string>;
	destroy(id: string): Promise<void>;
}

export const FILE_FOR: Record<Language, { file: string; command: string }> = {
	python: { file: "main.py", command: "python3 main.py" },
	javascript: { file: "main.js", command: "node main.js" },
	shell: { file: "main.sh", command: "sh main.sh" },
};

/** POSIX single-quote for `sh -c`. */
export const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const logPath = (port: number) => `${webDir(port)}/.server.log`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "SESSION_STATE_RUNNING" → "RUNNING". */
function normState(raw: unknown): string {
	return String(raw ?? "UNKNOWN").replace(/^SESSION_STATE_/, "");
}

/** Validate a relative path, refusing anything that could escape its directory. */
function safeRel(rel: string): string {
	const clean = rel.replace(/^\.?\/+/, "");
	if (!clean || clean.split("/").some((seg) => seg === ".." || seg === "")) {
		throw new Error(`Invalid file path "${rel}": use a relative path like "index.html" or "static/app.js".`);
	}
	return clean;
}

export const appPath = (rel: string) => `${APP_DIR}/${safeRel(rel)}`;
export const webPath = (port: number, rel: string) => `${webDir(port)}/${safeRel(rel)}`;

/** Tenki could not place a VM right now (capacity), as opposed to a bad request. */
export function isCapacityError(err: unknown): boolean {
	return /resource_exhausted|capacity unavailable|placement constraints/i.test(err instanceof Error ? err.message : String(err));
}

// ─── Live: real Tenki Sandboxes ──────────────────────────────────────────────

class LiveBackend implements Backend {
	readonly mode = "live" as const;
	private owner?: Promise<{ ownerType?: string; ownerId?: string; workspaceId?: string }>;
	/** Sessions this process created — authoritative even if the API omits tags. */
	private readonly mine = new Set<string>();

	constructor(private readonly client: TenkiClient) {}

	private toVm(s: Record<string, any>): VmInfo {
		const tags: string[] = Array.isArray(s.tags) ? s.tags : [];
		const id = String(s.id ?? s.sessionId ?? "");
		return {
			id,
			name: String(s.name ?? ""),
			state: normState(s.state),
			cpuCores: Number(s.cpuCores ?? s.resources?.cpuCores ?? 0),
			memoryMb: Number(s.memoryMb ?? s.resources?.memoryMb ?? 0),
			createdAt: s.createdAt ?? s.createTime ?? undefined,
			tags,
			demo: tags.includes(DEMO_TAG) || this.mine.has(id),
			warm: tags.includes(WARM_TAG),
		};
	}

	async create(opts: CreateOptions) {
		this.owner ??= this.client.resolveOwner();
		const owner = await this.owner;
		const started = Date.now();
		const resp = await this.client.control("CreateSession", {
			...(owner.ownerType ? { ownerType: owner.ownerType } : {}),
			...(owner.ownerId ? { ownerId: owner.ownerId } : {}),
			...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}),
			name: opts.name,
			cpuCores: opts.cpuCores,
			memoryMb: opts.memoryMb,
			// A demo sandbox can never outlive the demo by much; pool VMs cover a whole session.
			maxDuration: opts.warm ? "21600s" : "3600s",
			idleTimeoutMinutes: opts.warm ? 240 : 15,
			tags: opts.warm ? [DEMO_TAG, WARM_TAG] : [DEMO_TAG],
			...(opts.allowInbound ? { allowInbound: true } : {}),
			...(opts.allowOutbound ? { allowOutbound: true } : {}),
		});
		const session = (resp.session as Record<string, any>) ?? resp;
		const id = String(session.id ?? resp.sessionId ?? "");
		if (!id) throw new Error("CreateSession returned no session id.");
		this.mine.add(id);
		const running = await this.client.waitForState(id, "RUNNING", { intervalMs: 200, timeoutMs: 120_000 });
		return { vm: this.toVm({ ...session, ...running, id }), bootMs: Date.now() - started };
	}

	async get(id: string) {
		const resp = await this.client.control("GetSession", { sessionId: id });
		return this.toVm((resp.session as Record<string, any>) ?? resp);
	}

	async list(includeAll: boolean) {
		const resp = await this.client.control("ListSessions", { pageSize: 100 });
		const rows: Record<string, any>[] = Array.isArray(resp.sessions) ? resp.sessions : [];
		return rows
			.map((s) => this.toVm(s))
			.filter((vm) => !vm.state.includes("TERMINAT"))
			.filter((vm) => includeAll || vm.demo);
	}

	async writeFiles(id: string, files: { path: string; content: string }[]) {
		const started = Date.now();
		const dirs = [...new Set(files.map((f) => f.path.slice(0, f.path.lastIndexOf("/"))).filter(Boolean))];
		if (dirs.length) {
			await this.client.control("ExecuteCommand", { sessionId: id, command: "mkdir", args: ["-p", ...dirs] });
		}
		await Promise.all(files.map((f) => this.client.writeTextFile(id, f.path, f.content)));
		return Date.now() - started;
	}

	async exec(id: string, script: string, timeoutSeconds = 60): Promise<RunOutput> {
		const started = Date.now();
		// mkdir inside the script rather than execCaptured's cwd: a cwd that does
		// not exist yet would fail the cd before the command ever ran.
		const r = await this.client.execCaptured(id, "sh", {
			args: ["-c", `mkdir -p ${APP_DIR} && cd ${APP_DIR} && ${script}`],
			timeoutSeconds,
			maxOutputBytes: 32_768,
		});
		return {
			command: script,
			stdout: r.stdout,
			stderr: r.captureError ? `${r.stderr}\n[capture error: ${r.captureError}]` : r.stderr,
			exitCode: r.exitCode,
			ok: r.ok,
			runMs: Date.now() - started,
			truncated: Boolean(r.stdoutTruncated || r.stderrTruncated),
		};
	}

	/**
	 * Start a long-running server that outlives the exec that launched it.
	 * Prefers a transient systemd unit (survives the exec's process group being
	 * reaped); falls back to setsid+nohup on images without passwordless sudo.
	 */
	async startServer(id: string, command: string, port: number) {
		const log = logPath(port);
		const dir = webDir(port);
		const unit = `ck-app-${port}`;
		const script = [
			`mkdir -p ${dir} && : > ${log}`,
			`if command -v systemd-run >/dev/null 2>&1 && sudo -n true 2>/dev/null; then`,
			`  sudo -n systemctl stop ${unit} >/dev/null 2>&1 || true`,
			`  sudo -n systemd-run --unit=${unit} --collect --uid="$(id -u)" --gid="$(id -g)" -p WorkingDirectory=${dir} -E HOME=${SANDBOX_HOME} -E PATH="$PATH" -E PORT=${port} sh -c ${shq(`exec ${command} >> ${log} 2>&1`)} >/dev/null && echo systemd`,
			`else`,
			`  fuser -k ${port}/tcp >/dev/null 2>&1 || true`,
			`  cd ${dir} && PORT=${port} setsid nohup sh -c ${shq(command)} >> ${log} 2>&1 < /dev/null & echo setsid`,
			`fi`,
		].join("\n");
		await this.client.control("ExecuteCommand", { sessionId: id, command: "sh", args: ["-c", script], timeout: "20s" });
		return { log };
	}

	async waitForPort(id: string, port: number) {
		const probe = `python3 -c "import socket;socket.create_connection(('127.0.0.1',${port}),1)" 2>/dev/null || node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null`;
		const script = `i=0; while [ $i -lt 60 ]; do if ${probe}; then echo up; exit 0; fi; i=$((i+1)); sleep 0.25; done; echo down; exit 1`;
		const r = await this.client.control("ExecuteCommand", { sessionId: id, command: "sh", args: ["-c", script], timeout: "30s" });
		const exec = (r.execution as Record<string, any>) ?? r;
		return Number(exec.exitCode ?? 0) === 0;
	}

	async expose(id: string, port: number) {
		let url = "";
		try {
			const listed = await this.client.control("ListExposedPorts", { sessionId: id });
			url = findPreviewUrl(listed, port);
		} catch {
			/* fall through to ExposePort */
		}
		if (!url) url = findPreviewUrl(await this.client.control("ExposePort", { sessionId: id, port }), port);
		if (!url) throw new Error(`ExposePort for port ${port} returned no preview URL.`);
		// The edge route can lag the exposure by a moment; don't hand the widget a 502 — but never wait long.
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(Math.max(500, Math.min(3000, deadline - Date.now()))), redirect: "manual" });
				if (res.status < 500) break;
			} catch {
				/* not routable yet */
			}
			await sleep(400);
		}
		return url;
	}

	async readLog(id: string, port: number) {
		const r = await this.exec(id, `tail -c 6000 ${logPath(port)} 2>/dev/null || true`, 15);
		return r.stdout;
	}

	async destroy(id: string) {
		await this.client.control("TerminateSession", { sessionId: id });
		this.mine.delete(id);
	}
}

/** Pull a preview URL for `port` out of an ExposePort / ListExposedPorts response of any shape. */
function findPreviewUrl(value: unknown, port: number): string {
	const seen: Record<string, any>[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") {
			seen.push(v as Record<string, any>);
			Object.values(v).forEach(walk);
		}
	};
	walk(value);
	const withUrl = seen.filter((o) => typeof (o.previewUrl ?? o.preview_url ?? o.url) === "string");
	const match = withUrl.find((o) => o.port === undefined || Number(o.port) === port) ?? withUrl[0];
	return match ? String(match.previewUrl ?? match.preview_url ?? match.url) : "";
}

// ─── Simulated: no key, nothing executes ────────────────────────────────────

interface SimVm {
	vm: VmInfo;
	files: Map<string, string>;
	servers: Map<number, string>;
}

class SimulatedBackend implements Backend {
	readonly mode = "simulated" as const;
	readonly vms = new Map<string, SimVm>();

	constructor(private readonly publicBase: string) {}

	private need(id: string): SimVm {
		const s = this.vms.get(id);
		if (!s) throw new Error(`Sandbox ${id} not found (simulated).`);
		return s;
	}

	async create(opts: CreateOptions) {
		// Rehearse the warm-pool fallback: fail every non-pool boot the way Tenki does when it has no capacity.
		if (process.env.TENKI_SIMULATE_NO_CAPACITY === "1" && !opts.warm) {
			await sleep(300);
			throw new Error("Tenki CreateSession failed (429 resource_exhausted): sandbox capacity unavailable (simulated)");
		}
		const bootMs = 900 + Math.round(Math.random() * 700);
		await sleep(bootMs);
		const vm: VmInfo = {
			id: randomUUID(),
			name: opts.name,
			state: "RUNNING",
			cpuCores: opts.cpuCores,
			memoryMb: opts.memoryMb,
			createdAt: new Date().toISOString(),
			tags: opts.warm ? [DEMO_TAG, WARM_TAG] : [DEMO_TAG],
			demo: true,
			warm: Boolean(opts.warm),
		};
		this.vms.set(vm.id, { vm, files: new Map(), servers: new Map() });
		return { vm, bootMs };
	}

	async get(id: string) {
		return this.need(id).vm;
	}

	async list() {
		return [...this.vms.values()].map((s) => s.vm);
	}

	async writeFiles(id: string, files: { path: string; content: string }[]) {
		const s = this.need(id);
		for (const f of files) s.files.set(f.path, f.content);
		await sleep(120);
		return 120;
	}

	async exec(id: string, script: string): Promise<RunOutput> {
		this.need(id);
		await sleep(250);
		return {
			command: script,
			stdout: "",
			stderr:
				"[simulated] Nothing was executed: this server has no TENKI_API_KEY.\n" +
				"Set TENKI_API_KEY in examples/copilotkit-mcp-apps/.env and restart to run this in a real Tenki Sandbox.",
			exitCode: 0,
			ok: true,
			runMs: 250,
			truncated: false,
		};
	}

	async startServer(id: string, command: string, port: number) {
		this.need(id).servers.set(port, command);
		return { log: logPath(port) };
	}

	async waitForPort() {
		await sleep(300);
		return true;
	}

	/** Static files the agent wrote are served back by this MCP server so the preview still renders. */
	async expose(id: string, port: number) {
		return `${this.publicBase}/simulated-preview/${id}/${port}/`;
	}

	async readLog(id: string, port: number) {
		const cmd = this.need(id).servers.get(port);
		return `[simulated] would run: ${cmd ?? "(nothing started)"}\n[simulated] static files are served by the local MCP server instead.`;
	}

	async destroy(id: string) {
		this.vms.delete(id);
	}

	/** Serve a file written into a simulated VM (static preview fallback). */
	file(id: string, port: number, rel: string): string | undefined {
		const s = this.vms.get(id);
		if (!s) return undefined;
		const want = rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel;
		try {
			return s.files.get(webPath(port, want));
		} catch {
			return undefined;
		}
	}
}

/**
 * Backend for a request. `overrideToken` is a visitor's own Tenki key (sent as
 * x-tenki-key), so their sandboxes are created in their workspace on their bill;
 * without one this falls back to the server's key, or to simulated mode.
 */
export function createBackend(publicBase: string, overrideToken?: string): Backend {
	const token = overrideToken || process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY;
	if (!token || (process.env.TENKI_SIMULATE === "1" && !overrideToken)) return new SimulatedBackend(publicBase);
	return new LiveBackend(new TenkiClient(token, process.env.TENKI_API_ENDPOINT || undefined));
}

export { SimulatedBackend };
