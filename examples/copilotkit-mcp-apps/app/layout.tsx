import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/v2/styles.css";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
	title: "Tenki × CopilotKit — MCP Apps",
	description: "Real Tenki Sandboxes, rendered as interactive MCP Apps inside a CopilotKit agent chat.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
			<body className="antialiased">
				<CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false} enableInspector={false} useSingleEndpoint={false}>
					{children}
				</CopilotKit>
			</body>
		</html>
	);
}
