/** `/hoja:trace` and the `hoja_trace` tool: a trace as a terminal-width summary. */
import { totalTokens, type HojaTrace, type TraceSpan } from "./schema.ts";

export function formatDuration(ms: number | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "–";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	const m = Math.floor(s / 60), rs = Math.round(s % 60);
	if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
	const h = Math.floor(m / 60), rm = m % 60;
	return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

const bar = (part: number, whole: number, width = 18) => {
	const n = whole > 0 ? Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * width)) : 0;
	return "█".repeat(n) + "░".repeat(width - n);
};
const icon = (s: TraceSpan["status"]) => s === "ok" ? "✓" : s === "blocked" ? "⊘" : s === "running" ? "…" : "✗";

export function renderSummary(trace: HojaTrace, extra: { path?: string; uploads?: { issue: string; at: string }[] } = {}): string {
	const t = trace.totals;
	const lines: string[] = [];
	lines.push(`Session trace${trace.session.title ? ` · ${trace.session.title}` : ""}`);
	lines.push(`  ${formatDuration(trace.session.durationMs)} · ${t.turns} turn${t.turns === 1 ? "" : "s"} · ${t.llmCalls} model calls · ${t.toolCalls} tool calls` +
		`${t.toolErrors ? ` (${t.toolErrors} failed)` : ""}${t.blocked ? ` · ${t.blocked} blocked by the gate` : ""}${t.subagents ? ` · ${t.subagents} subagents` : ""}${t.compactions ? ` · ${t.compactions} compactions` : ""}`);
	if (trace.session.models.length) lines.push(`  Model     ${trace.session.models.join(", ")}`);
	if (totalTokens(t.tokens)) lines.push(`  Tokens    ${formatTokens(totalTokens(t.tokens))} total · in ${formatTokens(t.tokens.input_tokens)} · out ${formatTokens(t.tokens.output_tokens)} · cache read ${formatTokens(t.tokens.cache_read_tokens)} · cache write ${formatTokens(t.tokens.cache_creation_tokens)}`);
	const busy = t.llmMs + t.toolMs;
	if (busy) {
		const parallel = busy > trace.session.durationMs * 1.05 ? "  (summed; subagents and parallel calls overlap)" : "";
		lines.push(`  Waiting   model ${bar(t.llmMs, busy, 12)} ${formatDuration(t.llmMs)} · tools ${bar(t.toolMs, busy, 12)} ${formatDuration(t.toolMs)}${parallel}`);
	}
	if (trace.tools.length) {
		lines.push("", "  Tool            calls  failed  blocked     time");
		for (const s of trace.tools.slice(0, 8))
			lines.push(`  ${s.name.padEnd(15).slice(0, 15)} ${String(s.calls).padStart(5)}  ${String(s.errors || "").padStart(6)}  ${String(s.blocked || "").padStart(7)}  ${formatDuration(s.totalMs).padStart(7)}`);
		if (trace.tools.length > 8) lines.push(`  … ${trace.tools.length - 8} more`);
	}
	const slow = trace.spans.filter(s => s.kind === "tool" && s.durationMs).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 3);
	if (slow.length) { lines.push("", "  Slowest"); for (const s of slow) lines.push(`  ${icon(s.status)} ${formatDuration(s.durationMs).padStart(7)}  ${s.name.slice(0, 90)}`); }
	const failed = trace.spans.filter(s => s.kind === "tool" && (s.status === "error" || s.status === "blocked")).slice(-3);
	if (failed.length) { lines.push("", "  Recent failures"); for (const s of failed) lines.push(`  ${icon(s.status)} ${s.name.slice(0, 90)}`); }
	if (t.filesTouched.length) lines.push("", `  Files     ${t.filesTouched.slice(0, 6).join(", ")}${t.filesTouched.length > 6 ? ` +${t.filesTouched.length - 6}` : ""}`);
	if (trace.issues.length) lines.push(`  Issues    ${trace.issues.join(", ")}`);
	for (const u of extra.uploads ?? []) lines.push(`  Uploaded  → ${u.issue} at ${u.at.slice(11, 16)} UTC`);
	if (extra.path) lines.push(`  Saved     ${extra.path}`);
	if (trace.truncated?.length) lines.push(`  Note      ${trace.truncated.join("; ")}`);
	return lines.join("\n");
}
