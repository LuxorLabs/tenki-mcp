/** Every `LUXORAI_<suffix>` is tried (in order) before any legacy `TENKI_<suffix>`. Empty values fall through. */
export function readEnv(...suffixes: string[]): string | undefined {
	for (const prefix of ["LUXORAI_", "TENKI_"]) {
		for (const suffix of suffixes) {
			const value = process.env[`${prefix}${suffix}`];
			if (value) return value;
		}
	}
	return undefined;
}

/** The env var name {@link readEnv} resolved, for diagnostics. */
export function resolvedEnvName(env: NodeJS.ProcessEnv, ...suffixes: string[]): string | undefined {
	for (const prefix of ["LUXORAI_", "TENKI_"]) {
		for (const suffix of suffixes) {
			if (env[`${prefix}${suffix}`]?.trim()) return `${prefix}${suffix}`;
		}
	}
	return undefined;
}

/** API keys carry `lx_` (Luxor AI) or the legacy `tk_` prefix. */
export function isApiKey(token: string): boolean {
	return token.startsWith("lx_") || token.startsWith("tk_");
}
