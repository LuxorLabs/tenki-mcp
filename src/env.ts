/** API keys carry `lx_` (Luxor AI) or the legacy `tk_` prefix. */
export function isApiKey(token: string): boolean {
	return token.startsWith("lx_") || token.startsWith("tk_");
}

/** `LUXOR_API_KEY` is also the Luxor Mining Pool key name, so it only counts with an `lx_`/`tk_` value. */
function usable(name: string, value: string | undefined): value is string {
	const trimmed = value?.trim();
	if (!trimmed) return false;
	return name !== "LUXOR_API_KEY" || isApiKey(trimmed);
}

/** The env var name {@link readEnv} resolved, for diagnostics. */
export function resolvedEnvName(env: NodeJS.ProcessEnv, ...suffixes: string[]): string | undefined {
	for (const prefix of ["LUXOR_", "TENKI_"]) {
		for (const suffix of suffixes) {
			const name = `${prefix}${suffix}`;
			if (usable(name, env[name])) return name;
		}
	}
	return undefined;
}

/** Every `LUXOR_<suffix>` is tried (in order) before any legacy `TENKI_<suffix>`. Empty or blank values fall through. */
export function readEnv(...suffixes: string[]): string | undefined {
	const name = resolvedEnvName(process.env, ...suffixes);
	return name ? process.env[name] : undefined;
}
