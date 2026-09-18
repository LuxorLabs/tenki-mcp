"use client";

import { CopilotKit } from "@copilotkit/react-core";
import type { ReactNode } from "react";

import { SettingsDialog, SettingsProvider, useSettings } from "./settings";

/**
 * A visitor's keys ride on every runtime request as headers, so the provider has
 * to sit under the settings state: changing keys re-renders CopilotKit with the
 * new headers, and the next turn runs on them.
 */
function RuntimeProvider({ children }: { children: ReactNode }) {
	const { headers } = useSettings();
	return (
		<CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false} enableInspector={false} useSingleEndpoint={false} headers={headers}>
			{children}
			<SettingsDialog />
		</CopilotKit>
	);
}

export function Providers({ children }: { children: ReactNode }) {
	return (
		<SettingsProvider>
			<RuntimeProvider>{children}</RuntimeProvider>
		</SettingsProvider>
	);
}
