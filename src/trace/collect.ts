/**
 * Everything a trace is built from, read off disk: the hook records, the transcript and its subagent transcripts,
 * the task state and Hoja links (from the session journal). Used by the MCP server (on task completion and
 * `/hoja:trace`) and by the SessionEnd command hook, which runs after the server may already be gone.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { statSync } from "node:fs";
import { FIELD_CAP } from "./redact.ts";
import { buildTrace, type SubagentTranscript } from "./build.ts";
import { hostOf } from "../host.ts";
import { readHookRecords, tracePath, tracesDir } from "./recorder.ts";
import { Redactor } from "./redact.ts";
import type { HojaTrace, TraceTask } from "./schema.ts";

export const PLUGIN_VERSION = "0.4.1";
const HOJA_TASK_ENTRY = "hoja-task-link";
const TASK_STATE_ENTRY = "pi-swarm-task-state";

/** taskId → issue identifier, from the latest `hoja-task-link` record of each task that is linked. */
export function hojaLinks(entries: readonly any[]): Map<string, string> {
	const links = new Map<string, string>();
	for (const entry of entries) {
		if (entry?.customType !== HOJA_TASK_ENTRY) continue;
		const d = entry.data;
		if (d?.taskId == null) continue;
		if (d.state === "linked" && typeof d.identifier === "string") links.set(String(d.taskId), d.identifier);
	}
	return links;
}

/** The last persisted TaskManage state in a journal, when no live manager is at hand. */
export function journalTasks(entries: readonly any[]): any[] {
	const last = [...entries].reverse().find(e => e?.customType === TASK_STATE_ENTRY);
	const tasks = last?.data?.tasks;
	return Array.isArray(tasks) ? tasks : tasks && typeof tasks === "object" ? Object.values(tasks) : [];
}

export function traceTasks(tasks: readonly any[], links: Map<string, string>): TraceTask[] {
	return tasks.filter(t => t && t.status !== "deleted").map(t => {
		const answered = new Set((t.answers ?? []).map((a: any) => a?.question));
		return {
			id: String(t.id), subject: String(t.subject ?? ""), status: String(t.status ?? ""),
			...(t.parentTaskId ? { parentId: String(t.parentTaskId) } : {}),
			...(links.get(String(t.id)) ? { issue: links.get(String(t.id)) } : {}),
			...(Array.isArray(t.questions) && t.questions.length ? { questions: t.questions.map((q: any) => ({ id: String(q.id), text: String(q.text ?? ""), answered: answered.has(q.id) })) } : {}),
		};
	});
}

/** `<dir>/<session>.jsonl` → `<dir>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json` naming the Agent call). */
export function readSubagents(transcriptPath: string | undefined): SubagentTranscript[] {
	if (!transcriptPath) return [];
	const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
	if (!existsSync(dir)) return [];
	const out: SubagentTranscript[] = [];
	for (const file of readdirSync(dir).filter(f => /^agent-.+\.jsonl$/.test(f)).sort()) {
		const agentId = file.slice("agent-".length, -".jsonl".length);
		let meta: any = {};
		try { meta = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), "utf8")); } catch { /* optional */ }
		try {
			out.push({ agentId, text: readFileSync(join(dir, file), "utf8"), toolUseId: meta.toolUseId, agentType: meta.agentType, description: meta.description });
		} catch { /* unreadable: skip */ }
	}
	return out;
}

/**
 * Reader for Claude Code's saved large tool results. Only files directly inside this session's own
 * `<session>/tool-results/` directory are read (a transcript line names the path, so it is not trusted further), and
 * only up to 4 × FIELD_CAP bytes; the builder trims the rest head-and-tail.
 */
export function persistedReader(transcriptPath: string | undefined): ((path: string) => string | undefined) | undefined {
	if (!transcriptPath) return undefined;
	const root = resolve(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "tool-results") + sep;
	return (path: string) => {
		const target = resolve(path);
		if (!target.startsWith(root) || target.slice(root.length).includes(sep)) return undefined;
		try {
			if (statSync(target).size > FIELD_CAP * 4) return readFileSync(target, "utf8").slice(0, FIELD_CAP * 4);
			return readFileSync(target, "utf8");
		} catch { return undefined; }
	};
}

export interface CollectOptions {
	dataDir: string;
	sessionId: string;
	transcriptPath?: string;
	tasks?: readonly any[];
	journal?: readonly any[];
	detail?: "full" | "metadata";
	host?: string;
	env?: Record<string, string | undefined>;
	now?: Date;
}

/** Last transcript path a hook reported for this session, when the caller has none. */
function transcriptFromHooks(records: { transcriptPath?: string }[]): string | undefined {
	return [...records].reverse().find(r => r.transcriptPath)?.transcriptPath;
}

export function collectTrace(options: CollectOptions): HojaTrace {
	const hooks = readHookRecords(options.dataDir, options.sessionId);
	const transcriptPath = options.transcriptPath || transcriptFromHooks(hooks);
	let transcript: string | undefined;
	try { if (transcriptPath) transcript = readFileSync(transcriptPath, "utf8"); } catch { /* hooks-only trace */ }
	const journal = options.journal ?? [];
	const links = hojaLinks(journal);
	return buildTrace({
		sessionId: options.sessionId, transcript, subagents: readSubagents(transcriptPath), hooks,
		tasks: traceTasks(options.tasks ?? journalTasks(journal), links),
		plugin: `hoja@${PLUGIN_VERSION}`, host: options.host ?? (hostOf() === "codex" ? "codex" : undefined), detail: options.detail,
		redactor: new Redactor(options.env ?? process.env), now: options.now, readPersisted: persistedReader(transcriptPath),
	});
}

/** Write the trace next to its events, atomically (a reader never sees half a file). */
export function saveTrace(dataDir: string, trace: HojaTrace): string {
	const path = tracePath(dataDir, trace.session.id);
	mkdirSync(tracesDir(dataDir), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(trace), { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}
