/**
 * Claude Code / Codex hooks → Trebol's Pi lifecycle and Swarm builtin hook pipeline.
 *
 * This is the Claude-side counterpart of Trebol's `.pi/lib/runtime/swarm-builtin-hooks-runtime.ts` (which binds the
 * same vendored pipeline to Pi events). Every decision is made by vendored code; this file only moves bytes:
 *
 *   Pi event                         Claude Code hook         what crosses
 *   session_start / session_switch   SessionStart (+ lazy)    journal replay
 *   input + before_agent_start       UserPromptSubmit         onUserPrompt → additionalContext
 *   tool_call (block / pre-context)  PreToolUse               deny + reason  |  additionalContext
 *   tool_result                      PostToolUse(+Failure)    postTool (context queued for the turn)
 *   turn_end (one hook message)      PostToolBatch            flushTurn → additionalContext
 *   agent_before_settle (gate resume)Stop                     decision:"block" + continuation | systemMessage
 *   session_shutdown                 SessionEnd
 *   registerCommand                  UserPromptExpansion      decision:"block" + reason (local command, no model turn)
 *
 * Codex has the same hook model with three gaps, bridged here: no PostToolBatch (the turn flushes on the PostToolUse
 * that settles the last in-flight call), no UserPromptExpansion (local commands are matched in UserPromptSubmit, which
 * can block a prompt the same way), and Stop continues via decision:"block" (Codex turns the reason into the
 * continuation prompt, Pi's followUp) because Codex's Stop has no additionalContext.
 */
import {
	createSwarmBuiltinPipeline, hasFocusedTask, AUTOGEN_BUDGET_SOURCE,
	type EnforcementMode, type HookTask, type PreToolHook, type SwarmHookPipeline, type ToolCallEvent,
} from "../vendor/trebol/.pi/lib/runtime/swarm-builtin-hooks.ts";
import { formatHookContext } from "../vendor/trebol/.pi/lib/policy/swarm-annoyance-nudge.ts";
import { sleepBlockReason } from "../vendor/trebol/.pi/lib/policy/swarm-sleep-blocker.ts";
import { STDIN_CONFLICT_HOOK_NAME, StdinConflictHook } from "../vendor/trebol/.pi/lib/runtime/swarm-stdin-conflict.ts";
import { TaskGateResumeBudget, evaluateTaskGateResume } from "../vendor/trebol/.pi/lib/runtime/task-gate-resume.ts";
import type { TaskManager } from "../vendor/trebol/packages/tools/taskmanage/src/task-manage.ts";
import { canonicalToolName, isOwnTool, type PiMessage } from "./transcript.ts";
import { bashReadOnlyCommand, isAdapterReadOnlyTool, localCommandOf, normalizeCommandName } from "./host-policy.ts";
import { hostOf, type Host } from "./host.ts";
import type { PiShim } from "./pi-shim.ts";
import type { TraceRecorder } from "./trace/recorder.ts";

export interface BridgeOptions {
	/** Trebol's taskmanage extension registers the pipeline in "block" mode; HOJA_TASK_ENFORCEMENT overrides. */
	enforcementMode?: EnforcementMode;
	/** `swarm -p` semantics (message.after_receive) for headless runs; the interactive TUI path otherwise. */
	headless?: boolean;
	/** Autogenskills is a separate Trebol extension; its hooks name Pi tools (SkillManage) that Claude Code lacks. */
	autogenSkills?: boolean;
	/** Which host's hook wire shapes to speak; defaults to HOJA_PLUGIN_HOST. */
	host?: Host;
	/** Session tracing: every hook event, with the bridge's own answer, is handed to the recorder. */
	recorder?: TraceRecorder;
}

export type HookPayload = Record<string, any>;
export type HookOutput = Record<string, unknown>;

/**
 * Claude Code host tools with no Pi counterpart that only load tool schemas. Pi has every schema in the prompt, so
 * loading one is not "acting"; gating it could deadlock the gate (the only route to TaskManage would be blocked).
 */
export const HOST_SCHEMA_LOADERS = new Set(["ToolSearch"]);

const parse = (value: unknown) => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed || !/^[\[{"]/.test(trimmed)) return value;
	try { return JSON.parse(trimmed); } catch { return value; }
};
/** The text a Pi tool_result carries, from Claude's tool_response (string, MCP content array, or a structured object). */
export function responseText(response: unknown): string {
	const value = parse(response);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part: any) => typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : "").filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		const v = value as any;
		if (typeof v.stdout === "string" || typeof v.stderr === "string") return [v.stdout, v.stderr].filter((s: unknown) => typeof s === "string" && s).join("\n");
		if (Array.isArray(v.content)) return responseText(v.content);
		if (typeof v.output === "string") return v.output;
		return JSON.stringify(value);
	}
	return value == null ? "" : String(value);
}

export class HookBridge {
	readonly pipeline: SwarmHookPipeline;
	private readonly gateResume = new TaskGateResumeBudget();
	private subagent = false;
	private startedPostActingSession = "";
	private readonly pendingToolCallIds = new Map<string, string[]>();
	private readonly headless: boolean;
	private readonly recorder?: TraceRecorder;
	private readonly host: Host;
	/** Codex: PreToolUse calls not yet settled by PostToolUse, so the turn flushes once per tool batch. */
	private readonly inFlight = new Set<string>();

	constructor(private readonly shim: PiShim, private readonly manager: TaskManager, options: BridgeOptions = {}) {
		const stdinConflict = new StdinConflictHook();
		const bashPre = (name: string, decide: (command: string | undefined) => { block?: string; message?: string } | undefined): PreToolHook => ({
			name,
			run: (event: ToolCallEvent) => {
				if (event.toolName !== "bash" && event.toolName !== "Bash") return {};
				const r = decide(event.params?.command);
				if (!r) return {};
				return r.block ? { block: true, message: r.block } : { message: r.message };
			},
		});
		const mode = options.enforcementMode ?? "block";
		this.headless = options.headless ?? false;
		this.recorder = options.recorder;
		this.host = options.host ?? hostOf();
		// Without the autogenskills extension Trebol never installs this source, and the vendored fallback counter
		// ("only supports standalone pipeline tests") would block every 5th call until a Skill runs. A source that never
		// blocks is exactly "autogenskills extension absent".
		if (!options.autogenSkills && !(globalThis as any)[AUTOGEN_BUDGET_SOURCE])
			(globalThis as any)[AUTOGEN_BUDGET_SOURCE] = { gateTool: () => undefined, budgetStatus: () => ({ used: 0, budget: Infinity }) };
		this.pipeline = createSwarmBuiltinPipeline({
			session: () => this.shim.sessionId || "session",
			tasks: () => this.tasks(),
			isSubAgent: () => this.subagent || process.env.PI_SWARM_SUBAGENT === "1",
			enforcementMode: mode,
			completion: { enabled: mode !== "off", toolThreshold: 8, maxNudges: 3 },
			extraPre: [
				bashPre("sleep-blocker", command => { const reason = sleepBlockReason(command); return reason ? { block: reason } : undefined; }),
				bashPre(STDIN_CONFLICT_HOOK_NAME, command => { const c = stdinConflict.onBashCommand(command); if (!c) return undefined; return "block" in c ? { block: c.block } : { message: c.advise }; }),
			],
			extraPost: [],
		});
		if (!options.autogenSkills) (this.pipeline as any).hooks.lifecycle.onToolAfter = () => ({});
	}

	/** Tasks as the Swarm hooks see them (swarm-builtin-hooks-runtime.ts hookTasks). */
	tasks(): HookTask[] {
		return this.manager.snapshot().tasks.filter(t => t.status !== "deleted").map(t => ({
			id: String(t.id), subject: String(t.subject ?? ""), status: String(t.status ?? ""), active: t.active === true,
			category: t.category, owner: t.owner_id, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
		}));
	}

	/** The tool_use_id of the PreToolUse that preceded an MCP call to one of our own tools (FIFO per tool). */
	takeToolCallId(tool: string): string | undefined { return this.pendingToolCallIds.get(tool)?.shift(); }

	private async bind(payload: HookPayload) {
		if (typeof payload.session_id === "string" && payload.session_id)
			await this.shim.bindSession(payload.session_id, payload.transcript_path || undefined, payload.cwd || undefined);
		this.subagent = typeof payload.agent_id === "string" && payload.agent_id !== "";
	}

	async handle(event: string, input: HookPayload): Promise<HookOutput> {
		// A host leaves a placeholder unexpanded (or null) when the event lacks that field; that means "absent".
		const payload = Object.fromEntries(Object.entries(input).filter(([, v]) => v != null && !(typeof v === "string" && /^\$\{[\w.]+\}$/.test(v))));
		await this.bind(payload);
		const output = await this.dispatch(event, payload);
		if (this.recorder) {
			const text = event === "PostToolUse" ? responseText(payload.tool_response) : event === "PostToolUseFailure" ? responseText(payload.error ?? payload.tool_response) : undefined;
			this.recorder.record(this.shim.sessionId, event, { ...payload, tool_input: parse(payload.tool_input) }, output, text);
		}
		return output;
	}

	private async dispatch(event: string, payload: HookPayload): Promise<HookOutput> {
		switch (event) {
			case "SessionStart": return {};
			case "SessionEnd": await this.shim.emit("session_shutdown"); return {};
			case "UserPromptSubmit": return this.userPrompt(payload);
			case "UserPromptExpansion": return this.command(payload);
			case "PreToolUse": return this.preTool(payload);
			case "PostToolUse": return this.postTool(payload, false);
			case "PostToolUseFailure": return this.postTool(payload, true);
			case "PostToolBatch": return this.turnEnd();
			case "Stop": return this.stop(payload);
			// Observed for tracing only: SubagentStart/Stop, PreCompact/PostCompact, Notification, StopFailure,
			// PermissionDenied. None of them has a Trebol counterpart, so the answer is always "no change".
			default: return {};
		}
	}

	private async userPrompt(payload: HookPayload): Promise<HookOutput> {
		const session = this.shim.sessionId || "session";
		const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
		this.inFlight.clear();
		// A registered command answered here as well as in UserPromptExpansion. Codex has no UserPromptExpansion at all
		// (its TUI rejects unknown `/` commands), and Claude Code fails open when the expansion hook cannot run — either
		// way the command's fallback .md body must never become the model's job. Same output, same block shape.
		const local = localCommandOf(prompt);
		if (local && this.shim.commands.has(local.name)) return this.command({ command_name: local.name, command_args: local.args });
		// A real user turn is outside intervention and refills the gate auto-continue budget.
		this.gateResume.reset(session);
		await this.shim.emit("input", { text: prompt, source: this.headless ? "rpc" : "interactive" });
		await this.shim.emit("before_agent_start", { prompt, systemPrompt: "" });
		const hooks = (this.pipeline as any).hooks;
		if (this.startedPostActingSession !== session) {
			this.startedPostActingSession = session;
			hooks.postActing?.startSession(this.tasks());
		}
		if (this.headless) {
			hooks.enforcement.onUserMessage(prompt);
			hooks.maintenance.onUserMessage(this.tasks(), this.pipeline.budget, session);
		}
		const { injected } = this.pipeline.onUserPrompt({ messageAfterReceive: this.headless, prompt });
		return injected ? context("UserPromptSubmit", formatHookContext("user_prompt_submit", injected)) : {};
	}

	private async preTool(payload: HookPayload): Promise<HookOutput> {
		const raw = String(payload.tool_name ?? "");
		const toolName = canonicalToolName(raw);
		const params = parse(payload.tool_input) ?? {};
		const toolCallId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
		if (isOwnTool(raw) && toolCallId) this.pendingToolCallIds.set(toolName, [...(this.pendingToolCallIds.get(toolName) ?? []), toolCallId]);
		await this.shim.emit("tool_call", { toolName, toolCallId, input: params });
		if (HOST_SCHEMA_LOADERS.has(toolName)) return {};
		// Read-only discovery (hosted Hoja API reads, hoja_project list, hoja_setup) is exempt in the adapter: Trebol's
		// classifier only knows its own runtime's read tools, and gating these made a health check impossible without
		// filing an issue. The exemption is a skip of the whole pre-tool chain, like Trebol's own read-only branch.
		if (isAdapterReadOnlyTool(toolName, params)) { this.inFlight.add(toolCallId ?? `anon-${this.inFlight.size}`); return {}; }
		// Bash: pure file-descriptor redirections (`2>&1`, `>/dev/null`) are stripped before classification because
		// Trebol's tokenizer reads the `&` in `2>&1` as a command separator. Nothing executable changes.
		const policy = toolName === "Bash" && typeof (params as any)?.command === "string"
			? { ...params, command: bashReadOnlyCommand((params as any).command) }
			: params;
		const { block, context: pre } = this.pipeline.preTool({ toolName, params: policy, toolCallId });
		if (block) {
			if (isOwnTool(raw)) this.takeToolCallId(toolName);
			return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: block } };
		}
		this.inFlight.add(toolCallId ?? `anon-${this.inFlight.size}`);
		// Pi prefixes pre-context onto the tool result; Claude Code delivers additionalContext alongside the result.
		return pre ? context("PreToolUse", pre) : {};
	}

	private async postTool(payload: HookPayload, failed: boolean): Promise<HookOutput> {
		const raw = String(payload.tool_name ?? "");
		const toolName = canonicalToolName(raw);
		const params = parse(payload.tool_input) ?? {};
		const toolCallId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
		const output = failed ? responseText(payload.error ?? payload.tool_response) : responseText(payload.tool_response);
		// Our own tools already ran Pi's tool_result chain in-process (server.ts), where it can still rewrite the result.
		if (!isOwnTool(raw))
			await this.shim.emit("tool_result", { toolName, toolCallId, input: params, content: [{ type: "text", text: output }], isError: failed });
		if (HOST_SCHEMA_LOADERS.has(toolName)) return {};
		this.pipeline.postTool({ toolName, params, toolCallId, failed, output });
		if (this.host !== "codex") return {};
		if (toolCallId && this.inFlight.has(toolCallId)) this.inFlight.delete(toolCallId);
		else this.inFlight.delete(this.inFlight.values().next().value!);
		return this.inFlight.size === 0 ? this.turnEnd("PostToolUse") : {};
	}

	private async turnEnd(hookEventName = "PostToolBatch"): Promise<HookOutput> {
		await this.shim.emit("turn_end");
		const content = this.pipeline.flushTurn();
		return content ? context(hookEventName, content) : {};
	}

	private stop(payload: HookPayload): HookOutput {
		if (this.subagent || process.env.PI_SWARM_SUBAGENT === "1") return {};
		const session = this.shim.sessionId || "session";
		const messages: PiMessage[] = [...this.shim.transcript.messages()];
		const last = messages.at(-1);
		// Stop fires once Claude's final message ended the turn; the transcript may not have flushed it yet.
		if (!(last?.role === "assistant" && last.stopReason === "stop"))
			messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: String(payload.last_assistant_message ?? "") }] });
		const decision = evaluateTaskGateResume({ session, messages, taskFocused: hasFocusedTask(this.tasks()), budget: this.gateResume });
		// Pi appends the continuation as a hidden custom message; Stop additionalContext continues the turn the same way
		// (bounded by the vendored budget plus Claude Code's own continuation cap) without flagging a hook error.
		if (decision.action === "continue" && decision.content)
			return this.host === "codex" ? { decision: "block", reason: decision.content } : context("Stop", decision.content);
		if (decision.action === "exhausted" && decision.content) return { systemMessage: decision.content };
		return {};
	}

	private async command(payload: HookPayload): Promise<HookOutput> {
		// `setup`, `hoja:setup`, `/hoja:setup`, `plugin:hoja:setup` all name the same registered command.
		const name = normalizeCommandName(payload.command_name ?? payload.name);
		const command = this.shim.commands.get(name);
		if (!command) return {};
		const before = this.shim.notifications.length;
		let returned: unknown;
		try { returned = await command.handler(String(payload.command_args ?? ""), this.shim.ctx()); }
		catch (error) { returned = `/${name} failed: ${(error as Error).message}`; }
		const notes = this.shim.notifications.slice(before).map(n => n.message);
		const text = [typeof returned === "string" ? returned : "", ...notes].filter(Boolean).join("\n");
		return { decision: "block", reason: text || `/${name} done.` };
	}
}

const context = (hookEventName: string, additionalContext: string): HookOutput => ({ hookSpecificOutput: { hookEventName, additionalContext } });
