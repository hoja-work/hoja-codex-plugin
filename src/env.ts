import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Credentials } from "./credentials.ts";
import type { EnforcementMode } from "../vendor/trebol/.pi/lib/runtime/swarm-builtin-hooks.ts";

/** Plugin userConfig arrives as HOJA_PLUGIN_* (see .claude-plugin/plugin.json); empty means "not set". */
export function applyUserConfig(env: NodeJS.ProcessEnv = process.env) {
	const set = (from: string, to: string) => { const v = env[from]?.trim(); if (v) env[to] = v; };
	set("HOJA_PLUGIN_API_URL", "HOJA_API_URL");
	set("HOJA_PLUGIN_TOKEN", "HOJA_TOKEN");
	set("HOJA_PLUGIN_PROJECT", "HOJA_PROJECT");
	set("HOJA_PLUGIN_MCP_URL", "HOJA_MCP_URL");
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
	if (env.HOJA_PLUGIN_HOST?.trim().toLowerCase() !== "codex") return join(homedir(), ".claude", "plugins", "data", "hoja-standalone");
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
