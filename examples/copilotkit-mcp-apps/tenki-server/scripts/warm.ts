/**
 * Warm pool for stage demos: pre-boot long-lived demo VMs while Tenki has
 * capacity, so the agent can fall back to them if placement fails mid-demo.
 *
 *   npm run warm            # ensure 2 warm sandboxes are running
 *   npm run warm -- 3       # ensure 3
 *   npm run warm -- --list  # show them
 *   npm run warm -- --drop  # terminate them
 *
 * Warm VMs carry the demo tag plus "warm", live up to 6h, and idle out after 4h.
 * Set TENKI_POOL=prefer to use them first instead of booting (skips the boot, and the boot timing).
 */
import path from "node:path";

import { config } from "dotenv";

import { WARM_TAG, createBackend, isCapacityError } from "../tenki.ts";

config({ path: [path.join(import.meta.dirname, "..", ".env"), path.join(import.meta.dirname, "..", "..", ".env")], quiet: true });

const backend = createBackend("http://localhost");
if (backend.mode !== "live") {
	console.error("No TENKI_API_KEY — nothing to warm (simulated mode).");
	process.exit(1);
}

const args = process.argv.slice(2);
const warm = (await backend.list(false)).filter((v) => v.warm && !v.state.includes("TERMINAT"));

if (args.includes("--list")) {
	for (const v of warm) console.log(`${v.id}  ${v.name}  ${v.state}  ${v.cpuCores} vCPU / ${v.memoryMb} MB  since ${v.createdAt}`);
	console.log(`${warm.length} warm sandbox(es)`);
	process.exit(0);
}

if (args.includes("--drop")) {
	await Promise.all(warm.map((v) => backend.destroy(v.id).then(() => console.log(`terminated ${v.name}`))));
	process.exit(0);
}

const want = Number(args.find((a) => /^\d+$/.test(a)) ?? 2);
const running = warm.filter((v) => v.state.includes("RUNNING"));
console.log(`${running.length} warm sandbox(es) running, want ${want}`);
let failures = 0;
for (let i = running.length; i < want; i++) {
	const t = Date.now();
	try {
		const { vm, bootMs } = await backend.create({
			name: `ck-warm-${Math.random().toString(36).slice(2, 6)}`,
			cpuCores: 2,
			memoryMb: 4096,
			allowInbound: true,
			allowOutbound: true,
			warm: true,
		});
		// Touch the VM so the image's tools are paged in before the demo needs them.
		await backend.exec(vm.id, "python3 -c 'print(1)' && node -e 'console.log(1)'", 30);
		console.log(`✓ ${vm.name} (${vm.id}) booted in ${bootMs}ms, ready in ${Date.now() - t}ms  [${WARM_TAG}]`);
	} catch (err) {
		failures++;
		console.error(`✗ ${isCapacityError(err) ? "no Tenki capacity right now" : "failed"}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
process.exit(failures ? 1 : 0);
