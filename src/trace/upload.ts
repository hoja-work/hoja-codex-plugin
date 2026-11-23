/**
 * Trace → Hoja issue attachment, through the two calls the Hoja web app itself uses for a file:
 *   1. `POST <origin>/api/uploads` (multipart `file`, Bearer token) stores the JSON and answers its `url`;
 *   2. `attachmentCreate(input: {issueId, url, title, subtitle})` attaches it to the issue.
 * The Hoja web app recognises the attachment as a trace (application/json + a `.trace.json` name) and opens it in its
 * trace viewer. A per-session ledger records what was uploaded where, so a completion is never uploaded twice.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tracesDir } from "./recorder.ts";
import { totalTokens, type HojaTrace } from "./schema.ts";
import { formatDuration, formatTokens } from "./render.ts";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: any; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface UploadTarget { graphqlUrl: string; token: string; fetchImpl?: FetchLike; timeoutMs?: number }
export interface UploadResult { issue: string; url: string; attachmentId?: string; title: string; subtitle: string; bytes: number }

const HOSTS: Record<string, { slug: string; name: string }> = { "claude-code": { slug: "claude-code", name: "Claude Code" }, codex: { slug: "codex", name: "Codex" }, antigravity: { slug: "antigravity", name: "Antigravity" } };
const hostOf = (trace: HojaTrace) => HOSTS[trace.source.host] ?? { slug: trace.source.host.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "agent", name: trace.source.host };

export function traceFileName(trace: HojaTrace): string {
	const stamp = trace.session.end.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
	return `${hostOf(trace).slug}-${trace.session.id.slice(0, 8)}-${stamp}.trace.json`;
}

/** One line a person reads in the attachment list. */
export function traceSubtitle(trace: HojaTrace): string {
	const t = trace.totals;
	return [
		`${hostOf(trace).name} trace`,
		formatDuration(trace.session.durationMs),
		`${t.turns} turn${t.turns === 1 ? "" : "s"}`,
		`${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}`,
		t.toolErrors ? `${t.toolErrors} failed` : "",
		t.blocked ? `${t.blocked} blocked` : "",
		t.subagents ? `${t.subagents} subagent${t.subagents === 1 ? "" : "s"}` : "",
		totalTokens(t.tokens) ? `${formatTokens(totalTokens(t.tokens))} tokens` : "",
	].filter(Boolean).join(" · ");
}

export function traceTitle(trace: HojaTrace, reason?: string): string {
	const slug = hostOf(trace).slug;
	return traceFileName(trace).replace(`${slug}-`, `${slug}${reason ? `-${reason}` : ""}-`);
}

const ATTACH = `mutation HojaTraceAttach($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id url } } }`;

export async function uploadTrace(trace: HojaTrace, issue: string, target: UploadTarget, reason?: string): Promise<UploadResult> {
	const fetchImpl = target.fetchImpl ?? (fetch as unknown as FetchLike);
	const origin = new URL(target.graphqlUrl).origin;
	const body = JSON.stringify(trace);
	const name = traceTitle(trace, reason);
	const auth = { authorization: `Bearer ${target.token}` };
	const signal = () => AbortSignal.timeout(target.timeoutMs ?? 30_000);
	const form = new FormData();
	form.append("file", new Blob([body], { type: "application/json" }), name);
	const uploaded = await fetchImpl(`${origin}/api/uploads`, { method: "POST", headers: auth, body: form, signal: signal() });
	const text = await uploaded.text();
	if (uploaded.status === 401 || uploaded.status === 403) throw new Error(`Hoja rejected the token for uploads (HTTP ${uploaded.status}). Check HOJA_TOKEN.`);
	if (uploaded.status === 413) throw new Error(`the trace (${Math.round(body.length / 1024)} KB) is larger than Hoja's upload limit`);
	if (uploaded.status >= 400) throw new Error(`Hoja upload failed: HTTP ${uploaded.status} ${text.slice(0, 200)}`);
	let url: string | undefined;
	try { url = JSON.parse(text)?.url; } catch { /* below */ }
	if (typeof url !== "string" || !url) throw new Error("Hoja upload answered without a file url");
	const subtitle = traceSubtitle(trace);
	const attached = await fetchImpl(target.graphqlUrl, {
		method: "POST", headers: { ...auth, "content-type": "application/json" }, signal: signal(),
		body: JSON.stringify({ query: ATTACH, variables: { input: { issueId: issue, url, title: name, subtitle } } }),
	});
	const answer = await attached.text();
	let parsed: any;
	try { parsed = JSON.parse(answer); } catch { throw new Error(`Hoja attachmentCreate answered HTTP ${attached.status}`); }
	if (parsed?.errors?.length) throw new Error(`Hoja attachmentCreate: ${parsed.errors[0]?.message ?? "error"}`);
	if (!parsed?.data?.attachmentCreate?.success) throw new Error(`Hoja did not attach the trace to ${issue} (issue not found or not visible to this token)`);
	return { issue, url, attachmentId: parsed.data.attachmentCreate.attachment?.id, title: name, subtitle, bytes: body.length };
}

export interface LedgerEntry { issue: string; at: string; url: string; attachmentId?: string; reason: string; taskId?: string }
const ledgerPath = (dataDir: string, sessionId: string) => join(tracesDir(dataDir), `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.uploads.json`);
export function readLedger(dataDir: string, sessionId: string): LedgerEntry[] {
	const path = ledgerPath(dataDir, sessionId);
	if (!existsSync(path)) return [];
	try { const v = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function appendLedger(dataDir: string, sessionId: string, entry: LedgerEntry) {
	mkdirSync(tracesDir(dataDir), { recursive: true, mode: 0o700 });
	writeFileSync(ledgerPath(dataDir, sessionId), JSON.stringify([...readLedger(dataDir, sessionId), entry], null, 1), { mode: 0o600 });
}
