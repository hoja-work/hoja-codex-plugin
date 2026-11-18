/**
 * Adapter-side policy for the two things Claude Code does differently from Pi:
 *
 *  1. **Slash commands.** Pi registers `/tasks` and `/hoja` and never sends their text to the model. Claude Code only
 *     offers `UserPromptExpansion` to a plugin's commands, and the command name it reports varies (`setup`,
 *     `hoja:setup`, `/hoja:setup`). Both the name normalization and a `UserPromptSubmit` fallback live here so a
 *     command is answered locally even when the expansion hook does not fire.
 *  2. **Read-only discovery tools.** Trebol's classifier (vendor/trebol/.pi/lib/runtime/swarm-toolclass.ts) knows the
 *     read-only tools of *its own* runtime: `hoja_list`/`hoja_get`, context retrieval and history. Claude Code also
 *     gives the model the hosted Hoja API (70+ tools) and `hoja_project`, which the gate would otherwise refuse — a
 *     health check could not run without filing an issue first. The allowlist below names exactly the calls that only
 *     read, and a Bash command is re-classified after dropping pure file-descriptor redirections (`2>&1`,
 *     `>/dev/null`), which Trebol's tokenizer reads as a second, unknown command.
 *
 * Anything not listed here keeps Trebol's decision unchanged; this is the only place the adapter widens the gate.
 */

/** `mcp__hoja__hoja_viewer` → `hojoviewer`; Trebol normalizes the same way (strip `_`, lowercase). */
const bare = (name: string) => name.replace(/^mcp__[A-Za-z0-9_-]+__/, "");
export const policyName = (name: string) => bare(name).replace(/_/g, "").toLowerCase();

/**
 * Hosted Hoja API + plugin tools whose every argument shape only reads. The mutating member of each family is
 * deliberately absent (`hoja_issueCreate`, `hoja_taskUpdate`, `hoja_commentCreate`, `hoja_extensionActionRun`,
 * `hoja_notificationMarkRead`, `hoja_taskDecisionAnswer`, …), and the tests assert those stay gated.
 */
export const READ_ONLY_HOST_TOOLS: readonly string[] = [
	// this plugin's own tools (Trebol already allows hoja_list/hoja_get; hoja_project is action-gated below)
	"hoja_list", "hoja_get", "hoja_setup",
	// identity, workspace, teams
	"hoja_viewer", "hoja_workspace", "hoja_organizationMembers", "hoja_teams", "hoja_team",
	// issues and tasks
	"hoja_issues", "hoja_issue", "hoja_searchIssues", "hoja_myIssueActivity",
	"hoja_tasks", "hoja_task", "hoja_searchTasks", "hoja_myTaskActivity",
	// projects, initiatives, cycles, workflow states, labels
	"hoja_projects", "hoja_projectUpdates", "hoja_initiatives", "hoja_initiative",
	"hoja_cycles", "hoja_cycle", "hoja_teamCycleCadence", "hoja_workflowStates",
	"hoja_issueLabels", "hoja_taskLabels",
	// decisions (read) and inbox
	"hoja_issueDecisions", "hoja_issueDecision", "hoja_taskDecisions", "hoja_taskDecision",
	"hoja_inboxNotifications", "hoja_inboxUnreadCount",
	// extension action catalogue (running one is hoja_extensionActionRun and stays gated)
	"hoja_extensionActions",
];
const READ_ONLY_HOST = new Set(READ_ONLY_HOST_TOOLS.map(policyName));

/** `hoja_project` reads with `action: "list"` (its default) and writes with `select`/`create`. */
export const isAdapterReadOnlyTool = (toolName: string, params: unknown): boolean => {
	const name = policyName(toolName);
	if (name === "hojaproject") {
		const action = (params as any)?.action;
		return action == null || action === "list";
	}
	return READ_ONLY_HOST.has(name);
};

/**
 * Pure file-descriptor redirections carry no write: `2>&1`, `1>&2`, `2>/dev/null`, `&>/dev/null`, `>/dev/null`,
 * `2>&-`. Trebol's `parseShellCommands` treats the `&` in `2>&1` as a command separator, so `cat file 2>&1` looks
 * like two simple commands and `1` is not an allowlisted binary. Removing just these tokens keeps the classifier's
 * allowlist semantics intact — a redirect to a real file is left in place and still blocks.
 */
export const stripFdRedirections = (command: string): string =>
	command
		.replace(/(?:^|(?<=[\s;|&]))(\d*|&)>>?\s*&(?:(\d+)|-)/g, " ")
		.replace(/(?:^|(?<=[\s;|&]))(\d*|&)>>?\s*\/dev\/null/g, " ")
		.replace(/[ \t]{2,}/g, " ")
		.trim();

/** A Bash call is read-only when Trebol says so before or after dropping pure redirections. */
export const bashReadOnlyCommand = (command: string): string =>
	stripFdRedirections(command).trim().replace(/\s+$/, "");

/**
 * `/hoja:setup`, `hoja:setup`, `/setup`, `plugin:hoja:setup`, `Plugin:Hoja:Setup` → `setup`.
 * Claude Code has reported the command name with and without the `/` and the plugin prefix.
 */
export const normalizeCommandName = (raw: unknown): string =>
	String(raw ?? "").trim().toLowerCase()
		.replace(/^\//, "")
		.replace(/^plugin:[a-z0-9_-]+:/, "")
		.replace(/^[a-z0-9_-]+:/, "");

/** `/hoja:tasks`, `hoja:hoja on`, `/hoja:setup` — the exact shapes a user types for a registered command. */
const LOCAL_COMMAND = /^\s*\/?hoja:([a-z][\w-]*)(?:\s+([\s\S]*))?$/i;
export const localCommandOf = (prompt: string): { name: string; args: string } | undefined => {
	const match = LOCAL_COMMAND.exec(prompt);
	return match ? { name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" } : undefined;
};
