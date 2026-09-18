import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";

import { ErrorCard, Header, Spinner, StateDot, callTool, gb, shortId, type Structured, type VmInfo } from "./common.tsx";

function age(createdAt: string | undefined, now: number) {
	const t = createdAt ? Date.parse(createdAt) : NaN;
	if (!Number.isFinite(t)) return "—";
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function FleetView({ app, data }: { app: App; data: Structured }) {
	if (data.error) {
		return <ErrorCard app={app} kind="Fleet" error={data.error} retryHint="Listing Tenki sandboxes failed. Please check what went wrong and try again." />;
	}
	return <Fleet app={app} data={data} />;
}

function Fleet({ app, data }: { app: App; data: Structured }) {
	const [vms, setVms] = useState<VmInfo[]>(data.vms ?? []);
	const [includeAll, setIncludeAll] = useState<boolean>(Boolean(data.includeAll));
	const [loading, setLoading] = useState(false);
	const [dying, setDying] = useState<Set<string>>(new Set());
	const [confirmAll, setConfirmAll] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);

	async function refresh(all = includeAll) {
		setLoading(true);
		setError(null);
		try {
			const res = await callTool(app, "fleet_list", { include_all: all });
			setVms(res.vms ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	async function destroy(id: string) {
		setDying((d) => new Set(d).add(id));
		try {
			await callTool(app, "vm_destroy", { sandbox_id: id });
			setVms((list) => list.map((v) => (v.id === id ? { ...v, state: "TERMINATED" } : v)));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDying((d) => {
				const n = new Set(d);
				n.delete(id);
				return n;
			});
		}
	}

	async function destroyAll() {
		if (!confirmAll) {
			setConfirmAll(true);
			setTimeout(() => setConfirmAll(false), 3000);
			return;
		}
		setConfirmAll(false);
		setLoading(true);
		try {
			await callTool(app, "fleet_destroy_all", {});
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
		}
	}

	const live = vms.filter((v) => !v.state.includes("TERMINAT"));
	const demoLive = live.filter((v) => v.demo && !v.warm);
	const vcpus = live.reduce((n, v) => n + (v.cpuCores || 0), 0);
	const mem = live.reduce((n, v) => n + (v.memoryMb || 0), 0);

	return (
		<div className="card">
			<Header
				view="Fleet"
				mode={data.mode}
				right={
					<button className="btn ghost sm" disabled={loading} onClick={() => refresh()}>
						{loading ? <Spinner /> : "↻"} Refresh
					</button>
				}
			/>

			<div className="stats">
				<div className="stat">
					<div className="stat-v">{live.length}</div>
					<div className="stat-l">sandboxes running</div>
				</div>
				<div className="stat">
					<div className="stat-v">{vcpus}</div>
					<div className="stat-l">vCPUs</div>
				</div>
				<div className="stat">
					<div className="stat-v">{gb(mem)}</div>
					<div className="stat-l">memory</div>
				</div>
			</div>

			{error && <div className="note bad">{error}</div>}

			<div className="fleet">
				{vms.length === 0 && <div className="empty">No sandboxes running. Ask Copilot to run some code or launch an app.</div>}
				{vms.map((v) => {
					const dead = v.state.includes("TERMINAT");
					return (
						<div className={`vmrow ${dead ? "gone" : ""}`} key={v.id}>
							<StateDot state={v.state} />
							<div className="vmmain">
								<div className="vmtitle">
									{v.name || "(unnamed)"}
									{v.warm && <span className="tag warm">warm pool</span>}
									{v.byo && <span className="tag warm">your key</span>}
									{!v.demo && <span className="tag">not this demo</span>}
								</div>
								<div className="vmsub">
									{shortId(v.id)} · {v.cpuCores} vCPU · {gb(v.memoryMb)} · {dead ? "terminated" : `up ${age(v.createdAt, now)}`}
								</div>
							</div>
							<span className={`state ${v.state.includes("RUNNING") ? "" : "off"}`}>{v.state}</span>
							{v.demo && !dead && (
								<button className="btn danger sm" disabled={dying.has(v.id)} onClick={() => destroy(v.id)}>
									{dying.has(v.id) ? <Spinner /> : "Destroy"}
								</button>
							)}
						</div>
					);
				})}
			</div>

			<footer className="actions">
				{data.allowAll && (
				<label className="toggle">
					<input
						type="checkbox"
						checked={includeAll}
						onChange={(e) => {
							setIncludeAll(e.target.checked);
							void refresh(e.target.checked);
						}}
					/>
					Show all workspace sandboxes
				</label>
				)}
				<span className="grow" />
				<button className="btn danger" disabled={loading || demoLive.length === 0} onClick={destroyAll}>
					{confirmAll ? `Click again to destroy ${demoLive.length}` : "Destroy all demo sandboxes"}
				</button>
			</footer>
		</div>
	);
}
