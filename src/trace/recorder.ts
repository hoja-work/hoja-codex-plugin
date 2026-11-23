/**
 * Hook events → `<dataDir>/traces/<session>.events.jsonl`, one compact line per event.
 *
 * Hooks are the stable, documented half of a trace: exact tool start/end, `duration_ms`, gate decisions, subagent
 * start/stop, compactions and notifications. The transcript (model requests and token usage) is undocumented and
 * read only when the trace is built (build.ts). Every write is best-effort: tracing never fails a hook.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clip, clipMiddle, FIELD_CAP, inputPreview, Redactor } from "./redact.ts";

export interface HookRecord {
	at: string;
	event: string;
	agentId?: string;
	agentType?: string;
	tool?: string;
	toolUseId?: string;
	durationMs?: number;
	/** PreToolUse: the gate refused the call (`deny`) and why. */
	decision?: "deny";
	reason?: string;
	/** PreToolUse: context the pipeline attached (a nudge), which the model sees with the result. */
	context?: string;
	/** One line naming what the call does (`npm test`, `src/app.ts`), for the span label. */
	label?: string;
	input?: string;
	output?: string;
	error?: string;
	interrupted?: boolean;
	prompt?: string;
	source?: string;
	trigger?: string;
	message?: string;
	notificationType?: string;
	permissionMode?: string;
	model?: string;
	transcriptPath?: string;
	agentTranscriptPath?: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
export const tracesDir = (dataDir: string) => join(dataDir, "traces");
export const eventsPath = (dataDir: string, sessionId: string) => join(tracesDir(dataDir), `${SAFE_ID.test(sessionId) ? sessionId : "invalid-session"}.events.jsonl`);
export const tracePath = (dataDir: string, sessionId: string) => join(tracesDir(dataDir), `${SAFE_ID.test(sessionId) ? sessionId : "invalid-session"}.trace.json`);

const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : undefined; };
const str = (v: unknown) => typeof v === "string" && v ? v : undefined;

export interface RecorderOptions { dataDir: string; detail?: "full" | "metadata"; redactor?: Redactor; log?: (line: string) => void; now?: () => Date }

export class TraceRecorder {
	private readonly redactor: Redactor;
	private readonly full: boolean;
	private lastTranscript?: string;
	constructor(private readonly options: RecorderOptions) {
		this.redactor = options.redactor ?? new Redactor();
		this.full = (options.detail ?? "full") === "full";
	}

	private text(value: unknown, max: number): string | undefined {
		if (!this.full) return undefined;
		const s = typeof value === "string" ? value : value == null ? "" : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
		return s ? clip(this.redactor.scrub(s), max) : undefined;
	}

	/** Whole content (scrubbed), for hooks-only traces: prompts, tool inputs, outputs and errors. */
	private content(value: unknown): string | undefined {
		if (!this.full) return undefined;
		const s = typeof value === "string" ? value : value == null ? "" : (() => { try { return JSON.stringify(value, null, 1); } catch { return String(value); } })();
		return s ? clipMiddle(this.redactor.scrub(s), FIELD_CAP) : undefined;
	}

	/** Shape one hook payload (already placeholder-filtered by the bridge) plus the bridge's own decision. */
	shape(event: string, payload: Record<string, any>, output: Record<string, any> = {}, outputText?: string): HookRecord {
		const at = (this.options.now?.() ?? new Date()).toISOString();
		const tool = str(payload.tool_name);
		const hso = output?.hookSpecificOutput ?? {};
		const record: HookRecord = {
			at, event,
			agentId: str(payload.agent_id), agentType: str(payload.agent_type),
			tool, toolUseId: str(payload.tool_use_id),
			durationMs: num(payload.duration_ms),
			permissionMode: str(payload.permission_mode),
			model: typeof payload.model === "string" ? payload.model : str(payload.model?.id),
		};
		if (event === "PreToolUse") {
			if (hso.permissionDecision === "deny") { record.decision = "deny"; record.reason = this.content(hso.permissionDecisionReason) ?? "blocked"; }
			else if (hso.additionalContext) record.context = this.content(hso.additionalContext);
			record.label = this.text(inputPreview(tool ?? "", payload.tool_input).split("\n")[0], 200);
			record.input = this.content(payload.tool_input && typeof payload.tool_input === "object" && !Object.keys(payload.tool_input).length ? "" : tool === "Bash" ? inputPreview(tool, payload.tool_input) : payload.tool_input);
		}
		if (event === "PostToolUse") record.output = this.content(outputText);
		if (event === "PostToolUseFailure") {
			record.error = this.content(outputText ?? payload.error) ?? "failed";
			if (payload.is_interrupt === true || payload.is_interrupt === "true") record.interrupted = true;
		}
		if (event === "UserPromptSubmit") record.prompt = this.content(payload.prompt);
		if (event === "SessionStart") record.source = str(payload.source);
		// The transcript path, once per change, so a trace can be rebuilt from this file alone (SessionEnd, /resume).
		const transcript = str(payload.transcript_path);
		if (transcript && !payload.agent_id && this.lastTranscript !== transcript) { record.transcriptPath = transcript; this.lastTranscript = transcript; }
		if (event === "SessionEnd") record.reason = str(payload.reason);
		if (event === "PreCompact" || event === "PostCompact") record.trigger = str(payload.trigger);
		if (event === "Notification") { record.message = this.text(payload.message, 300); record.notificationType = str(payload.notification_type); }
		if (event === "StopFailure") record.error = this.content(payload.error) ?? "turn failed";
		if (event === "PermissionDenied") record.reason = this.text(payload.reason, 300);
		if (event === "SubagentStop") record.agentTranscriptPath = str(payload.agent_transcript_path);
		return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as HookRecord;
	}

	record(sessionId: string | undefined, event: string, payload: Record<string, any>, output?: Record<string, any>, outputText?: string) {
		if (!sessionId) return;
		try {
			const line = JSON.stringify(this.shape(event, payload, output, outputText));
			mkdirSync(tracesDir(this.options.dataDir), { recursive: true, mode: 0o700 });
			appendFileSync(eventsPath(this.options.dataDir, sessionId), line + "\n", { mode: 0o600 });
		} catch (error) { this.options.log?.(`trace record failed: ${(error as Error).message}`); }
	}
}

export function readHookRecords(dataDir: string, sessionId: string): HookRecord[] {
	const path = eventsPath(dataDir, sessionId);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}
