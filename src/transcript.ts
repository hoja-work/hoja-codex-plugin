/**
 * Host transcript (Claude Code JSONL or Codex rollout JSONL) → Pi session messages.
 *
 * Trebol's vendored code reads the live Pi session in two places:
 *  - TaskManage resolves `tool:<Name>[#n]` evidence from `{type:"message", message:{role:"toolResult", toolName}}`
 *    entries (task-manage.ts sessionResultNames);
 *  - the task-gate auto-continue classifier reads Pi messages: assistant `stopReason` + `toolCall` parts,
 *    `toolResult` content, and genuine `user` turns (task-gate-resume.ts classifyTaskGateStop).
 * Both hosts record the same facts in their transcripts, so this module rebuilds those shapes from them.
 */
import { readFileSync, statSync } from "node:fs";
import { profile } from "./host.ts";

/** What Pi calls the same hosted server's tools (~/.pi/agent/mcp.json server "hoja"). */
export const PI_API_PREFIX = "mcp__hoja__";
/** The host prefix of one of this plugin's own tools, if `name` is one. */
export const ownToolPrefix = (name: string) => profile().ownToolPrefixes.find(prefix => name.startsWith(prefix));
export const isOwnTool = (name: string) => ownToolPrefix(name) !== undefined;
/**
 * The name a tool has inside Trebol's code: our own tools lose the plugin namespace (Pi registers them bare), hosted
 * Hoja API tools get Pi's `mcp__hoja__` namespace, host shell tools are Pi's `Bash`, everything else is as-is.
 */
export const canonicalToolName = (name: string) => {
	const { apiToolPrefixes, bashAliases } = profile();
	const own = ownToolPrefix(name);
	if (own) return name.slice(own.length);
	const api = apiToolPrefixes.find(prefix => name.startsWith(prefix));
	if (api) return PI_API_PREFIX + name.slice(api.length);
	return bashAliases.includes(name) ? "Bash" : name;
};

export type PiPart = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string };
export type PiMessage =
	| { role: "user"; content: PiPart[] }
	| { role: "assistant"; content: PiPart[]; stopReason?: string }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: PiPart[]; isError: boolean };

const STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", pause_turn: "pause" };

const textParts = (content: unknown): PiPart[] => {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	return content.flatMap((block: any) => block?.type === "text" && typeof block.text === "string" ? [{ type: "text" as const, text: block.text }] : []);
};

/** Claude Code, Codex or Antigravity, decided by the file's own shape. */
export function parseTranscript(text: string): PiMessage[] {
	const first = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
	if (/"type"\s*:\s*"(session_meta|response_item|event_msg|turn_context)"/.test(first)) return parseCodexRollout(text);
	if (isAgyTranscriptLine(first)) return parseAgyTranscript(text);
	return parseClaudeTranscript(text);
}

/** Antigravity: `{"step_index": 0, "type": "USER_INPUT", …}` (brain/<id>/.system_generated/logs/transcript_full.jsonl). */
export const isAgyTranscriptLine = (line: string) => /"step_index"\s*:/.test(line) && /"type"\s*:\s*"(USER_INPUT|PLANNER_RESPONSE|GENERIC|SYSTEM_MESSAGE)"/.test(line);

/** The user's own words inside an Antigravity USER_INPUT step (it wraps them in <USER_REQUEST>, plus metadata). */
export const agyUserRequest = (content: string) => /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
/** A tool result step without its `Created At:` / `Completed At:` header lines. */
export const agyResultText = (content: string) => content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, "");
/** Antigravity's own tool names → what Trebol records (agy.ts does the same for hook payloads). */
export function agyToolName(call: { name?: string; args?: any }): string {
	const name = String(call?.name ?? "tool");
	if (name === "call_mcp_tool") return canonicalToolName(`mcp__${call.args?.ServerName ?? ""}__${call.args?.ToolName ?? ""}`);
	const map: Record<string, string> = { run_command: "Bash", read_file: "Read", view_file: "Read", write_file: "Write", edit_file: "Edit", replace_file_content: "Edit", multi_replace_file_content: "MultiEdit", apply_patch: "Edit", list_dir: "LS", list_directory: "LS", grep_search: "Grep", find_by_name: "Glob", search_web: "WebSearch", read_url_content: "WebFetch", tool_search: "ToolSearch" };
	return map[name] ?? name;
}

/**
 * Antigravity transcript → Pi messages. A PLANNER_RESPONSE is one model message whose `tool_calls` (no ids) are
 * answered, in order, by the GENERIC steps that follow it; ids are synthesized from the result's step index.
 */
export function parseAgyTranscript(text: string): PiMessage[] {
	const out: PiMessage[] = [];
	let pending: { id: string; name: string }[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try { e = JSON.parse(line); } catch { continue; }
		if (e?.type === "USER_INPUT" && typeof e.content === "string") {
			pending = [];
			out.push({ role: "user", content: [{ type: "text", text: agyUserRequest(e.content) }] });
		} else if (e?.type === "PLANNER_RESPONSE") {
			const parts: PiPart[] = [];
			if (typeof e.content === "string" && e.content) parts.push({ type: "text", text: e.content });
			const calls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
			pending = calls.map((call: any, i: number) => ({ id: `agy-${e.step_index}-${i}`, name: agyToolName(call) }));
			for (const p of pending) parts.push({ type: "toolCall", id: p.id, name: p.name });
			out.push({ role: "assistant", content: parts, stopReason: calls.length ? "toolUse" : "stop" });
		} else if (e?.type === "GENERIC" && pending.length) {
			const call = pending.shift()!;
			let body = agyResultText(typeof e.content === "string" ? e.content : "");
			// agy words a hook denial "tool call denied by pre-tool hook: <reason>"; Trebol's gate-resume classifier
			// (task-gate-resume.ts) recognizes Claude Code's "blocked by hook: <reason>", so the reason is re-worded.
			const denied = typeof e.error === "string" ? /denied by (?:a )?pre-tool hook:\s*([\s\S]*)$/.exec(e.error) : null;
			if (denied) body = `blocked by hook: ${denied[1]}`;
			const exit = /Command exited with code (\d+)/.exec(body);
			out.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: body ? [{ type: "text", text: body }] : [], isError: e.status === "ERROR" || (!!exit && exit[1] !== "0") });
		}
	}
	return out;
}

export const ROLLOUT_INJECTED = /^\s*<(environment_context|user_instructions|permissions instructions|skills_instructions|turn_aborted|subagent_notification)\b/;
const rolloutText = (content: unknown): PiPart[] => Array.isArray(content)
	? content.flatMap((part: any) => (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") && typeof part.text === "string" && part.text ? [{ type: "text" as const, text: part.text }] : [])
	: textParts(content);
const rolloutOutput = (output: unknown): { parts: PiPart[]; isError: boolean } => {
	if (typeof output === "string") return { parts: output ? [{ type: "text", text: output }] : [], isError: false };
	const o = output as any;
	if (o && typeof o === "object" && !Array.isArray(o) && "content" in o)
		return { parts: typeof o.content === "string" ? (o.content ? [{ type: "text", text: o.content }] : []) : rolloutText(o.content), isError: o.success === false };
	return { parts: rolloutText(output), isError: false };
};

/**
 * Codex rollout (`~/.codex/sessions/.../rollout-*.jsonl`): `response_item` lines carry the model-visible conversation.
 * Assistant text and its function calls are separate items there; Pi has one assistant message per model turn, whose
 * stopReason is `toolUse` when it called tools and `stop` when it ended the turn.
 */
export function parseCodexRollout(text: string): PiMessage[] {
	const out: PiMessage[] = [];
	const names = new Map<string, string>();
	let assistant: Extract<PiMessage, { role: "assistant" }> | undefined;
	const openAssistant = () => {
		if (!assistant) { assistant = { role: "assistant", content: [], stopReason: "stop" }; out.push(assistant); }
		return assistant;
	};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "response_item") continue;
		const item = entry.payload;
		if (!item || typeof item !== "object") continue;
		if (item.type === "message") {
			if (item.role === "assistant") {
				const a = openAssistant();
				// Text after tool calls is the next model turn.
				if (a.content.some(p => p.type === "toolCall")) { assistant = undefined; openAssistant().content.push(...rolloutText(item.content)); }
				else a.content.push(...rolloutText(item.content));
			} else if (item.role === "user") {
				const parts = rolloutText(item.content).filter(p => p.type === "text" && !ROLLOUT_INJECTED.test(p.text));
				if (parts.length) { assistant = undefined; out.push({ role: "user", content: parts }); }
			}
			continue;
		}
		if ((item.type === "function_call" || item.type === "custom_tool_call" || item.type === "local_shell_call") && typeof item.call_id === "string") {
			const raw = item.type === "local_shell_call" ? "local_shell" : typeof item.namespace === "string" && item.namespace ? `${item.namespace}__${item.name}` : String(item.name ?? "");
			const name = canonicalToolName(raw);
			names.set(item.call_id, name);
			const a = openAssistant();
			a.content.push({ type: "toolCall", id: item.call_id, name });
			a.stopReason = "toolUse";
			continue;
		}
		if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.call_id === "string") {
			assistant = undefined;
			const { parts, isError } = rolloutOutput(item.output);
			out.push({ role: "toolResult", toolCallId: item.call_id, toolName: names.get(item.call_id) ?? "tool", content: parts, isError });
		}
	}
	return out;
}

export function parseClaudeTranscript(text: string): PiMessage[] {
	const out: PiMessage[] = [];
	const names = new Map<string, string>();
	let lastAssistantId: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		const message = entry?.message;
		if (!message || typeof message !== "object") continue;
		if (entry.type === "assistant" && message.role === "assistant") {
			const parts: PiPart[] = [];
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block?.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
				else if (block?.type === "tool_use" && typeof block.id === "string") {
					const name = canonicalToolName(String(block.name ?? ""));
					names.set(block.id, name);
					parts.push({ type: "toolCall", id: block.id, name });
				}
			}
			const stopReason = typeof message.stop_reason === "string" ? STOP[message.stop_reason] ?? message.stop_reason : undefined;
			// Claude Code writes one transcript line per content block of the same API message; Pi has one message.
			const previous = out.at(-1);
			if (previous?.role === "assistant" && message.id && message.id === lastAssistantId) {
				previous.content.push(...parts);
				if (stopReason) previous.stopReason = stopReason;
			} else out.push({ role: "assistant", content: parts, ...(stopReason ? { stopReason } : {}) });
			lastAssistantId = message.id;
			continue;
		}
		if (entry.type === "user" && message.role === "user") {
			lastAssistantId = undefined;
			if (typeof message.content === "string") { out.push({ role: "user", content: textParts(message.content) }); continue; }
			const blocks = Array.isArray(message.content) ? message.content : [];
			const plain: PiPart[] = [];
			for (const block of blocks) {
				if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
					out.push({ role: "toolResult", toolCallId: block.tool_use_id, toolName: names.get(block.tool_use_id) ?? "tool", content: textParts(block.content), isError: block.is_error === true });
				} else if (block?.type === "text" && typeof block.text === "string") plain.push({ type: "text", text: block.text });
			}
			if (plain.length) out.push({ role: "user", content: plain });
		}
	}
	return out;
}

/** Re-reads only when the file changed; transcripts grow by appends. */
export class TranscriptReader {
	path?: string;
	private cache?: { size: number; mtime: number; messages: PiMessage[] };
	setPath(path: string | undefined) { if (path && path !== this.path) { this.path = path; this.cache = undefined; } }
	messages(): PiMessage[] {
		if (!this.path) return [];
		try {
			const stat = statSync(this.path);
			if (this.cache && this.cache.size === stat.size && this.cache.mtime === stat.mtimeMs) return this.cache.messages;
			const messages = parseTranscript(readFileSync(this.path, "utf8"));
			this.cache = { size: stat.size, mtime: stat.mtimeMs, messages };
			return messages;
		} catch { return []; }
	}
	/** Pi session entries for evidence: every tool result, in order, under its canonical tool name. */
	toolResultEntries(): unknown[] {
		return this.messages().filter(m => m.role === "toolResult").map(m => ({ type: "message", message: { role: "toolResult", toolName: (m as any).toolName } }));
	}
}
