// Poll Tenki until a sandbox can be placed (creates + immediately terminates a tiny probe VM).
//   npx tsx scripts/capacity-watch.mts [intervalSeconds=60] [maxMinutes=45]
import path from "node:path";
import { config } from "dotenv";
config({ path: path.join(import.meta.dirname, "..", "..", ".env"), quiet: true });
import { TenkiClient } from "../../../../src/client.ts";

const interval = Number(process.argv[2] ?? 60) * 1000;
const deadline = Date.now() + Number(process.argv[3] ?? 45) * 60_000;
const c = new TenkiClient(process.env.TENKI_API_KEY!);
const owner = await c.resolveOwner();
for (;;) {
	const t = Date.now();
	try {
		const r = await c.control("CreateSession", { ...owner, name: "ck-capacity-probe", cpuCores: 1, memoryMb: 1024, maxDuration: "120s", idleTimeoutMinutes: 2, tags: ["copilotkit-mcp-apps"] });
		const id = (r.session ?? r).id;
		console.log(`${new Date().toISOString()} CAPACITY OK — placed ${id} in ${Date.now() - t}ms`);
		await c.control("TerminateSession", { sessionId: id }).catch(() => {});
		process.exit(0);
	} catch (e) {
		console.log(`${new Date().toISOString()} no capacity: ${(e as Error).message.slice(0, 120)}`);
	}
	if (Date.now() > deadline) process.exit(1);
	await new Promise((r) => setTimeout(r, interval));
}
