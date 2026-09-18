import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Providers } from "./providers";
import "@copilotkit/react-ui/v2/styles.css";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const TITLE = "Tenki × CopilotKit × Aisa — MCP Apps";
const DESCRIPTION =
	"Real Linux VMs, rendered as interactive MCP Apps inside a CopilotKit agent chat. Sandboxes by Tenki, models by Aisa — bring your own keys, or claim free credits.";

export const metadata: Metadata = {
	metadataBase: new URL("https://tenki.chat"),
	title: TITLE,
	description: DESCRIPTION,
	openGraph: { title: TITLE, description: DESCRIPTION, url: "https://tenki.chat", siteName: "Tenki × CopilotKit × Aisa", type: "website" },
	twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
			<body className="antialiased">
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
