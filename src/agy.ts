/**
 * Antigravity CLI (`agy`) ↔ the hook bridge.
 *
 * Antigravity's hooks differ from Claude Code's and Codex's in shape, not in substance (agy 1.5.14, probed):
 *  - command hooks only, camelCase payloads: `conversationId`, `transcriptPath`, `toolCall {id, name, args}`, `stepIdx`;
 *  - events SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop. `PreInvocation` with
 *    `invocationNum: 0` is the first model call of a user turn, which is where Claude Code's UserPromptSubmit sits;
 *    `PostInvocation` fires after a batch of tool calls, which is Claude Code's PostToolBatch;
 *  - PreToolUse must always answer a decision: `{}` is treated as a deny. `ask` defers to Antigravity's own
 *    permissions (cached grants and policy), so it is the neutral answer; the gate only ever adds `deny`, and the
 *    plugin answers `allow` only for its own TaskManage and read-only tools (selfApproved);
 *  - every MCP call arrives as `call_mcp_tool {ServerName, ToolName, Arguments}`, and a plugin's server is named
 *    `<plugin>_<server>` (`hoja_hoja`);
 *  - built-in tools have their own names and argument keys (`run_command {CommandLine}`, `write_file {Path, Content}`).
 *
 * This module is pure: the hook client (agy-hook.ts) and the tests use it, and the bridge never sees an agy shape.
 */

type Json = Record<string, any>;

/** Antigravity built-ins → the names Trebol's classifier knows, with the argument that classification reads. */
const BUILTINS: Record<string, { name: string; args?: (a: Json) => Json }> = {
	run_command: { name: "Bash", args: a => ({ ...a, command: a.CommandLine ?? a.command }) },
	read_file: { name: "Read", args: a => ({ ...a, file_path: a.Path ?? a.AbsolutePath }) },
	view_file: { name: "Read", args: a => ({ ...a, file_path: a.Path ?? a.AbsolutePath }) },
	list_dir: { name: "LS", args: a => ({ ...a, path: a.Path ?? a.DirectoryPath }) },
	list_directory: { name: "LS", args: a => ({ ...a, path: a.Path ?? a.DirectoryPath }) },
	grep_search: { name: "Grep", args: a => ({ ...a, pattern: a.Query ?? a.Pattern }) },
	find_by_name: { name: "Glob", args: a => ({ ...a, pattern: a.Pattern ?? a.Name }) },
	glob: { name: "Glob" },
	code_search: { name: "CodeSearch" },
	search_web: { name: "WebSearch", args: a => ({ ...a, query: a.Query ?? a.query }) },
	read_url_content: { name: "WebFetch", args: a => ({ ...a, url: a.Url ?? a.url }) },
	tool_search: { name: "ToolSearch" },
	write_file: { name: "Write", args: a => ({ ...a, file_path: a.Path ?? a.TargetFile, content: a.Content }) },
	edit_file: { name: "Edit", args: a => ({ ...a, file_path: a.Path ?? a.TargetFile }) },
	replace_file_content: { name: "Edit", args: a => ({ ...a, file_path: a.Path ?? a.TargetFile }) },
	multi_replace_file_content: { name: "MultiEdit", args: a => ({ ...a, file_path: a.Path ?? a.TargetFile }) },
	apply_patch: { name: "Edit" },
};

/** Antigravity tools that only read or only talk to the user; the gate never blocks them (host-policy.ts). */
export const AGY_READ_ONLY = ["command_status", "read_terminal", "view_code_item", "ask_question", "notify_user", "task_boundary", "read_resource", "list_resources"];

export interface ToolCall { tool_name: string; tool_input: Json; tool_use_id?: string }

/** `toolCall` from an agy hook → the Claude-shaped name and input the bridge classifies. */
export function agyToolCall(call: Json | undefined): ToolCall {
	const name = String(call?.name ?? "");
	const args: Json = call?.args && typeof call.args === "object" ? call.args : {};
	const id = typeof call?.id === "string" ? call.id : undefined;
	if (name === "call_mcp_tool") {
		const server = String(args.ServerName ?? "");
		const tool = String(args.ToolName ?? "");
		const input = args.Arguments && typeof args.Arguments === "object" ? args.Arguments : typeof args.Arguments === "string" ? safeJson(args.Arguments) : {};
		return { tool_name: `mcp__${server}__${tool}`, tool_input: input, tool_use_id: id };
	}
	const builtin = BUILTINS[name];
	if (!builtin) return { tool_name: name, tool_input: args, tool_use_id: id };
	return { tool_name: builtin.name, tool_input: builtin.args ? builtin.args(args) : args, tool_use_id: id };
}

const safeJson = (s: string): Json => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

/** The fields every bridge event carries, from an agy payload. */
export function agyBase(p: Json): Json {
	return {
		session_id: p.conversationId,
		transcript_path: p.transcriptPath,
		cwd: p.cwd ?? (Array.isArray(p.workspacePaths) ? p.workspacePaths[0] : undefined),
		model: p.modelName,
	};
}

/** One agy hook payload → the bridge event (Claude Code's vocabulary) and its payload. */
export function agyToBridge(event: string, p: Json): { event: string; payload: Json } {
	const base = agyBase(p);
	switch (event) {
		case "PreToolUse": return { event, payload: { ...base, ...agyToolCall(p.toolCall), step_idx: p.stepIdx } };
		case "PostToolUse": {
			const failed = typeof p.error === "string" && p.error !== "";
			return { event: failed ? "PostToolUseFailure" : "PostToolUse", payload: { ...base, ...agyToolCall(p.toolCall), step_idx: p.stepIdx, ...(failed ? { error: p.error } : { tool_response: "" }) } };
		}
		case "PreInvocation":
			// invocationNum is 0 (or omitted, protojson drops zero) on the first model call of a user turn.
			return Number(p.invocationNum ?? 0) === 0
				? { event: "UserPromptSubmit", payload: { ...base, prompt: typeof p.lastUserInput === "string" ? p.lastUserInput : "", invocation_num: 0 } }
				: { event: "PreInvocation", payload: { ...base, invocation_num: p.invocationNum } };
		case "PostInvocation": return { event: "PostToolBatch", payload: { ...base, invocation_num: p.invocationNum } };
		case "Stop": return { event: "Stop", payload: { ...base, stop_hook_active: p.continuationActive === true, termination_reason: p.terminationReason, error: p.error || undefined } };
		default: return { event, payload: base };
	}
}

const systemStep = (text: string) => ({ systemMessage: { systemMessage: text } });

/**
 * This plugin's own tools that it lets through without a confirmation: TaskManage (the gate's only exit) and the
 * read-only ones. In `agy -p` an MCP call that needs confirmation is soft-denied (probed), so without this the gate
 * would block a write, point the model at TaskManage, and print mode would refuse TaskManage too. Hosted Hoja API
 * tools and every other tool still go through Antigravity's own permissions ("ask").
 */
const OWN_SERVER = /^mcp__hoja_hoja__/;
export function selfApproved(toolName: string, input: Json): boolean {
	if (!OWN_SERVER.test(toolName)) return false;
	const tool = toolName.replace(OWN_SERVER, "");
	if (tool === "TaskManage" || tool === "hoja_setup" || tool === "hoja_list" || tool === "hoja_get") return true;
	if (tool === "hoja_trace") return input?.action !== "upload";
	if (tool === "hoja_project") return input?.action == null || input?.action === "list";
	return false;
}

/** The bridge's answer (Claude Code's shapes) → what the agy hook must print. `call` is the translated tool call. */
export function bridgeToAgy(event: string, out: Json, call?: ToolCall): Json {
	const hso = out?.hookSpecificOutput ?? {};
	switch (event) {
		case "PreToolUse":
			if (hso.permissionDecision === "deny") return { decision: "deny", reason: String(hso.permissionDecisionReason ?? "Blocked by the Hoja task gate.") };
			return call && selfApproved(call.tool_name, call.tool_input) ? { decision: "allow" } : { decision: "ask" };
		case "PreInvocation":
			// A local command (`hoja:tasks`) is answered here and the turn ends before the model is called.
			if (out?.decision === "block") return { injectSteps: [systemStep(String(out.reason ?? ""))], terminationBehavior: "terminate" };
			return hso.additionalContext ? { injectSteps: [systemStep(String(hso.additionalContext))] } : {};
		case "PostInvocation":
			return hso.additionalContext ? { injectSteps: [systemStep(String(hso.additionalContext))] } : {};
		case "Stop":
			return out?.decision === "continue" ? { decision: "continue", reason: String(out.reason ?? "") } : {};
		default:
			return {};
	}
}

/** What a hook prints when the plugin's server cannot be reached: never block, never auto-approve. */
export const failOpen = (event: string): Json => event === "PreToolUse" ? { decision: "ask" } : {};

/** `brain/<id>` → `brain/<id>/.system_generated/logs/transcript_full.jsonl`, the file agy hooks name. */
export const transcriptFromArtifacts = (artifactsDir: string) => `${artifactsDir.replace(/\/+$/, "")}/.system_generated/logs/transcript_full.jsonl`;
