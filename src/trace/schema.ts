/**
 * `hoja.trace/v1`: one agent session as a flat list of spans, so any renderer (the Hoja web viewer, `/hoja:trace`, an
 * OTLP exporter) can rebuild the tree from `parentId` without knowing which host produced it.
 *
 *   session ─┬─ turn ─┬─ llm        one model request: model, tokens, stop reason, thinking time
 *            │        ├─ tool       one tool call: input/output previews, duration, ok | error | blocked
 *            │        │   └─ subagent ─ llm / tool …   (an Agent call's own transcript, nested under the call)
 *            │        └─ …
 *            └─ turn …
 *
 * Instants that have no duration (a gate block, a compaction, a notification, a task update) are `events`.
 * Times are ISO-8601 strings; durations are milliseconds. Previews are truncated and secret-scrubbed when recorded.
 *
 * Names line up with Claude Code's own OpenTelemetry output where the meaning is the same, so a trace can be
 * compared with (or exported next to) `CLAUDE_CODE_ENABLE_TELEMETRY` data: `turn` ≈ `claude_code.interaction`,
 * `llm` ≈ `claude_code.llm_request`, `tool` ≈ `claude_code.tool`; attributes `model`, `request_id`, `tool_name`,
 * `tool_use_id`, `success` and the token counts use the same names. There is no cost field: the only cost Claude Code
 * publishes is a client-side list-price estimate that hooks cannot read, and a pricing table here would go stale.
 */
export const TRACE_SCHEMA = "hoja.trace/v1";

export type SpanKind = "session" | "turn" | "llm" | "tool" | "subagent";
export type SpanStatus = "ok" | "error" | "blocked" | "interrupted" | "running";

/** Field names follow Claude Code's OpenTelemetry `claude_code.api_request` event (monitoring-usage docs). */
export interface TokenUsage { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number }

export interface TraceSpan {
	id: string;
	parentId?: string;
	kind: SpanKind;
	name: string;
	start: string;
	end?: string;
	durationMs?: number;
	status: SpanStatus;
	/** Subagent spans and everything under them carry the agent that produced them. */
	agentId?: string;
	attrs?: Record<string, unknown>;
}

export interface TraceEvent {
	at: string;
	kind: "gate.block" | "gate.nudge" | "compaction" | "notification" | "task" | "error" | "session";
	message: string;
	spanId?: string;
	attrs?: Record<string, unknown>;
}

export interface TraceTask {
	id: string;
	subject: string;
	status: string;
	parentId?: string;
	issue?: string;
	questions?: { id: string; text: string; answered: boolean }[];
}

export interface ToolStat { name: string; calls: number; errors: number; blocked: number; totalMs: number }

export interface HojaTrace {
	schema: typeof TRACE_SCHEMA;
	id: string;
	createdAt: string;
	source: { host: string; hostVersion?: string; plugin: string; detail: "full" | "metadata" };
	session: {
		id: string;
		title?: string;
		cwd?: string;
		gitBranch?: string;
		permissionMode?: string;
		models: string[];
		start: string;
		end: string;
		durationMs: number;
		/** Where the trace came from: `transcript` (model requests + tokens) or `hooks` only. */
		basis: "transcript" | "hooks";
	};
	totals: {
		turns: number;
		llmCalls: number;
		toolCalls: number;
		toolErrors: number;
		blocked: number;
		subagents: number;
		compactions: number;
		tokens: TokenUsage;
		tokensByModel: Record<string, TokenUsage>;
		/** Wall-clock time spent waiting on the model vs. running tools, summed over spans (parallel calls overlap). */
		llmMs: number;
		toolMs: number;
		filesTouched: string[];
	};
	tools: ToolStat[];
	tasks: TraceTask[];
	issues: string[];
	spans: TraceSpan[];
	events: TraceEvent[];
	/** Set when limits dropped content: the reasons, in order. */
	truncated?: string[];
}

export const emptyUsage = (): TokenUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });
export const addUsage = (a: TokenUsage, b: TokenUsage) => { a.input_tokens += b.input_tokens; a.output_tokens += b.output_tokens; a.cache_read_tokens += b.cache_read_tokens; a.cache_creation_tokens += b.cache_creation_tokens; };
export const totalTokens = (u: TokenUsage) => u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens;
