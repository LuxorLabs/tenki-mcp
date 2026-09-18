import fs from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Tenki × CopilotKit × Aisa — real Linux VMs, rendered as MCP Apps";

/** Satori renders <img>, not <svg>, so each mark is inlined as a data URI. */
async function dataUri(file: string) {
	const svg = await fs.readFile(path.join(process.cwd(), "public", file), "utf8");
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export default async function Image() {
	const [tenki, copilotkit, aisaIcon, aisaWord] = await Promise.all([
		dataUri("tenki-glyph.svg"),
		dataUri("copilot-kit-logo-white.svg"),
		dataUri("aisa-icon.svg"),
		dataUri("aisa-wordmark-white.svg"),
	]);
	const times = { fontSize: 30, color: "#4f6580", margin: "0 20px" } as const;

	return new ImageResponse(
		(
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					padding: "72px 80px",
					background: "linear-gradient(140deg, #000a15 0%, #06121f 55%, #0a2036 100%)",
					color: "#fff",
					fontFamily: "sans-serif",
				}}
			>
				<div style={{ display: "flex", alignItems: "center" }}>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={tenki} width={54} height={54} alt="" />
					<span style={{ fontSize: 40, fontWeight: 700, marginLeft: 16, letterSpacing: -1 }}>tenki</span>
					<span style={times}>×</span>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={copilotkit} height={38} alt="CopilotKit" />
					<span style={times}>×</span>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={aisaIcon} width={36} height={36} alt="" />
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={aisaWord} height={23} alt="Aisa" style={{ marginLeft: 12 }} />
				</div>

				<div style={{ display: "flex", flexDirection: "column" }}>
					<div style={{ fontSize: 86, fontWeight: 700, lineHeight: 1.05, letterSpacing: -3 }}>Real Linux VMs,</div>
					<div style={{ fontSize: 86, fontWeight: 700, lineHeight: 1.05, letterSpacing: -3, display: "flex" }}>
						<span>rendered as&nbsp;</span>
						<span style={{ color: "#3f9bff" }}>MCP Apps</span>
						<span>.</span>
					</div>
					<div style={{ fontSize: 34, color: "#9fb0c4", marginTop: 28, maxWidth: 940, lineHeight: 1.35 }}>
						Ask for anything that needs a computer. The agent boots a sandbox instantly and the answer comes back as an app you can use.
					</div>
				</div>

				<div style={{ display: "flex", alignItems: "center", fontSize: 28, color: "#5f7690" }}>
					<span style={{ color: "#cfe1f5" }}>tenki.chat</span>
					<span style={{ margin: "0 14px" }}>·</span>
					<span>sandboxes by Tenki · models by Aisa · chat by CopilotKit</span>
				</div>
			</div>
		),
		size,
	);
}
