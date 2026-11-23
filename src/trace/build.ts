/**
 * Build a `hoja.trace/v1` from what one session left behind: the hook records (recorder.ts) and, when it can be read,
 * the host transcript plus its subagent transcripts.
 *
 * The two sources are complementary. The transcript is the only place model requests and token usage appear, but
 * its format is internal to Claude Code and changes between versions, so it is read defensively: unknown entry
 * types are skipped and every field is optional. Hooks are documented and give the exact tool timing
 * (`duration_ms`) and the gate's decisions. A session whose transcript cannot be read (another host, a pruned file)
 * still gets a trace from hooks alone; `session.basis` says which one it is.
 */
import { canonicalToolName, ROLLOUT_INJECTED } from "../transcript.ts";
import type { HookRecord } from "./recorder.ts";
import { clip, clipMiddle, FIELD_CAP, Redactor, toolLabel } from "./redact.ts";
import {
	addUsage, emptyUsage, TRACE_SCHEMA,
	type HojaTrace, type SpanStatus, type TokenUsage, type ToolStat, type TraceEvent, type TraceSpan, type TraceTask,
} from "./schema.ts";

export interface SubagentTranscript { agentId: string; text: string; toolUseId?: string; agentType?: string; description?: string }

export interface BuildInput {
	sessionId: string;
	transcript?: string;
	subagents?: SubagentTranscript[];
	hooks: HookRecord[];
	tasks?: TraceTask[];
	plugin: string;
	host?: string;
	detail?: "full" | "metadata";
	redactor?: Redactor;
	now?: Date;
	/** Hard ceiling on spans; the newest are dropped past it and `truncated` says so. */
	maxSpans?: number;
	/** Claude Code moves a large tool result out of the transcript (`<persisted-output>` … `Full output saved to: P`).
	 *  Given P, return the saved output, or undefined when it may not or cannot be read. */
	readPersisted?: (path: string) => string | undefined;
}

const PERSISTED = /<persisted-output>[\s\S]*?Full output saved to: (\S+)/;

type Entry = Record<string, any>;
const ms = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : undefined; };
const between = (a?: string, b?: string) => { const x = ms(a), y = ms(b); return x !== undefined && y !== undefined && y >= x ? y - x : undefined; };
const parseLines = (text: string): Entry[] => text.split("\n").flatMap(line => { if (!line.trim()) return []; try { const v = JSON.parse(line); return v && typeof v === "object" ? [v] : []; } catch { return []; } });
const firstLine = (s: string) => s.split("\n").find(l => l.trim())?.trim() ?? "";

/** Prompts the host injects as a user message, which are not the user starting a turn. */
const INJECTED_PROMPT = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|task-notification|user-prompt-submit-hook)\b/;

function usageOf(u: any): TokenUsage | undefined {
	if (!u || typeof u !== "object") return undefined;
	const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
	return { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_read_tokens: n(u.cache_read_input_tokens), cache_creation_tokens: n(u.cache_creation_input_tokens) };
}

function resultText(content: unknown, toolUseResult?: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content.map((c: any) => typeof c === "string" ? c : c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
		if (text) return text;
	}
	const r = toolUseResult as any;
	if (typeof r === "string") return r;
	if (r && typeof r === "object") return [r.stdout, r.stderr].filter((s: unknown) => typeof s === "string" && s).join("\n");
	return "";
}

/** Codex: `exec_command`/`shell` → `Bash`; this plugin's `mcp__hoja` namespace → bare names; other MCP → `server/tool`. */
function codexToolName(item: any): string {
	if (item.type === "local_shell_call") return "Bash";
	const name = String(item.name ?? "tool");
	const ns = typeof item.namespace === "string" ? item.namespace : "";
	if (!ns) return /^(exec_command|shell|container\.exec)$/.test(name) ? "Bash" : name === "apply_patch" ? "Edit" : name;
	if (ns === "mcp__hoja") return name;
	if (ns === "mcp__hoja_api" || ns === "mcp__hoja-api") return `hoja/${name}`;
	return `${ns.replace(/^mcp__/, "")}/${name}`;
}

/** `mcp__plugin_hoja_hoja__TaskManage` → `TaskManage`; `mcp__github__get_issue` → `github/get_issue`. */
export function displayToolName(raw: string): string {
	const canonical = canonicalToolName(raw);
	const mcp = /^mcp__(?:plugin_([^_]+(?:_[^_]+)*?)_)?([^_].*?)__(.+)$/.exec(canonical);
	if (!mcp) return canonical;
	return canonical.startsWith("mcp__hoja__") ? `hoja/${mcp[3]}` : `${mcp[2]}/${mcp[3]}`;
}

class Builder {
	readonly spans: TraceSpan[] = [];
	readonly events: TraceEvent[] = [];
	readonly toolSpans = new Map<string, TraceSpan>();
	readonly llmSpans = new Map<string, TraceSpan>();
	readonly models = new Set<string>();
	readonly truncated: string[] = [];
	title?: string;
	firstPrompt?: string;
	cwd?: string;
	gitBranch?: string;
	permissionMode?: string;
	hostVersion?: string;
	private turnCount = 0;
	private readonly full: boolean;
	readonly redactor: Redactor;

	constructor(readonly input: BuildInput) {
		this.full = (input.detail ?? "full") === "full";
		this.redactor = input.redactor ?? new Redactor();
	}

	/** Whole content, scrubbed; capped only at FIELD_CAP (head and tail kept). */
	content(value: string | undefined): string | undefined {
		if (!this.full || !value) return undefined;
		return clipMiddle(this.redactor.scrub(value), FIELD_CAP);
	}

	preview(value: string | undefined, max: number): string | undefined {
		if (!this.full || !value) return undefined;
		return clip(this.redactor.scrub(value), max);
	}

	add(span: TraceSpan) { this.spans.push(span); return span; }

	label(tool: string, input: unknown) {
		const name = displayToolName(tool);
		if (!this.full) return name;
		const label = this.redactor.scrub(toolLabel(name, input));
		return this.cwd ? label.split(`${this.cwd}/`).join("") : label;
	}

	/** One transcript (the main session or one subagent) into spans under `rootId`. */
	walk(entries: Entry[], rootId: string, agentId?: string) {
		const main = agentId === undefined;
		let turn: TraceSpan | undefined;
		let lastTs: string | undefined;
		let lastSeen: string | undefined;
		const parent = () => turn?.id ?? rootId;
		const closeTurn = (end?: string) => {
			if (!turn) return;
			turn.end ??= end ?? lastSeen;
			turn.durationMs ??= between(turn.start, turn.end);
			if (turn.status === "running") turn.status = "ok";
		};
		for (const entry of entries) {
			const ts: string | undefined = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
			if (main) {
				if (entry.type === "ai-title" && typeof entry.aiTitle === "string") this.title = entry.aiTitle;
				if (entry.type === "summary" && typeof entry.summary === "string") this.title ??= entry.summary;
				if (typeof entry.cwd === "string") this.cwd ??= entry.cwd;
				if (typeof entry.gitBranch === "string" && entry.gitBranch) this.gitBranch = entry.gitBranch;
				if (typeof entry.permissionMode === "string") this.permissionMode = entry.permissionMode;
				if (typeof entry.version === "string") this.hostVersion ??= entry.version;
			}
			if (entry.type === "system" && main) {
				if (entry.subtype === "turn_duration" && turn) {
					turn.end = ts ?? lastSeen;
					if (typeof entry.durationMs === "number") turn.durationMs = entry.durationMs;
				}
				if (entry.subtype === "compact_boundary" && ts) this.events.push({ at: ts, kind: "compaction", message: `Context compacted${entry.compactMetadata?.trigger ? ` (${entry.compactMetadata.trigger})` : ""}`, spanId: turn?.id });
				if (ts) lastSeen = ts;
				continue;
			}
			const message = entry.message;
			if (!message || typeof message !== "object") continue;
			if (entry.type === "user" && message.role === "user") {
				const blocks: any[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
				const prompt = blocks.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
				for (const block of blocks) {
					if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
					const span = this.toolSpans.get(block.tool_use_id);
					if (!span) continue;
					span.end = ts ?? span.end;
					span.durationMs = between(span.start, span.end);
					let text = resultText(block.content, entry.toolUseResult);
					const saved = PERSISTED.exec(text)?.[1];
					if (saved && this.full) {
						const whole = this.input.readPersisted?.(saved);
						if (whole) { text = whole; span.attrs = { ...span.attrs, persisted: true }; }
					}
					span.status = block.is_error === true ? (/^\s*\[TASK ENFORCEMENT|hook (?:error|blocked)|blocked by (?:a )?(?:PreToolUse )?hook/i.test(text) ? "blocked" : /interrupted by user/i.test(text) ? "interrupted" : "error") : "ok";
					const out = this.content(text);
					if (out) span.attrs = { ...span.attrs, [span.status === "ok" ? "output" : "error"]: out };
				}
				const genuine = prompt && !blocks.some(b => b?.type === "tool_result") && entry.isMeta !== true && entry.isCompactSummary !== true && !INJECTED_PROMPT.test(prompt);
				if (genuine && main) {
					closeTurn(lastSeen);
					this.turnCount++;
					this.firstPrompt ??= prompt;
					turn = this.add({
						id: `turn:${this.turnCount}`, parentId: rootId, kind: "turn", status: "running",
						name: this.full ? clip(firstLine(this.redactor.scrub(prompt)), 90, false) : `Turn ${this.turnCount}`,
						start: ts ?? lastSeen ?? new Date(0).toISOString(),
						attrs: { index: this.turnCount, ...(this.full ? { prompt: this.content(prompt) } : {}) },
					});
				} else if (genuine && !main) {
					const root = this.spans.find(s => s.id === rootId);
					if (root && this.full && !root.attrs?.prompt) root.attrs = { ...root.attrs, prompt: this.content(prompt) };
				}
				if (ts) { lastTs = ts; lastSeen = ts; }
				continue;
			}
			if (entry.type === "assistant" && message.role === "assistant") {
				const id: string = typeof message.id === "string" ? message.id : String(entry.uuid ?? `${this.spans.length}`);
				let span = this.llmSpans.get(id);
				const model = typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : undefined;
				if (model) this.models.add(model);
				if (!span) {
					span = this.add({ id: `llm:${id}`, parentId: parent(), kind: "llm", name: model ?? "model", start: lastTs ?? ts ?? lastSeen ?? new Date(0).toISOString(), status: "ok", agentId, attrs: { model } });
					this.llmSpans.set(id, span);
				}
				span.end = ts ?? span.end;
				span.durationMs = between(span.start, span.end);
				const usage = usageOf(message.usage);
				if (usage) span.attrs!.usage = usage;
				if (typeof message.stop_reason === "string") span.attrs!.stopReason = message.stop_reason;
				if (typeof entry.thinkingDurationMs === "number") span.attrs!.thinkingMs = entry.thinkingDurationMs;
				if (typeof entry.requestId === "string") span.attrs!.request_id = entry.requestId;
				if (message.stop_reason === "max_tokens") span.status = "error";
				for (const block of Array.isArray(message.content) ? message.content : []) {
					if (block?.type === "text" && typeof block.text === "string" && this.full) {
						const prior = typeof span.attrs!.text === "string" ? `${span.attrs!.text}\n` : "";
						span.attrs!.text = this.content(prior + block.text);
					}
					if (block?.type === "thinking") span.attrs!.thinking = true;
					if (block?.type === "tool_use" && typeof block.id === "string") {
						const raw = String(block.name ?? "tool");
						const tool = displayToolName(raw);
						const toolSpan = this.add({
							id: `tool:${block.id}`, parentId: parent(), kind: "tool", name: this.label(raw, block.input),
							start: ts ?? span.start, status: "running", agentId,
							attrs: { tool_name: tool, tool_use_id: block.id, llmId: span.id, ...(this.full ? { input: this.content(typeof block.input === "object" ? JSON.stringify(block.input, null, 1) : String(block.input ?? "")) } : {}) },
						});
						this.toolSpans.set(block.id, toolSpan);
						this.taskEvents(tool, block.input, ts, toolSpan.id);
						const path = block.input?.file_path ?? block.input?.notebook_path;
						if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && typeof path === "string") toolSpan.attrs!.file = path;
					}
				}
				if (ts) lastSeen = ts;
			}
		}
		if (main) closeTurn(lastSeen);
	}

	/**
	 * A Codex rollout (`~/.codex/sessions/…/rollout-*.jsonl`). Its shape, as Codex 0.169 writes it:
	 *   event_msg task_started / task_complete     one turn, with duration_ms
	 *   response_item reasoning|message|function_call   what the model produced
	 *   token_usage_record                          closes one model request: response_id + exact usage
	 *   response_item function_call_output          a tool result (call_id)
	 *   session_meta / turn_context                 cwd, cli_version, model
	 * Like the Claude transcript it is undocumented, so every field is optional and unknown lines are skipped.
	 */
	walkCodex(entries: Entry[], rootId: string) {
		let turn: TraceSpan | undefined;
		let llm: TraceSpan | undefined;
		let model: string | undefined;
		let lastInput: string | undefined;
		let lastSeen: string | undefined;
		let requests = 0;
		const parent = () => turn?.id ?? rootId;
		const openLlm = (ts: string | undefined) => {
			if (llm) return llm;
			llm = this.add({ id: `llm:codex-${++requests}`, parentId: parent(), kind: "llm", name: model ?? "model", start: lastInput ?? ts ?? lastSeen ?? new Date(0).toISOString(), status: "ok", attrs: { model } });
			if (model) this.models.add(model);
			return llm;
		};
		const closeTurn = (end?: string, durationMs?: number) => {
			if (!turn) return;
			turn.end = end ?? lastSeen;
			turn.durationMs = durationMs ?? between(turn.start, turn.end);
			if (turn.status === "running") turn.status = "ok";
			turn = undefined;
		};
		for (const entry of entries) {
			const ts: string | undefined = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
			const p = entry.payload ?? {};
			if (entry.type === "session_meta") {
				if (typeof p.cwd === "string") this.cwd ??= p.cwd;
				if (typeof p.cli_version === "string") this.hostVersion ??= p.cli_version;
				if (typeof p.git?.branch === "string") this.gitBranch = p.git.branch;
			} else if (entry.type === "turn_context") {
				if (typeof p.model === "string") model = p.model;
				if (typeof p.cwd === "string") this.cwd ??= p.cwd;
				if (typeof p.approval_policy === "string") this.permissionMode = p.approval_policy;
			} else if (entry.type === "compacted") {
				if (ts) this.events.push({ at: ts, kind: "compaction", message: "Context compacted", spanId: turn?.id });
			} else if (entry.type === "event_msg" && p.type === "task_started") {
				closeTurn(lastSeen);
				this.turnCount++;
				turn = this.add({ id: `turn:${this.turnCount}`, parentId: rootId, kind: "turn", status: "running", name: `Turn ${this.turnCount}`, start: ts ?? lastSeen ?? new Date(0).toISOString(), attrs: { index: this.turnCount, trigger: p.turn_attribution?.turn_trigger } });
				lastInput = ts;
			} else if (entry.type === "event_msg" && p.type === "task_complete") {
				if (llm) { llm.end ??= ts; llm.durationMs ??= between(llm.start, llm.end); llm = undefined; }
				closeTurn(ts, typeof p.duration_ms === "number" ? p.duration_ms : undefined);
			} else if (entry.type === "event_msg" && (p.type === "turn_aborted" || p.type === "error") && ts) {
				this.events.push({ at: ts, kind: "error", message: `Turn ${p.type === "turn_aborted" ? "aborted" : "failed"}${p.reason ? `: ${p.reason}` : p.message ? `: ${String(p.message).slice(0, 200)}` : ""}`, spanId: turn?.id });
				if (turn) turn.status = "error";
			} else if (entry.type === "token_usage_record") {
				const span = openLlm(ts);
				span.end = ts ?? span.end;
				span.durationMs = between(span.start, span.end);
				const u = p.usage ?? {};
				const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
				// OpenAI counts cached tokens inside input_tokens; Claude Code's names keep them apart.
				span.attrs!.usage = { input_tokens: Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens)), output_tokens: n(u.output_tokens), cache_read_tokens: n(u.cached_input_tokens), cache_creation_tokens: n(u.cache_write_input_tokens) };
				if (n(u.reasoning_output_tokens)) span.attrs!.reasoningTokens = n(u.reasoning_output_tokens);
				if (typeof p.response_id === "string") span.attrs!.request_id = p.response_id;
				llm = undefined;
			} else if (entry.type === "response_item") {
				if (p.type === "message" && p.role === "user") {
					const text = (Array.isArray(p.content) ? p.content : []).filter((c: any) => typeof c?.text === "string").map((c: any) => c.text).join("\n");
					if (text && !ROLLOUT_INJECTED.test(text) && turn && !turn.attrs?.prompt) {
						turn.name = this.full ? clip(firstLine(this.redactor.scrub(text)), 90, false) : turn.name;
						if (this.full) turn.attrs = { ...turn.attrs, prompt: this.content(text) };
						this.firstPrompt ??= text;
					}
					lastInput = ts;
				} else if (p.type === "reasoning") {
					openLlm(ts).attrs!.thinking = true;
				} else if (p.type === "message" && p.role === "assistant") {
					const text = (Array.isArray(p.content) ? p.content : []).filter((c: any) => typeof c?.text === "string").map((c: any) => c.text).join("\n");
					const span = openLlm(ts);
					if (text && this.full) span.attrs!.text = this.content(typeof span.attrs!.text === "string" ? `${span.attrs!.text}\n${text}` : text);
				} else if ((p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") && typeof p.call_id === "string") {
					const span = openLlm(ts);
					let args: any = p.arguments ?? p.input ?? p.action;
					if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep the string */ } }
					const tool = codexToolName(p);
					const labelInput = tool === "Bash" && args && typeof args === "object" ? { command: args.cmd ?? args.command } : args;
					const toolSpan = this.add({
						id: `tool:${p.call_id}`, parentId: parent(), kind: "tool", name: this.label(tool, labelInput),
						start: ts ?? span.start, status: "running",
						attrs: { tool_name: tool, tool_use_id: p.call_id, llmId: span.id, ...(this.full ? { input: this.content(typeof args === "object" ? JSON.stringify(args, null, 1) : String(args ?? "")) } : {}) },
					});
					this.toolSpans.set(p.call_id, toolSpan);
					this.taskEvents(tool, args, ts, toolSpan.id);
				} else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && typeof p.call_id === "string") {
					const span = this.toolSpans.get(p.call_id);
					const text = typeof p.output === "string" ? p.output : Array.isArray(p.output) ? p.output.map((c: any) => typeof c?.text === "string" ? c.text : "").filter(Boolean).join("\n") : typeof p.output?.content === "string" ? p.output.content : "";
					if (span) {
						span.end = ts ?? span.end;
						span.durationMs = between(span.start, span.end);
						const exit = /Process exited with code (\d+)/.exec(text);
						// Codex does not flag a rejected TaskManage call as an error; its own result says so.
						const rejected = span.attrs?.tool_name === "TaskManage" && /"status"\s*:\s*"(failed|partial)"/.test(text);
						span.status = /blocked by (?:PreToolUse )?hook|\[TASK ENFORCEMENT/i.test(text) ? "blocked"
							: (exit && exit[1] !== "0") || p.output?.success === false || rejected ? "error" : "ok";
						const out = this.content(text);
						if (out) span.attrs = { ...span.attrs, [span.status === "ok" ? "output" : "error"]: out };
						if (exit) span.attrs = { ...span.attrs, exitCode: Number(exit[1]) };
					}
					lastInput = ts;
				}
			}
			if (ts) lastSeen = ts;
		}
		closeTurn(lastSeen);
	}

	/** TaskManage creates/updates as instants on the timeline: what the agent committed to, and when. */
	taskEvents(tool: string, input: any, at: string | undefined, spanId: string) {
		if (tool !== "TaskManage" || !at || !Array.isArray(input?.operations)) return;
		for (const op of input.operations) {
			if (op?.op === "create") this.events.push({ at, kind: "task", spanId, message: `Task created: ${clip(String(op.subject ?? ""), 120)}`, attrs: { op: "create", status: op.status } });
			else if (op?.op === "update" && (op.status || op.active)) {
				const id = typeof op.taskId === "string" ? `#${op.taskId}` : "task";
				this.events.push({ at, kind: "task", spanId, message: `${id} → ${op.status ?? "focused"}`, attrs: { op: "update", taskId: op.taskId, status: op.status } });
			}
		}
	}

	/** Fold hook records into the spans: exact durations, gate decisions, calls the transcript missed. */
	mergeHooks(hooks: HookRecord[], rootId: string) {
		const pre = new Map<string, HookRecord>();
		const post = new Map<string, HookRecord>();
		const subagentStart = new Map<string, HookRecord>();
		let turn: TraceSpan | undefined = this.spans.filter(s => s.kind === "turn").at(-1);
		const hooksOnly = !this.spans.some(s => s.kind === "turn" || s.kind === "llm");
		let turnIndex = 0;
		for (const h of hooks) {
			if (h.event === "PreToolUse" && h.toolUseId) pre.set(h.toolUseId, h);
			if ((h.event === "PostToolUse" || h.event === "PostToolUseFailure") && h.toolUseId) post.set(h.toolUseId, h);
			if (h.event === "SubagentStart" && h.agentId) subagentStart.set(h.agentId, h);
			if (h.permissionMode) this.permissionMode = h.permissionMode;
			if (h.model) this.models.add(h.model);
			if (h.event === "PreToolUse" && h.decision === "deny")
				this.events.push({ at: h.at, kind: "gate.block", message: `${h.tool ? displayToolName(h.tool) : "Tool"} blocked: ${firstLine(h.reason ?? "")}`.slice(0, 300), spanId: h.toolUseId ? `tool:${h.toolUseId}` : undefined, attrs: this.full ? { reason: h.reason } : undefined });
			if (h.event === "PreCompact") this.events.push({ at: h.at, kind: "compaction", message: `Compaction started (${h.trigger ?? "auto"})` });
			if (h.event === "Notification") this.events.push({ at: h.at, kind: "notification", message: h.message ?? h.notificationType ?? "notification", attrs: h.notificationType ? { type: h.notificationType } : undefined });
			if (h.event === "StopFailure") this.events.push({ at: h.at, kind: "error", message: `Turn failed: ${firstLine(h.error ?? "")}`.slice(0, 300) });
			if (h.event === "PermissionDenied") this.events.push({ at: h.at, kind: "gate.block", message: `${h.tool ?? "Tool"} denied by permissions${h.reason ? `: ${h.reason}` : ""}`, spanId: h.toolUseId ? `tool:${h.toolUseId}` : undefined });
			if (h.event === "SessionStart" && h.source && h.source !== "startup") this.events.push({ at: h.at, kind: "session", message: `Session ${h.source}` });
			if (h.event === "SessionEnd") this.events.push({ at: h.at, kind: "session", message: `Session ended (${h.reason ?? "exit"})` });
			// Hooks-only sessions: a turn runs from each prompt to its Stop.
			if (hooksOnly && h.event === "UserPromptSubmit" && !h.agentId) {
				if (turn && !turn.end) { turn.end = h.at; turn.durationMs = between(turn.start, turn.end); turn.status = "ok"; }
				turnIndex++;
				turn = this.add({ id: `turn:${turnIndex}`, parentId: rootId, kind: "turn", status: "running", start: h.at, name: this.full && h.prompt ? clip(firstLine(h.prompt), 90, false) : `Turn ${turnIndex}`, attrs: { index: turnIndex, ...(this.full && h.prompt ? { prompt: h.prompt } : {}) } });
				this.firstPrompt ??= h.prompt;
			}
			if (hooksOnly && (h.event === "Stop" || h.event === "StopFailure") && !h.agentId && turn && !turn.end) {
				turn.end = h.at; turn.durationMs = between(turn.start, turn.end); turn.status = h.event === "StopFailure" ? "error" : "ok";
			}
			if (h.event === "SubagentStop" && h.agentId && !this.spans.some(s => s.id === `agent:${h.agentId}`)) {
				const started = subagentStart.get(h.agentId);
				this.add({ id: `agent:${h.agentId}`, parentId: turn?.id ?? rootId, kind: "subagent", name: h.agentType ?? "subagent", start: started?.at ?? h.at, end: h.at, durationMs: between(started?.at, h.at), status: "ok", agentId: h.agentId, attrs: { agentType: h.agentType } });
			}
			if (hooksOnly && h.event === "PreToolUse" && h.toolUseId && !this.toolSpans.has(h.toolUseId)) {
				const tool = displayToolName(h.tool ?? "tool");
				const span = this.add({
					id: `tool:${h.toolUseId}`, parentId: h.agentId ? `agent:${h.agentId}` : turn?.id ?? rootId, kind: "tool",
					name: this.full && (h.label ?? h.input) ? `${tool} · ${clip(firstLine(h.label ?? h.input ?? ""), 100, false)}` : tool,
					start: h.at, status: "running", agentId: h.agentId, attrs: { tool_name: tool, tool_use_id: h.toolUseId, ...(this.full && h.input ? { input: h.input } : {}) },
				});
				this.toolSpans.set(h.toolUseId, span);
			}
		}
		if (hooksOnly && turn && !turn.end) { turn.status = "running"; }
		for (const [id, span] of this.toolSpans) {
			const p = pre.get(id), q = post.get(id);
			if (p?.decision === "deny") {
				span.status = "blocked";
				span.end ??= p.at;
				span.durationMs = 0;
				if (this.full && p.reason) span.attrs = { ...span.attrs, blockedReason: p.reason };
				continue;
			}
			if (p?.context && this.full) span.attrs = { ...span.attrs, hookContext: p.context };
			if (!q) continue;
			if (span.status === "running") span.status = q.event === "PostToolUseFailure" ? (q.interrupted ? "interrupted" : "error") : "ok";
			if (hooksOnly || !span.end) span.end = q.at;
			if (q.durationMs !== undefined) { span.durationMs = q.durationMs; span.attrs = { ...span.attrs, measured: "hook" }; }
			else span.durationMs ??= between(span.start, span.end);
			if (hooksOnly && this.full) {
				if (q.output) span.attrs = { ...span.attrs, output: q.output };
				if (q.error) span.attrs = { ...span.attrs, error: q.error };
			}
		}
		// Subagents whose tool calls were only seen through hooks: nest them under the subagent span.
		for (const span of this.spans) if (span.kind === "tool" && span.agentId && span.parentId !== `agent:${span.agentId}` && this.spans.some(s => s.id === `agent:${span.agentId}`) && hooksOnly) span.parentId = `agent:${span.agentId}`;
	}
}

export function buildTrace(input: BuildInput): HojaTrace {
	const b = new Builder(input);
	const rootId = "session";
	const root = b.add({ id: rootId, kind: "session", name: "Session", start: "", status: "ok" });
	const entries = input.transcript ? parseLines(input.transcript) : [];
	const codex = entries.some(e => e.type === "session_meta" || e.type === "response_item" || e.type === "token_usage_record");
	const basis: "transcript" | "hooks" = codex || entries.some(e => e.type === "assistant" || e.type === "user") ? "transcript" : "hooks";
	if (basis === "transcript") { if (codex) b.walkCodex(entries, rootId); else b.walk(entries, rootId); }
	for (const sub of input.subagents ?? []) {
		const subEntries = parseLines(sub.text);
		if (!subEntries.length) continue;
		const stamps = subEntries.map(e => e.timestamp).filter((t): t is string => typeof t === "string").sort();
		const parentTool = sub.toolUseId ? b.toolSpans.get(sub.toolUseId) : undefined;
		const span = b.add({
			id: `agent:${sub.agentId}`, parentId: parentTool?.id ?? rootId, kind: "subagent",
			name: [sub.agentType, (sub.description ? clip(b.redactor.scrub(sub.description), 80, false) : undefined)].filter(Boolean).join(" · ") || "subagent",
			start: stamps[0] ?? "", end: stamps.at(-1), durationMs: between(stamps[0], stamps.at(-1)), status: "ok", agentId: sub.agentId,
			attrs: { agentType: sub.agentType, description: b.preview(sub.description, 200) },
		});
		b.walk(subEntries, span.id, sub.agentId);
		if (b.spans.some(s => s.parentId === span.id && s.kind === "tool" && s.status === "error")) span.attrs!.hadErrors = true;
	}
	b.mergeHooks(input.hooks, rootId);

	// Session bounds: every timestamp we know of.
	const stamps = [...b.spans.flatMap(s => [s.start, s.end]), ...b.events.map(e => e.at), ...input.hooks.map(h => h.at)].filter((t): t is string => !!t && ms(t) !== undefined).sort();
	const now = (input.now ?? new Date()).toISOString();
	root.start = stamps[0] ?? now;
	root.end = stamps.at(-1) ?? now;
	root.durationMs = between(root.start, root.end) ?? 0;
	for (const span of b.spans) if (!span.start) span.start = root.start;
	b.events.sort((x, y) => (ms(x.at) ?? 0) - (ms(y.at) ?? 0));

	// Totals.
	const tokens = emptyUsage();
	const tokensByModel: Record<string, TokenUsage> = {};
	const tools = new Map<string, ToolStat>();
	const files = new Set<string>();
	let llmMs = 0, toolMs = 0;
	for (const span of b.spans) {
		if (span.kind === "llm") {
			const usage = span.attrs?.usage as TokenUsage | undefined;
			if (usage) {
				addUsage(tokens, usage);
				const model = String(span.attrs?.model ?? "unknown");
				addUsage(tokensByModel[model] ??= emptyUsage(), usage);
			}
			llmMs += span.durationMs ?? 0;
		}
		if (span.kind === "tool") {
			if (span.status !== "running") span.attrs = { ...span.attrs, success: span.status === "ok" };
			const name = String(span.attrs?.tool_name ?? span.name);
			const stat = tools.get(name) ?? { name, calls: 0, errors: 0, blocked: 0, totalMs: 0 };
			stat.calls++;
			if (span.status === "error" || span.status === "interrupted") stat.errors++;
			if (span.status === "blocked") stat.blocked++;
			stat.totalMs += span.durationMs ?? 0;
			toolMs += span.durationMs ?? 0;
			tools.set(name, stat);
			if (typeof span.attrs?.file === "string") files.add(span.attrs.file);
		}
	}
	const toolSpans = b.spans.filter(s => s.kind === "tool");
	const cwd = b.cwd;
	const relative = (p: string) => cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;

	let spans = b.spans;
	const maxSpans = input.maxSpans ?? 5000;
	if (spans.length > maxSpans) {
		b.truncated.push(`${spans.length - maxSpans} spans past the ${maxSpans}-span limit were dropped`);
		spans = spans.slice(0, maxSpans);
	}
	const title = b.title ?? (b.firstPrompt ? clip(firstLine(b.redactor.scrub(b.firstPrompt)), 90, false) : undefined);
	const trace: HojaTrace = {
		schema: TRACE_SCHEMA,
		id: `${input.sessionId}@${root.end}`,
		createdAt: now,
		source: { host: input.host ?? (codex ? "codex" : "claude-code"), hostVersion: b.hostVersion, plugin: input.plugin, detail: input.detail ?? "full" },
		session: {
			id: input.sessionId, title: (input.detail ?? "full") === "full" ? title : undefined, cwd, gitBranch: b.gitBranch, permissionMode: b.permissionMode,
			models: [...b.models], start: root.start, end: root.end, durationMs: root.durationMs ?? 0, basis,
		},
		totals: {
			turns: b.spans.filter(s => s.kind === "turn").length,
			llmCalls: b.spans.filter(s => s.kind === "llm").length,
			toolCalls: toolSpans.length,
			toolErrors: toolSpans.filter(s => s.status === "error" || s.status === "interrupted").length,
			blocked: toolSpans.filter(s => s.status === "blocked").length,
			subagents: b.spans.filter(s => s.kind === "subagent").length,
			compactions: b.events.filter(e => e.kind === "compaction" && !/started/.test(e.message)).length || b.events.filter(e => e.kind === "compaction").length,
			tokens, tokensByModel, llmMs, toolMs,
			filesTouched: [...files].map(relative).sort(),
		},
		tools: [...tools.values()].sort((x, y) => y.calls - x.calls || y.totalMs - x.totalMs),
		tasks: input.tasks ?? [],
		issues: [...new Set((input.tasks ?? []).map(t => t.issue).filter((i): i is string => !!i))],
		spans,
		events: b.events,
		...(b.truncated.length ? { truncated: b.truncated } : {}),
	};
	return fitTrace(trace);
}

const CONTENT_FIELDS = ["output", "input", "text", "error", "prompt", "hookContext", "blockedReason"];
/** Field caps tried in turn when a trace is over budget: the largest contents shrink first, head and tail kept. */
const FIT_CAPS = [64_000, 16_000, 4_000, 1_000, 300];

/**
 * Hoja accepts uploads up to 10 MB. A trace keeps whole content; only when it is over `limit` bytes are content
 * fields longer than a cap trimmed to it (largest cap first, head and tail kept), and only past the smallest cap are
 * trailing spans dropped. `truncated` records each step.
 */
export function fitTrace(trace: HojaTrace, limit = 8 * 1024 * 1024): HojaTrace {
	const size = () => Buffer.byteLength(JSON.stringify(trace));
	if (size() <= limit) return trace;
	for (const cap of FIT_CAPS) {
		let trimmed = 0;
		for (const span of trace.spans) for (const field of CONTENT_FIELDS) {
			const value = span.attrs?.[field];
			if (typeof value === "string" && value.length > cap) { span.attrs![field] = clipMiddle(value, cap); trimmed++; }
		}
		if (trimmed) (trace.truncated ??= []).push(`${trimmed} content fields over ${cap.toLocaleString("en-US")} chars trimmed (head and tail kept) to fit the upload limit`);
		if (size() <= limit) return trace;
	}
	while (size() > limit && trace.spans.length > 1) {
		const drop = Math.ceil(trace.spans.length / 10);
		trace.spans = trace.spans.slice(0, trace.spans.length - drop);
		trace.truncated!.push(`${drop} trailing spans dropped to fit the upload limit`);
	}
	return trace;
}
