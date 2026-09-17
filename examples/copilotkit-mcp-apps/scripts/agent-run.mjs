// Drive one agent turn through the CopilotKit runtime over AG-UI (same endpoint the chat uses) and print the event stream.
//   node scripts/agent-run.mjs "Run uname -a in a sandbox"
import { randomUUID } from "node:crypto";

const prompt = process.argv.slice(2).join(" ") || "Show me this sandbox is real: run uname -a, nproc and free -m, then summarize the machine in one line.";
const base = process.env.APP_URL || "http://localhost:3000";
const body = {
	threadId: randomUUID(),
	runId: randomUUID(),
	state: {},
	messages: [{ id: randomUUID(), role: "user", content: prompt }],
	tools: [],
	context: [],
	forwardedProps: {},
};
const t0 = Date.now();
const res = await fetch(`${base}/api/copilotkit/agent/default/run`, {
	method: "POST",
	headers: { "content-type": "application/json", accept: "text/event-stream" },
	body: JSON.stringify(body),
});
console.log("HTTP", res.status, res.headers.get("content-type"));
const decoder = new TextDecoder();
let buf = "";
let text = "";
const flushText = () => {
	if (text) console.log(`  💬 ${text.trim()}`);
	text = "";
};
for await (const chunk of res.body) {
	buf += decoder.decode(chunk, { stream: true });
	let i;
	while ((i = buf.indexOf("\n\n")) >= 0) {
		const frame = buf.slice(0, i);
		buf = buf.slice(i + 2);
		const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
		if (!data) continue;
		let ev;
		try { ev = JSON.parse(data); } catch { continue; }
		const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
		if (ev.type === "TEXT_MESSAGE_CONTENT") { text += ev.delta; continue; }
		flushText();
		if (ev.type === "TOOL_CALL_START") console.log(`${s}s 🔧 ${ev.toolCallName}`);
		else if (ev.type === "TOOL_CALL_END") console.log(`${s}s 🔧 args complete`);
		else if (ev.type === "TOOL_CALL_RESULT") console.log(`${s}s 📦 result: ${String(ev.content).slice(0, 160).replace(/\n/g, " ⏎ ")}`);
		else if (ev.type === "ACTIVITY_SNAPSHOT") console.log(`${s}s 🖼  activity ${ev.activityType} → ${ev.content?.resourceUri} (mode=${ev.content?.result?.structuredContent?.mode}, vm=${ev.content?.result?.structuredContent?.sandbox?.cpuCores}vCPU/${ev.content?.result?.structuredContent?.sandbox?.memoryMb}MB, timings=${JSON.stringify(ev.content?.result?.structuredContent?.timings)}, args=${JSON.stringify(ev.content?.toolInput ?? {}).length}B)`);
		else if (["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "TEXT_MESSAGE_START"].includes(ev.type)) console.log(`${s}s ${ev.type}${ev.message ? ": " + ev.message : ""}`);
	}
}
flushText();
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
