/**
 * The agent host this adapter runs under. The vendored Trebol code is host-agnostic; only names and hook wire shapes
 * differ. Claude Code is the default; the Codex plugin sets HOJA_PLUGIN_HOST=codex on its MCP server and hooks.
 */
export type Host = "claude" | "codex" | "antigravity";

export interface HostProfile {
	host: Host;
	/** How the host names this plugin's own MCP tools (Pi registers them bare). */
	ownToolPrefixes: readonly string[];
	/** How the host names the hosted Hoja API proxy's tools (Pi: `mcp__hoja__`). */
	apiToolPrefixes: readonly string[];
	/** Host-native tools that are Pi's `Bash` (Codex runs shell as exec_command/shell; its hooks already say Bash). */
	bashAliases: readonly string[];
}

const PROFILES: Record<Host, HostProfile> = {
	// Claude Code may normalize the server name's hyphen.
	claude: { host: "claude", ownToolPrefixes: ["mcp__plugin_hoja_hoja__"], apiToolPrefixes: ["mcp__plugin_hoja_hoja-api__", "mcp__plugin_hoja_hoja_api__"], bashAliases: [] },
	codex: { host: "codex", ownToolPrefixes: ["mcp__hoja__"], apiToolPrefixes: ["mcp__hoja_api__", "mcp__hoja-api__"], bashAliases: ["exec_command", "shell", "local_shell", "container.exec"] },
	// Antigravity names a plugin's MCP server `<plugin>_<server>` and wraps every MCP call in `call_mcp_tool`; agy.ts
	// unwraps it to `mcp__<ServerName>__<ToolName>`. Its shell tool is `run_command`.
	antigravity: { host: "antigravity", ownToolPrefixes: ["mcp__hoja_hoja__"], apiToolPrefixes: ["mcp__hoja_hoja-api__", "mcp__hoja_hoja_api__"], bashAliases: ["run_command"] },
};

export const hostOf = (env: NodeJS.ProcessEnv = process.env): Host => {
	const v = env.HOJA_PLUGIN_HOST?.trim().toLowerCase();
	return v === "codex" ? "codex" : v === "antigravity" || v === "agy" ? "antigravity" : "claude";
};
export const profile = (env: NodeJS.ProcessEnv = process.env): HostProfile => PROFILES[hostOf(env)];
