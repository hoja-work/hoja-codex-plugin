import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Credentials } from "./credentials.ts";
import type { EnforcementMode } from "../vendor/trebol/.pi/lib/runtime/swarm-builtin-hooks.ts";

const OPTION_ENV: [string, string][] = [
	["HOJA_API_URL", "HOJA_PLUGIN_API_URL"], ["HOJA_MCP_URL", "HOJA_PLUGIN_MCP_URL"], ["HOJA_TOKEN", "HOJA_PLUGIN_TOKEN"],
	["HOJA_PROJECT", "HOJA_PLUGIN_PROJECT"], ["TASK_ENFORCEMENT", "HOJA_PLUGIN_ENFORCEMENT"],
	["TRACE_UPLOAD", "HOJA_PLUGIN_TRACE_UPLOAD"], ["TRACE_DETAIL", "HOJA_PLUGIN_TRACE_DETAIL"],
];
/** Plugin userConfig arrives as HOJA_PLUGIN_* (see .claude-plugin/plugin.json); empty means "not set". */
export function applyUserConfig(env: NodeJS.ProcessEnv = process.env) {
	// Hook command processes receive userConfig as CLAUDE_PLUGIN_OPTION_<KEY> (MCP servers get the HOJA_PLUGIN_* names
	// from plugin.json), so both spellings land in the same place.
	for (const [option, name] of OPTION_ENV) {
		const v = env[`CLAUDE_PLUGIN_OPTION_${option}`]?.trim();
		if (v && !env[name]?.trim()) env[name] = v;
	}
	const set = (from: string, to: string) => { const v = env[from]?.trim(); if (v) env[to] = v; };
	set("HOJA_PLUGIN_API_URL", "HOJA_API_URL");
	set("HOJA_PLUGIN_TOKEN", "HOJA_TOKEN");
	set("HOJA_PLUGIN_PROJECT", "HOJA_PROJECT");
	set("HOJA_PLUGIN_MCP_URL", "HOJA_MCP_URL");
	applyRunCredential(env);
}
/**
 * HOJA-921: a Hoja agent run's own credential, set by the runner (HOJA_RUN_API_TOKEN, HOJA_RUN_API_URL,
 * HOJA_RUN_MCP_URL). It beats everything else on the machine: a token saved in this plugin's userConfig, a
 * HOJA_TOKEN/LINEAR_TOKEN in the environment, and the Hoja CLI's sign-in. On a machine shared by several people
 * any of those may belong to another workspace, and a run must file its work in the workspace that launched it.
 * Returns whether a run credential was applied.
 */
export const RUN_CREDENTIAL_ENV: [string, string][] = [
	["HOJA_RUN_API_TOKEN", "HOJA_TOKEN"], ["HOJA_RUN_API_URL", "HOJA_API_URL"], ["HOJA_RUN_MCP_URL", "HOJA_MCP_URL"],
];
export function applyRunCredential(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!env.HOJA_RUN_API_TOKEN?.trim()) return false;
	for (const [from, to] of RUN_CREDENTIAL_ENV) {
		const v = env[from]?.trim();
		if (v) env[to] = v; else delete env[to];
	}
	for (const name of ["HOJA_PLUGIN_TOKEN", "HOJA_PLUGIN_API_URL", "HOJA_PLUGIN_MCP_URL", "LINEAR_TOKEN", "LINEAR_API_URL"]) {
		delete env[name];
	}
	return true;
}
/** The process's credential: userConfig first, then the environment, then the Hoja CLI's own sign-in. */
export const credentials = new Credentials(process.env);
export function applyCredentials(): Credentials {
	applyUserConfig();
	return credentials.apply();
}
/**
 * Where task journals live; the MCP server and the SessionStart hook must agree. Claude Code gives both
 * CLAUDE_PLUGIN_DATA. Codex gives hooks PLUGIN_DATA but not MCP servers, so the Codex server derives the same
 * directory from its install path (`<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>` →
 * `<CODEX_HOME>/plugins/data/<plugin>-<marketplace>`). HOJA_PLUGIN_DATA pins it explicitly.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env, script = process.argv[1]): string {
	const explicit = env.HOJA_PLUGIN_DATA?.trim() || env.CLAUDE_PLUGIN_DATA?.trim() || env.PLUGIN_DATA?.trim();
	if (explicit) return explicit;
	const host = env.HOJA_PLUGIN_HOST?.trim().toLowerCase();
	// Antigravity gives an installed plugin's hooks and MCP servers the same PLUGIN_DATA (handled above); a plugin
	// loaded from a workspace `.agents/plugins/` gets none, so both fall back to one fixed directory.
	if (host === "antigravity" || host === "agy") return join(homedir(), ".gemini", "antigravity-cli", "plugin-data", "hoja");
	if (host !== "codex") return join(homedir(), ".claude", "plugins", "data", "hoja-standalone");
	const installed = script ? /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/][^\\/]+$/.exec(resolve(dirname(resolve(script)), "..")) : null;
	if (installed) return join(installed[1], "plugins", "data", `${installed[3]}-${installed[2]}`);
	return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "plugins", "data", "hoja-standalone");
}
export function enforcementMode(env: NodeJS.ProcessEnv = process.env): EnforcementMode {
	const v = (env.HOJA_PLUGIN_ENFORCEMENT || env.HOJA_TASK_ENFORCEMENT || "block").trim();
	return v === "advise" || v === "off" ? v : "block";
}
/** Claude Code sets CLAUDE_CODE_ENTRYPOINT=cli for the interactive TUI and sdk-* for `claude -p` / the Agent SDK. */
export const headless = (env: NodeJS.ProcessEnv = process.env) =>
	truthy(env.HOJA_PLUGIN_HEADLESS) || (!!env.CLAUDE_CODE_ENTRYPOINT && env.CLAUDE_CODE_ENTRYPOINT !== "cli");
export const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/** When a finished trace goes to Hoja. `completion`: when a task linked to an issue completes (default). */
export type TraceUpload = "completion" | "session-end" | "manual" | "off";
export function traceUpload(env: NodeJS.ProcessEnv = process.env): TraceUpload {
	const v = (env.HOJA_PLUGIN_TRACE_UPLOAD || env.HOJA_TRACE_UPLOAD || "completion").trim().toLowerCase();
	return v === "session-end" || v === "manual" || v === "off" ? v : "completion";
}
/** How much content a trace keeps. `full`: whole prompts, tool inputs and outputs, secret-scrubbed. */
export type TraceDetail = "full" | "metadata";
export function traceDetail(env: NodeJS.ProcessEnv = process.env): TraceDetail {
	return (env.HOJA_PLUGIN_TRACE_DETAIL || env.HOJA_TRACE_DETAIL || "full").trim().toLowerCase() === "metadata" ? "metadata" : "full";
}
