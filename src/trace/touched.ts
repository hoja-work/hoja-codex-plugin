/**
 * Task-independent issue discovery and active-session correlation.
 *
 * When an agent works with Hoja directly through `hoja-api` MCP tools or the `hoja` CLI without creating
 * `TaskManage` tasks, there is no `hoja-task-link` journal entry. This module:
 *   1. Records the active session id for sibling processes (`api-proxy.ts`) keyed by parent pid so
 *      `X-Hoja-Session-Id` travels with every upstream MCP call.
 *   2. Extracts touched Hoja issue identifiers strictly from Hoja *write* tool calls (never from read/list calls).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalToolName } from "../transcript.ts";
import { tracesDir } from "./recorder.ts";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+(?:-[A-Za-z]-\d+)*)\b/g;

/** Canonical Hoja MCP write operation suffixes that mutate or target a single issue. */
const HOJA_WRITE_OPS = new Set([
	"hoja_issueCreate", "hoja_taskCreate",
	"hoja_issueUpdate", "hoja_taskUpdate",
	"hoja_issueMove", "hoja_issueArchive", "hoja_issueDelete",
	"hoja_issueSubscribe", "hoja_issueUnsubscribe",
	"hoja_commentCreate", "hoja_commentUpdate", "hoja_commentDelete",
	"hoja_issueDecisionCreate", "hoja_taskDecisionCreate",
	"hoja_issueDecisionAnswer", "hoja_taskDecisionAnswer",
	"hoja_issueDecisionCancel", "hoja_taskDecisionCancel",
	"hoja_issueReviewRequest", "hoja_taskReviewRequest",
	"hoja_attachmentCreate", "hoja_githubLinkAdd",
]);

const BASH_HOJA_WRITE = /\bhoja\s+(?:issue|task|comment|decision)\s+(?:create|update|comment|edit|close|reopen|archive|move|assign|answer|ask)\b/i;

function safePath(dir: string, file: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(dir, file);
}

function writeAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, path);
}

/** Remember the active session id for sibling MCP processes spawned by the same host (`ppid`). */
export function recordActiveSession(dataDir: string, sessionId: string, ppid = process.ppid): void {
	if (!dataDir || !SAFE_ID.test(sessionId)) return;
	try {
		const dir = tracesDir(dataDir);
		const payload = { sessionId, updatedAt: new Date().toISOString() };
		if (ppid > 1) writeAtomic(safePath(dir, `.active-${ppid}.json`), payload);
		writeAtomic(safePath(dir, ".active.json"), payload);
	} catch { /* best effort */ }
}

/** Read the active session id for this host process (or recent fallback), if any. */
export function readActiveSession(dataDir: string, ppid = process.ppid, maxAgeMs = 24 * 60 * 60 * 1000): string | undefined {
	if (!dataDir) return undefined;
	const dir = tracesDir(dataDir);
	for (const name of [...(ppid > 1 ? [`.active-${ppid}.json`] : []), ".active.json"]) {
		const file = join(dir, name);
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			const sid = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
			const age = Date.now() - Date.parse(String(parsed?.updatedAt ?? ""));
			if (SAFE_ID.test(sid) && (!Number.isFinite(age) || age <= maxAgeMs)) return sid;
		} catch { /* try fallback */ }
	}
	return undefined;
}

function isHojaWriteTool(rawTool: string, params: unknown): { isWrite: boolean; op: string } {
	const canonical = canonicalToolName(rawTool);
	const mcp = /^mcp__(?:plugin_[^_]+_)?[^_]+__(.+)$/.exec(canonical);
	const op = mcp ? mcp[1] : canonical;
	if (HOJA_WRITE_OPS.has(op)) return { isWrite: true, op };
	if (canonical === "Bash") {
		const cmd = typeof (params as any)?.command === "string" ? (params as any).command : "";
		if (BASH_HOJA_WRITE.test(cmd)) return { isWrite: true, op: "Bash" };
	}
	return { isWrite: false, op };
}

function collectIdentifiers(value: unknown, out: Set<string>, depth = 0): void {
	if (depth > 5 || value == null) return;
	if (typeof value === "string") {
		for (const m of value.matchAll(ISSUE_RE)) out.add(m[1]);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectIdentifiers(item, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (
				k === "identifier" || k === "issueId" || k === "id" || k === "url" ||
				k === "issue" || k === "task" || k === "comment" || k === "decision" ||
				/^(?:issue|task|comment|decision|attachment|githubLink)[A-Z]/.test(k)
			) {
				collectIdentifiers(v, out, depth + 1);
			}
		}
	}
}

/** Extract Hoja issue identifiers touched by a write tool call + its response. */
export function extractTouchedIssuesFromTool(rawTool: string, params: unknown, outputText?: string): string[] {
	const { isWrite, op } = isHojaWriteTool(rawTool, params);
	if (!isWrite) return [];
	const found = new Set<string>();
	// Only check explicit issue identifier fields in params (never free-form description/body text).
	if (op !== "Bash" && params && typeof params === "object") {
		const p = params as Record<string, unknown>;
		for (const key of ["issueId", "id", "identifier"]) {
			if (typeof p[key] === "string") collectIdentifiers(p[key], found);
		}
	} else if (op === "Bash" && typeof (params as any)?.command === "string") {
		// In CLI commands like `hoja issue comment HOJA-123 ...`, take identifiers on the command line before flags/body.
		const cmd = String((params as any).command);
		const head = cmd.split(/\s--(?:body|description|title)\b/)[0] ?? cmd;
		collectIdentifiers(head, found);
	}
	if (outputText) {
		try {
			const parsed = JSON.parse(outputText);
			collectIdentifiers(parsed, found);
		} catch {
			if (op !== "Bash") collectIdentifiers(outputText, found);
			else {
				// For CLI output, take first line / created identifier lines only.
				for (const m of outputText.slice(0, 1000).matchAll(ISSUE_RE)) found.add(m[1]);
			}
		}
	}
	return [...found];
}

const touchedPath = (dataDir: string, sessionId: string) =>
	join(tracesDir(dataDir), `${SAFE_ID.test(sessionId) ? sessionId : "invalid-session"}.issues.json`);

export function readTouchedIssues(dataDir: string, sessionId: string): string[] {
	if (!dataDir || !SAFE_ID.test(sessionId)) return [];
	const path = touchedPath(dataDir, sessionId);
	if (!existsSync(path)) return [];
	try {
		const v = JSON.parse(readFileSync(path, "utf8"));
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
	} catch { return []; }
}

export function appendTouchedIssues(dataDir: string, sessionId: string, issues: readonly string[]): string[] {
	if (!dataDir || !SAFE_ID.test(sessionId) || !issues.length) return [];
	try {
		const merged = [...new Set([...readTouchedIssues(dataDir, sessionId), ...issues.filter(Boolean)])];
		const path = touchedPath(dataDir, sessionId);
		mkdirSync(tracesDir(dataDir), { recursive: true, mode: 0o700 });
		writeAtomic(path, merged);
		return merged;
	} catch { return []; }
}
