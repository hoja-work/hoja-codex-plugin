/**
 * Tracing inside the MCP server: the `hoja_trace` tool, the `/hoja:trace` command, and the upload that follows a
 * completed task.
 *
 * Upload on completion hooks into Pi's `tool_result` chain *after* hoja-mode, so by the time it runs, publication has
 * linked the task to its issue and moved the issue to Done. The upload line is appended to the TaskManage result the
 * model sees, so a failed upload is visible, never silent, and never fails the task.
 */
import { resolveHojaToken, resolveHojaUrl } from "../../vendor/trebol/.pi/lib/claw/hoja.ts";
import { collectTrace, hojaLinks, saveTrace } from "./collect.ts";
import { renderSummary } from "./render.ts";
import type { HojaTrace } from "./schema.ts";
import { appendLedger, LegacyTraceEndpointError, readFlushState, readLedger, uploadSessionTrace, uploadTrace, writeFlushState, type FetchLike, type UploadResult } from "./upload.ts";
import type { TraceDetail, TraceUpload } from "../env.ts";

export interface TraceServiceOptions {
	dataDir: string;
	upload: TraceUpload;
	detail: TraceDetail;
	env?: Record<string, string | undefined>;
	fetchImpl?: FetchLike;
	log?: (line: string) => void;
	/** Live state; the session journal entries (for Hoja links) and the task snapshot. */
	session: () => { id?: string; transcriptPath?: string; entries: readonly any[]; tasks: readonly any[] };
}

const ISSUE = /^[A-Za-z0-9]+-\d+$/;

/** Minimum gap between two mid-reply ("turn") syncs; the end of every reply always syncs. HOJA_TRACE_SYNC_INTERVAL_MS. */
export const TURN_SYNC_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_COMPLETION_ATTEMPTS = 3;

export class TraceService {
	private syncing = false;
	/** After a failed sync, mid-reply syncs pause (30 s, doubling, capped at 10 min); end-of-reply and session-end still try. */
	private failures = 0;
	private retryAt = 0;
	/** Background sync scheduling (`schedule`): one in flight, at most one queued, throttled mid-reply. */
	private inFlight?: Promise<void>;
	private queued?: "turn" | "reply";
	private lastTurnSync = 0;
	constructor(private readonly options: TraceServiceOptions) {}

	private get env() { return this.options.env ?? process.env; }

	build(): HojaTrace | undefined {
		const s = this.options.session();
		if (!s.id) return undefined;
		return collectTrace({ dataDir: this.options.dataDir, sessionId: s.id, transcriptPath: s.transcriptPath, tasks: s.tasks, journal: s.entries, detail: this.options.detail, env: this.env });
	}

	/** Credentials problem in words, or "" when uploads can run. */
	uploadProblem(): string {
		if (!resolveHojaUrl(this.env)) return "no Hoja endpoint (set hoja_api_url or HOJA_API_URL)";
		if (!resolveHojaToken(this.env)) return "no Hoja token (set hoja_token or HOJA_TOKEN)";
		return "";
	}

	async upload(issue: string, reason: string, taskId?: string, trace = this.build()): Promise<UploadResult> {
		if (!trace) throw new Error("no session is bound yet");
		const problem = this.uploadProblem();
		if (problem) throw new Error(problem);
		saveTrace(this.options.dataDir, trace);
		const result = await uploadTrace(trace, issue, { graphqlUrl: resolveHojaUrl(this.env), token: resolveHojaToken(this.env), fetchImpl: this.options.fetchImpl }, reason);
		appendLedger(this.options.dataDir, trace.session.id, { issue, at: new Date().toISOString(), url: result.url, attachmentId: result.attachmentId, reason, taskId });
		this.options.log?.(`trace uploaded to ${issue} (${result.bytes} bytes)`);
		return result;
	}

	/** Completed tasks linked to an issue whose trace has not been uploaded in this session. */
	pendingCompletions(): { taskId: string; issue: string }[] {
		const s = this.options.session();
		if (!s.id) return [];
		const links = hojaLinks(s.entries);
		// A failed completion upload is recorded with an empty url. It is retried on later TaskManage calls (and at session
		// end) until it succeeds or has failed MAX_COMPLETION_ATTEMPTS times, so one network blip no longer loses it.
		const attempts = new Map<string, number>();
		const done = new Set<string>();
		for (const e of readLedger(this.options.dataDir, s.id)) {
			if (e.reason !== "completion") continue;
			const key = `${e.taskId}:${e.issue}`;
			if (e.url) done.add(key);
			else if ((attempts.set(key, (attempts.get(key) ?? 0) + 1).get(key) ?? 0) >= MAX_COMPLETION_ATTEMPTS) done.add(key);
		}
		return s.tasks.filter(t => t?.status === "completed" && links.has(String(t.id)))
			.map(t => ({ taskId: String(t.id), issue: links.get(String(t.id))! }))
			.filter(p => !done.has(`${p.taskId}:${p.issue}`));
	}

	/** After a TaskManage call: upload the trace to each issue whose task just completed. Lines for the tool result. */
	async afterTaskManage(): Promise<string[]> {
		if (this.options.upload === "off" || this.options.upload === "manual") return [];
		const pending = this.pendingCompletions();
		if (!pending.length || this.uploadProblem()) return [];
		const trace = this.build();
		const lines: string[] = [];
		const s = this.options.session();
		// The first upload of a session says what it carried, once, so nobody is surprised by full content.
		const first = !!s.id && !readLedger(this.options.dataDir, s.id).some(e => e.url);
		for (const p of pending) {
			try {
				const r = await this.upload(p.issue, "completion", p.taskId, trace);
				lines.push(`Hoja trace: attached this session's trace to ${p.issue} (${r.subtitle}).`);
				if (first && lines.length === 1) lines.push(this.contentNotice());
			} catch (error) {
				lines.push(`Hoja trace: could not attach the trace to ${p.issue}: ${(error as Error).message}. Run /hoja:trace upload ${p.issue} to retry.`);
				// Record the attempt so a broken endpoint does not retry (and fail) on every later TaskManage call.
				const s = this.options.session();
				if (s.id) appendLedger(this.options.dataDir, s.id, { issue: p.issue, at: new Date().toISOString(), url: "", reason: "completion", taskId: p.taskId });
			}
		}
		return lines;
	}

	/**
	 * Task-independent trace sync (turn settle / session end): if any Hoja issue was touched in this session and
	 * the trace gained spans or new issues since the last upload, upsert the trace idempotently via `/api/traces`.
	 */
	async syncSession(reason: "turn" | "reply" | "session-end"): Promise<string[]> {
		if (this.options.upload === "off" || this.options.upload === "manual") return [];
		if (this.syncing || this.uploadProblem()) return [];
		if (reason === "turn" && Date.now() < this.retryAt) return [];
		const trace = this.build();
		if (!trace || !trace.issues.length) return [];
		const prev = readFlushState(this.options.dataDir, trace.session.id);
		const prevIssues = new Set(prev?.lastIssues ?? []);
		const unchanged = prev && prev.lastSpanCount === trace.spans.length && trace.issues.every(i => prevIssues.has(i));
		if (unchanged) return [];
		this.syncing = true;
		try {
			saveTrace(this.options.dataDir, trace);
			const target = { graphqlUrl: resolveHojaUrl(this.env), token: resolveHojaToken(this.env), fetchImpl: this.options.fetchImpl };
			const out: string[] = [];
			try {
				const res = await uploadSessionTrace(trace, trace.issues, target, reason === "reply" ? "turn" : reason);
				this.failures = 0; this.retryAt = 0;
				for (const att of res.attachments) {
					appendLedger(this.options.dataDir, trace.session.id, {
						issue: att.issue, at: new Date().toISOString(), url: att.url,
						attachmentId: att.id, reason,
					});
					out.push(`Hoja trace: ${att.updated ? "updated" : "attached"} session trace on ${att.issue} (${att.subtitle}).`);
				}
				writeFlushState(this.options.dataDir, trace.session.id, {
					lastSpanCount: trace.spans.length, lastIssues: [...new Set([...prevIssues, ...trace.issues])], at: new Date().toISOString(),
				});
				return out;
			} catch (error) {
				if (!(error instanceof LegacyTraceEndpointError)) {
					this.failures++;
					this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (this.failures - 1));
					this.options.log?.(`session trace sync failed (${reason}, attempt ${this.failures}): ${(error as Error).message}`);
					return [];
				}
				// Older Hoja server without /api/traces: fall back to once-per-issue attachmentCreate.
				const uploaded = new Set(readLedger(this.options.dataDir, trace.session.id).filter(e => e.url).map(e => e.issue));
				for (const issue of trace.issues) {
					if (uploaded.has(issue)) continue;
					try {
						const r = await uploadTrace(trace, issue, target, reason);
						appendLedger(this.options.dataDir, trace.session.id, { issue, at: new Date().toISOString(), url: r.url, attachmentId: r.attachmentId, reason });
						out.push(`Hoja trace: attached this session's trace to ${issue} (${r.subtitle}).`);
					} catch (err) {
						this.options.log?.(`trace fallback failed for ${issue}: ${(err as Error).message}`);
					}
				}
				writeFlushState(this.options.dataDir, trace.session.id, {
					lastSpanCount: trace.spans.length, lastIssues: [...new Set([...prevIssues, ...trace.issues])], at: new Date().toISOString(),
				});
				return out;
			}
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Sync in the background, off the hook's critical path (HOJA-757: an awaited sync on every PostToolBatch made the
	 * hook 7–15x slower and grew with the trace). "turn" (a tool batch settled) is throttled to one per
	 * TURN_SYNC_INTERVAL_MS; "reply" (the agent ended its reply) always runs, so the issue sees each reply's final
	 * state. One sync runs at a time; requests that arrive meanwhile collapse into one follow-up.
	 */
	schedule(kind: "turn" | "reply"): void {
		if (this.options.upload === "off" || this.options.upload === "manual") return;
		const interval = Number(this.env.HOJA_TRACE_SYNC_INTERVAL_MS ?? TURN_SYNC_INTERVAL_MS);
		if (kind === "turn" && Date.now() - this.lastTurnSync < (Number.isFinite(interval) ? interval : TURN_SYNC_INTERVAL_MS)) return;
		if (this.inFlight) { if (kind === "reply" || !this.queued) this.queued = kind; return; }
		this.lastTurnSync = Date.now();
		this.inFlight = this.syncSession(kind)
			.then(() => undefined, error => this.options.log?.(`trace sync failed: ${(error as Error).message}`))
			.finally(() => {
				this.inFlight = undefined;
				const next = this.queued;
				this.queued = undefined;
				if (next) { this.lastTurnSync = 0; this.schedule(next); }
			});
	}

	/** Resolves once no background sync is running or queued (tests, SessionEnd). */
	async idle(): Promise<void> {
		while (this.inFlight) await this.inFlight;
	}

	contentNotice(): string {
		return this.options.detail === "full"
			? "It includes full content (prompts, tool inputs and outputs, model responses) with secrets scrubbed; set trace_detail to metadata to send only timings, statuses and token counts."
			: "It includes timings, statuses and token counts only (trace_detail: metadata).";
	}

	/** `/hoja:trace [summary|upload [ISSUE]|path]` and the `hoja_trace` tool share this. */
	async run(args: string): Promise<string> {
		const [verb = "summary", target] = args.trim().split(/\s+/).filter(Boolean);
		const trace = this.build();
		if (!trace) return "No session is bound yet; send a prompt first.";
		const path = saveTrace(this.options.dataDir, trace);
		const uploads = readLedger(this.options.dataDir, trace.session.id).filter(e => e.url);
		if (verb === "path") return path;
		if (verb === "upload") {
			const issues = target ? [target.toUpperCase()] : trace.issues;
			if (!issues.length) return "No issue to attach the trace to: this session's tasks are not linked to Hoja issues. Name one: /hoja:trace upload HOJA-123";
			const bad = issues.find(i => !ISSUE.test(i));
			if (bad) return `"${bad}" is not an issue identifier (expected TEAM-123).`;
			const out: string[] = [];
			for (const issue of issues) {
				try { const r = await this.upload(issue, "manual", undefined, trace); out.push(`✓ ${issue}: ${r.title} — ${r.subtitle}`); }
				catch (error) { out.push(`✗ ${issue}: ${(error as Error).message}`); }
			}
			return [...out, this.contentNotice()].join("\n");
		}
		const footer = this.options.upload === "off" ? "Uploads are off (trace_upload)."
			: this.uploadProblem() ? `Uploads unavailable: ${this.uploadProblem()}.`
			: this.options.upload === "manual" ? "Uploads are manual: /hoja:trace upload [ISSUE]."
			: `Uploads: automatic on ${this.options.upload === "session-end" ? "task completion and session end" : "task completion"}; now: /hoja:trace upload [ISSUE].`;
		return `${renderSummary(trace, { path, uploads })}\n\n${footer}`;
	}
}
