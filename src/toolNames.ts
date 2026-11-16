import { readEnv } from "./env.js";
import { TOOL_TITLES } from "./tools/titles.js";

const LEGACY_PREFIX = "tenki_";

/** `LUXOR_MCP_TOOL_PREFIX=luxor` advertises every tool as `luxor_*`; unset or any other value keeps `tenki_*`. */
export const TOOL_PREFIX: "tenki" | "luxor" = (readEnv("MCP_TOOL_PREFIX") ?? "").trim().toLowerCase() === "luxor" ? "luxor" : "tenki";

/** The advertised name for a tool registered under its canonical `tenki_*` name. */
export function toolName(name: string): string {
	return TOOL_PREFIX === "luxor" && name.startsWith(LEGACY_PREFIX) ? `luxor_${name.slice(LEGACY_PREFIX.length)}` : name;
}

// Longest names first so `tenki_exec` never matches inside `tenki_exec_foo`.
const KNOWN_TOOLS = new RegExp(
	`\\b(${Object.keys(TOOL_TITLES)
		.sort((a, b) => b.length - a.length)
		.join("|")})\\b`,
	"g",
);

/** Rewrite the tool names mentioned in text to their advertised names. */
export function withToolNames(text: string): string {
	return TOOL_PREFIX === "luxor" ? text.replace(KNOWN_TOOLS, toolName) : text;
}
