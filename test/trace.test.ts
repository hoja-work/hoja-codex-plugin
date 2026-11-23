/**
 * Session tracing (HOJA-717): config repair, the recorder, the trace builder, upload, and the runtime wiring that
 * attaches a trace to an issue when its task completes.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUserConfig, traceDetail, traceUpload } from "../src/env.ts";
import { Credentials } from "../src/credentials.ts";
import { buildTrace, displayToolName, fitTrace } from "../src/trace/build.ts";
import { collectTrace, readSubagents } from "../src/trace/collect.ts";
import { readHookRecords, TraceRecorder } from "../src/trace/recorder.ts";
import { clip, clipMiddle, Redactor } from "../src/trace/redact.ts";
import { renderSummary } from "../src/trace/render.ts";
import { readLedger, uploadTrace, traceSubtitle, type FetchLike } from "../src/trace/upload.ts";
import { createRuntime } from "../src/runtime.ts";
import { sessionEnd } from "../src/trace-hook.ts";
import { TRACE_SCHEMA, totalTokens } from "../src/trace/schema.ts";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const OWN = "mcp__plugin_hoja_hoja__";

describe("config", () => {
	it("the 0.3.1 bug: a scheme-less userConfig endpoint is repaired, not passed to fetch", () => {
		const env: Record<string, string> = { HOJA_TOKEN: "t", HOJA_PLUGIN_API_URL: "hoja.hoja.work/graphql", HOJA_PLUGIN_MCP_URL: "hoja.hoja.work/mcp" };
		applyUserConfig(env as any);
		new Credentials(env as any, () => { throw new Error("no cli"); }).apply();
		expect(env.HOJA_API_URL).toBe("https://hoja.hoja.work/graphql");
		expect(env.HOJA_MCP_URL).toBe("https://hoja.hoja.work/mcp");
	});
	it("hook processes read userConfig from CLAUDE_PLUGIN_OPTION_*", () => {
		const env: Record<string, string> = { CLAUDE_PLUGIN_OPTION_HOJA_API_URL: "https://h.example/graphql", CLAUDE_PLUGIN_OPTION_TRACE_UPLOAD: "manual", CLAUDE_PLUGIN_OPTION_TRACE_DETAIL: "metadata" };
		applyUserConfig(env as any);
		expect(env.HOJA_API_URL).toBe("https://h.example/graphql");
		expect(traceUpload(env as any)).toBe("manual");
		expect(traceDetail(env as any)).toBe("metadata");
	});
});

describe("redaction", () => {
	it("scrubs credential shapes and secret environment values, keeps the key names", () => {
		const r = new Redactor({ MY_SERVICE_TOKEN: "supersecretvalue123", PATH: "/usr/bin" });
		const out = r.scrub("curl -H 'Authorization: Bearer abcdefgh12345678' x; echo supersecretvalue123 sk-ant-api03-abcdefghijklmnopqrstuv ghp_abcdefghijklmnopqrstuvwxyz0123 /usr/bin");
		expect(out).not.toMatch(/abcdefgh12345678|supersecretvalue123|sk-ant-api03|ghp_abc/);
		expect(out).toContain("Authorization: Bearer [redacted]");
		expect(out).toContain("/usr/bin");
	});
	it("clips with the dropped length, or with a plain ellipsis for labels", () => {
		expect(clip("abcdef", 3)).toBe("abc… [+3 chars]");
		expect(clip("abc def", 4, false)).toBe("abc…");
	});
});

// A small Claude Code session: one prompt, a model call that runs Bash (ok) and Edit (blocked by the gate),
// an Agent call with its own subagent transcript, and the final answer.
function session(dir: string) {
	const t0 = Date.parse("2026-11-23T10:00:00.000Z");
	const at = (s: number) => new Date(t0 + s * 1000).toISOString();
	const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 });
	const transcriptPath = join(dir, "s-1.jsonl");
	writeFileSync(transcriptPath, [
		{ type: "ai-title", aiTitle: "Fix the flaky test", sessionId: "s-1" },
		{ type: "user", timestamp: at(0), cwd: dir, gitBranch: "main", version: "2.1.326", message: { role: "user", content: "fix the flaky test token=abcdefgh12345678" } },
		{ type: "assistant", timestamp: at(3), requestId: "req_1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", stop_reason: null, usage: usage(5, 50), content: [{ type: "text", text: "Running the tests." }] } },
		{ type: "assistant", timestamp: at(3), requestId: "req_1", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", usage: usage(5, 60), content: [{ type: "tool_use", id: "tu_bash", name: "Bash", input: { command: "npm test" } }, { type: "tool_use", id: "tu_edit", name: "Edit", input: { file_path: `${dir}/src/a.ts`, old_string: "a", new_string: "b" } }] } },
		{ type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_bash", content: "1 failed" }] } },
		{ type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_edit", is_error: true, content: "[TASK ENFORCEMENT - BLOCKED] no task" }] } },
		{ type: "assistant", timestamp: at(12), message: { id: "m2", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", usage: usage(3, 20), content: [{ type: "tool_use", id: "tu_agent", name: "Agent", input: { description: "Find the race", prompt: "look" } }, { type: "tool_use", id: "tu_task", name: OWN + "TaskManage", input: { operations: [{ key: "a", op: "create", subject: "Fix flaky test", status: "in_progress" }] } }] } },
		{ type: "user", timestamp: at(30), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_agent", content: [{ type: "text", text: "race found" }] }] } },
		{ type: "user", timestamp: at(30), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_task", content: [{ type: "text", text: "{}" }] }] } },
		{ type: "assistant", timestamp: at(35), message: { id: "m3", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: usage(2, 10), content: [{ type: "text", text: "Done." }] } },
		{ type: "system", subtype: "turn_duration", timestamp: at(35), durationMs: 35000 },
		{ type: "user", timestamp: at(40), isMeta: true, message: { role: "user", content: "<system-reminder>ignored</system-reminder>" } },
	].map(line).join(""));
	const sub = join(dir, "s-1", "subagents");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, "agent-ag1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find the race", toolUseId: "tu_agent" }));
	writeFileSync(join(sub, "agent-ag1.jsonl"), [
		{ type: "user", timestamp: at(13), isSidechain: true, message: { role: "user", content: "look for the race" } },
		{ type: "assistant", timestamp: at(15), message: { id: "s1", role: "assistant", model: "claude-haiku-5-5", stop_reason: "tool_use", usage: usage(100, 30), content: [{ type: "tool_use", id: "tu_grep", name: "Grep", input: { pattern: "setTimeout" } }] } },
		{ type: "user", timestamp: at(16), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_grep", content: "src/a.ts:3" }] } },
		{ type: "assistant", timestamp: at(29), message: { id: "s2", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", usage: usage(10, 5), content: [{ type: "text", text: "race found" }] } },
	].map(line).join(""));
	const hooks = [
		{ at: at(3.1), event: "PreToolUse", tool: "Bash", toolUseId: "tu_bash", input: "npm test" },
		{ at: at(3.1), event: "PreToolUse", tool: "Edit", toolUseId: "tu_edit", decision: "deny" as const, reason: "[TASK ENFORCEMENT - BLOCKED] create a task first" },
		{ at: at(8.9), event: "PostToolUse", tool: "Bash", toolUseId: "tu_bash", durationMs: 5700, output: "1 failed" },
		{ at: at(13), event: "SubagentStart", agentId: "ag1", agentType: "Explore" },
		{ at: at(29), event: "SubagentStop", agentId: "ag1", agentType: "Explore" },
		{ at: at(20), event: "Notification", message: "Claude needs your permission", notificationType: "permission_prompt" },
	];
	return { transcriptPath, hooks, at };
}

describe("trace builder", () => {
	it("builds turns, model calls, tool spans, subagents and totals from transcript + hooks", () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-trace-"));
		const { transcriptPath, hooks } = session(dir);
		const trace = buildTrace({ sessionId: "s-1", transcript: readFileSync(transcriptPath, "utf8"), subagents: readSubagents(transcriptPath), hooks, plugin: "hoja@test", redactor: new Redactor({}) });
		expect(trace.schema).toBe(TRACE_SCHEMA);
		expect(trace.session).toMatchObject({ title: "Fix the flaky test", basis: "transcript", gitBranch: "main", durationMs: 35000 });
		expect(trace.session.models.sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
		expect(trace.source.hostVersion).toBe("2.1.326");
		// One genuine turn: the meta reminder at 40s is not a prompt.
		const turns = trace.spans.filter(s => s.kind === "turn");
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ durationMs: 35000, status: "ok" });
		expect(turns[0].attrs!.prompt).toContain("token=[redacted]");
		// Model calls: per-block transcript lines of one API message are one span; usage counted once.
		const llm = trace.spans.filter(s => s.kind === "llm");
		expect(llm).toHaveLength(5);
		expect(llm[0]).toMatchObject({ parentId: "turn:1", durationMs: 3000, attrs: { model: "claude-opus-5-5", request_id: "req_1", stopReason: "tool_use" } });
		expect(llm[0].attrs!.usage).toEqual({ input_tokens: 5, output_tokens: 60, cache_read_tokens: 1000, cache_creation_tokens: 10 });
		expect(trace.totals.tokens.output_tokens).toBe(60 + 20 + 10 + 30 + 5);
		expect(trace.totals.tokensByModel["claude-haiku-5-5"].input_tokens).toBe(110);
		// Tools: hook duration wins over transcript timestamps; the gate's deny is "blocked", not "error".
		const bash = trace.spans.find(s => s.id === "tool:tu_bash")!;
		expect(trace.spans.find(s => s.id === "tool:tu_edit")!.name).toBe("Edit · src/a.ts");
		expect(bash).toMatchObject({ name: "Bash · npm test", status: "ok", durationMs: 5700, attrs: { tool_name: "Bash", success: true, measured: "hook", output: "1 failed" } });
		const edit = trace.spans.find(s => s.id === "tool:tu_edit")!;
		expect(edit.status).toBe("blocked");
		expect(edit.attrs!.blockedReason).toContain("create a task first");
		expect(trace.spans.find(s => s.id === "tool:tu_task")!.name).toBe("TaskManage · create Fix flaky test");
		// The subagent nests under its Agent call; its own calls nest under it.
		const agent = trace.spans.find(s => s.kind === "subagent")!;
		expect(agent).toMatchObject({ id: "agent:ag1", parentId: "tool:tu_agent", name: "Explore · Find the race", durationMs: 16000, agentId: "ag1" });
		expect(trace.spans.find(s => s.id === "tool:tu_grep")).toMatchObject({ parentId: "agent:ag1", agentId: "ag1" });
		expect(trace.totals).toMatchObject({ turns: 1, llmCalls: 5, toolCalls: 5, toolErrors: 0, blocked: 1, subagents: 1, filesTouched: ["src/a.ts"] });
		expect(trace.tools.map(t => t.name)).toContain("Bash");
		expect(trace.events.map(e => e.kind)).toEqual(expect.arrayContaining(["gate.block", "notification", "task"]));
		expect(trace.events.find(e => e.kind === "task")!.message).toBe("Task created: Fix flaky test");
		const summary = renderSummary(trace);
		expect(summary).toContain("Fix the flaky test");
		expect(summary).toContain("1 blocked by the gate");
	});
	it("metadata detail keeps timings and tokens but no prompts, inputs or outputs", () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-trace-"));
		const { transcriptPath, hooks } = session(dir);
		const trace = buildTrace({ sessionId: "s-1", transcript: readFileSync(transcriptPath, "utf8"), subagents: readSubagents(transcriptPath), hooks, plugin: "hoja@test", detail: "metadata", redactor: new Redactor({}) });
		const json = JSON.stringify(trace);
		expect(json).not.toMatch(/npm test|flaky test token|1 failed|race found|look for the race/);
		expect(trace.session.title).toBeUndefined();
		expect(trace.spans.find(s => s.id === "tool:tu_bash")!.name).toBe("Bash");
		expect(totalTokens(trace.totals.tokens)).toBeGreaterThan(0);
	});
	it("reads a real Codex rollout: turns, per-request tokens, tool calls, the gate's block, rejected TaskManage calls", () => {
		const transcript = readFileSync(join(__dirname, "fixtures", "codex-rollout.jsonl"), "utf8");
		const trace = buildTrace({ sessionId: "01a1ebd9", transcript, hooks: [], plugin: "p", redactor: new Redactor({}) });
		expect(trace.source).toMatchObject({ host: "codex", hostVersion: "0.169.0" });
		expect(trace.session).toMatchObject({ basis: "transcript", models: ["wafer-glm-5.2"], durationMs: 12009 });
		const turn = trace.spans.find(s => s.kind === "turn")!;
		expect(turn).toMatchObject({ durationMs: 12018, status: "ok" });
		expect(turn.name).toMatch(/^Run: touch proof.txt/);
		const llm = trace.spans.filter(s => s.kind === "llm");
		expect(llm).toHaveLength(8);
		// OpenAI's input_tokens includes the cached ones; the trace keeps them apart, like Claude Code's names.
		expect(llm[1].attrs!.usage).toEqual({ input_tokens: 26351, output_tokens: 149, cache_read_tokens: 5248, cache_creation_tokens: 0 });
		expect(llm[0].attrs!.request_id).toMatch(/^chatcmpl-/);
		expect(trace.totals.tokens.output_tokens).toBe(695);
		const tools = trace.spans.filter(s => s.kind === "tool");
		expect(tools.map(t => t.status)).toEqual(["blocked", "ok", "ok", "ok", "error", "error", "ok"]);
		expect(tools[0].name).toBe("Bash · touch proof.txt");
		expect(tools[1].name).toBe("TaskManage · create touch proof.txt");
		expect(tools[2].attrs!.exitCode).toBe(0);
		expect(trace.totals).toMatchObject({ turns: 1, llmCalls: 8, toolCalls: 7, blocked: 1, toolErrors: 2 });
		expect(traceSubtitle(trace)).toMatch(/^Codex trace · 12s · 1 turn · 7 tool calls/);
	});
	it("falls back to hooks alone when there is no transcript", () => {
		const trace = buildTrace({
			sessionId: "s-2", plugin: "hoja@test", redactor: new Redactor({}), hooks: [
				{ at: "2026-11-23T10:00:00.000Z", event: "UserPromptSubmit", prompt: "do it" },
				{ at: "2026-11-23T10:00:01.000Z", event: "PreToolUse", tool: "Bash", toolUseId: "a", input: "ls" },
				{ at: "2026-11-23T10:00:02.000Z", event: "PostToolUseFailure", tool: "Bash", toolUseId: "a", error: "boom", durationMs: 900 },
				{ at: "2026-11-23T10:00:03.000Z", event: "Stop" },
			],
		});
		expect(trace.session.basis).toBe("hooks");
		expect(trace.spans.find(s => s.kind === "turn")).toMatchObject({ name: "do it", durationMs: 3000, status: "ok" });
		expect(trace.spans.find(s => s.kind === "tool")).toMatchObject({ parentId: "turn:1", status: "error", durationMs: 900, attrs: { error: "boom" } });
		expect(trace.totals.toolErrors).toBe(1);
	});
	it("names tools the way people read them", () => {
		expect(displayToolName(OWN + "TaskManage")).toBe("TaskManage");
		expect(displayToolName("mcp__plugin_hoja_hoja-api__hoja_issue")).toBe("hoja/hoja_issue");
		expect(displayToolName("mcp__github__get_issue")).toBe("github/get_issue");
		expect(displayToolName("Bash")).toBe("Bash");
	});
	it("keeps whole content: a long tool output's tail (where the error is) survives", () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-trace-"));
		const transcriptPath = join(dir, "t.jsonl");
		const long = "line of test output\n".repeat(5000) + "FAIL test/calc.test.js: expected 3, got 4";
		writeFileSync(transcriptPath, [
			{ type: "user", timestamp: "2026-11-23T10:00:00.000Z", message: { role: "user", content: "run tests" } },
			{ type: "assistant", timestamp: "2026-11-23T10:00:01.000Z", message: { id: "m", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm test" } }] } },
			{ type: "user", timestamp: "2026-11-23T10:00:05.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: long }] } },
		].map(line).join(""));
		const trace = buildTrace({ sessionId: "s", transcript: readFileSync(transcriptPath, "utf8"), hooks: [], plugin: "p", redactor: new Redactor({}) });
		const error = trace.spans.find(s => s.id === "tool:b")!.attrs!.error as string;
		expect(error).toBe(long);
		expect(trace.truncated).toBeUndefined();
	});
	it("over the upload budget, the largest contents shrink first, head and tail kept, spans intact", () => {
		const big = "head-" + "x".repeat(50_000) + "-tail";
		const trace = buildTrace({ sessionId: "s", plugin: "p", redactor: new Redactor({}), hooks: [] });
		for (let i = 0; i < 40; i++) trace.spans.push({ id: `t${i}`, kind: "tool", name: "Bash", start: trace.session.start, status: "ok", attrs: { output: big, input: "npm test" } });
		const fitted = fitTrace(trace, 1_000_000);
		expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1_000_000);
		expect(fitted.spans.length).toBe(41);
		const out = fitted.spans[1].attrs!.output as string;
		expect(out.startsWith("head-")).toBe(true);
		expect(out.endsWith("-tail")).toBe(true);
		expect(out).toMatch(/chars omitted/);
		expect(fitted.spans[1].attrs!.input).toBe("npm test");
		expect(fitted.truncated![0]).toMatch(/content fields over .* trimmed \(head and tail kept\)/);
	});
	it("follows Claude Code's persisted-output stub to the whole saved result, only inside the session's tool-results", () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-trace-"));
		const transcriptPath = join(dir, "s-9.jsonl");
		const results = join(dir, "s-9", "tool-results");
		mkdirSync(results, { recursive: true });
		const whole = Array.from({ length: 3000 }, (_, i) => `output line ${i + 1}`).join("\n");
		writeFileSync(join(results, "abc.txt"), whole);
		writeFileSync(join(dir, "secret.txt"), "do not read");
		const stub = (p: string) => `<persisted-output>\nOutput too large (48.7KB). Full output saved to: ${p}\n\nPreview (first 2KB):\noutput line 1\n...\n</persisted-output>`;
		writeFileSync(transcriptPath, [
			{ type: "user", timestamp: "2026-11-23T10:00:00.000Z", message: { role: "user", content: "go" } },
			{ type: "assistant", timestamp: "2026-11-23T10:00:01.000Z", message: { id: "m", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "cat big.txt" } }, { type: "tool_use", id: "b", name: "Bash", input: { command: "x" } }] } },
			{ type: "user", timestamp: "2026-11-23T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: stub(join(results, "abc.txt")) }] } },
			{ type: "user", timestamp: "2026-11-23T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: stub(join(results, "..", "..", "secret.txt")) }] } },
		].map(line).join(""));
		const trace = collectTrace({ dataDir: join(dir, "data"), sessionId: "s-9", transcriptPath, env: {} });
		const a = trace.spans.find(s => s.id === "tool:a")!.attrs!;
		expect(a.output).toBe(whole);
		expect(a.persisted).toBe(true);
		const b = trace.spans.find(s => s.id === "tool:b")!.attrs!;
		expect(b.output).toContain("<persisted-output>");
		expect(JSON.stringify(trace)).not.toContain("do not read");
	});
	it("clipMiddle keeps the head and the tail", () => {
		const out = clipMiddle("a".repeat(100) + "END", 20);
		expect(out.startsWith("aaaaaaaaaaaa")).toBe(true);
		expect(out.endsWith("aaaaaEND")).toBe(true);
		expect(out).toContain("[83 chars omitted]");
	});
});

describe("recorder", () => {
	it("writes one scrubbed line per hook event, including the gate's decision", () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-rec-"));
		const rec = new TraceRecorder({ dataDir: dir, redactor: new Redactor({ X_TOKEN: "zzzzzzzzzzzz" }) });
		rec.record("s-1", "PreToolUse", { tool_name: "Bash", tool_use_id: "a", tool_input: { command: "echo zzzzzzzzzzzz" } }, { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no task" } });
		rec.record("s-1", "PostToolUse", { tool_name: "Bash", tool_use_id: "b", duration_ms: "120" }, {}, "ok");
		const records = readHookRecords(dir, "s-1");
		expect(records[0]).toMatchObject({ event: "PreToolUse", decision: "deny", reason: "no task", input: "echo [redacted]" });
		expect(records[1]).toMatchObject({ event: "PostToolUse", durationMs: 120, output: "ok" });
	});
});

// Records what a Hoja server would receive.
function fakeHoja(options: { failUpload?: number } = {}) {
	const calls: { url: string; init: any }[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		if (url.endsWith("/api/uploads")) {
			if (options.failUpload) return { status: options.failUpload, text: async () => "{}" };
			return { status: 200, text: async () => JSON.stringify({ url: "/api/uploads/abc123.json", title: "t", contentType: "application/json" }) };
		}
		const body = JSON.parse(init.body);
		return { status: 200, text: async () => JSON.stringify({ data: { attachmentCreate: { success: body.variables.input.issueId !== "NOPE-1", attachment: { id: "att-1", url: body.variables.input.url } } } }) };
	};
	return { calls, fetchImpl };
}

describe("upload", () => {
	it("stores the JSON through /api/uploads and attaches it with attachmentCreate", async () => {
		const trace = buildTrace({ sessionId: "abcdef1234", plugin: "p", redactor: new Redactor({}), hooks: [{ at: "2026-11-23T10:00:00.000Z", event: "UserPromptSubmit", prompt: "x" }] });
		const hoja = fakeHoja();
		const result = await uploadTrace(trace, "HOJA-1", { graphqlUrl: "https://h.example/graphql", token: "tok", fetchImpl: hoja.fetchImpl });
		expect(hoja.calls[0].url).toBe("https://h.example/api/uploads");
		expect(hoja.calls[0].init.headers.authorization).toBe("Bearer tok");
		const file = hoja.calls[0].init.body.get("file") as File;
		expect(file.name).toMatch(/^claude-code-abcdef12-.*\.trace\.json$/);
		expect(JSON.parse(await file.text()).schema).toBe(TRACE_SCHEMA);
		const attach = JSON.parse(hoja.calls[1].init.body);
		expect(hoja.calls[1].url).toBe("https://h.example/graphql");
		expect(attach.variables.input).toMatchObject({ issueId: "HOJA-1", url: "/api/uploads/abc123.json", subtitle: traceSubtitle(trace) });
		expect(attach.variables.input.title).toMatch(/\.trace\.json$/);
		expect(result.attachmentId).toBe("att-1");
	});
	it("says why an upload failed", async () => {
		const trace = buildTrace({ sessionId: "s", plugin: "p", redactor: new Redactor({}), hooks: [] });
		await expect(uploadTrace(trace, "HOJA-1", { graphqlUrl: "https://h.example/graphql", token: "t", fetchImpl: fakeHoja({ failUpload: 401 }).fetchImpl })).rejects.toThrow(/rejected the token/);
		await expect(uploadTrace(trace, "NOPE-1", { graphqlUrl: "https://h.example/graphql", token: "t", fetchImpl: fakeHoja().fetchImpl })).rejects.toThrow(/did not attach/);
	});
});

describe("runtime: a completed, linked task gets its trace attached", () => {
	function fixture(upload: "completion" | "manual" = "completion") {
		const dir = mkdtempSync(join(tmpdir(), "hoja-rt-"));
		const { transcriptPath } = session(dir);
		const hoja = fakeHoja();
		const env = { HOJA_API_URL: "https://h.example/graphql", HOJA_TOKEN: "tok" };
		const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block", trace: { upload, fetchImpl: hoja.fetchImpl, env } });
		const hook = (event: string, extra: Record<string, unknown> = {}) => rt.bridge.handle(event, { session_id: "s-1", transcript_path: transcriptPath, cwd: dir, agent_id: "", event, ...extra });
		const taskManage = async (args: any) => {
			const tool = rt.shim.tools.get("TaskManage")!;
			const result = await tool.execute("c", args, undefined, undefined, rt.shim.ctx());
			const content = await rt.shim.emitToolResult({ toolName: "TaskManage", toolCallId: "c", input: args, content: result.content, isError: result.isError === true });
			return content.map((c: any) => c.text).join("\n");
		};
		return { dir, rt, hook, hoja, taskManage, env };
	}

	it("uploads once, when the task completes, and tells the model", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "go" });
		await f.taskManage({ operations: [{ key: "a", op: "create", subject: "Fix it", status: "in_progress", active: true, questions: [{ id: "q", text: "Does README exist?" }] }] });
		// What hoja-mode journals once it has published the task.
		f.rt.shim.appendEntry("hoja-task-link", { taskId: "1", state: "linked", identifier: "HOJA-9", at: new Date().toISOString() });
		writeFileSync(join(f.dir, "README.md"), "# hi\n");
		const done = await f.taskManage({ operations: [{ key: "b", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "yes", evidence: "README.md" }] }] });
		expect(done).toContain("Hoja trace: attached this session's trace to HOJA-9");
		expect(done).toContain("full content (prompts, tool inputs and outputs, model responses) with secrets scrubbed");
		const uploads = f.hoja.calls.filter(c => c.url.endsWith("/api/uploads"));
		expect(uploads).toHaveLength(1);
		const trace = JSON.parse(await (uploads[0].init.body.get("file") as File).text());
		expect(trace.tasks[0]).toMatchObject({ id: "1", issue: "HOJA-9", status: "completed", questions: [{ id: "q", answered: true }] });
		expect(trace.issues).toEqual(["HOJA-9"]);
		// A later TaskManage call does not upload again.
		await f.taskManage({ operations: [{ key: "c", op: "list" }] });
		expect(f.hoja.calls.filter(c => c.url.endsWith("/api/uploads"))).toHaveLength(1);
		expect(readLedger(join(f.dir, "data"), "s-1")).toHaveLength(1);
	});

	it("manual mode never uploads on its own; /hoja:trace upload does", async () => {
		const f = fixture("manual");
		await f.hook("UserPromptSubmit", { prompt: "go" });
		f.rt.shim.appendEntry("hoja-task-link", { taskId: "1", state: "linked", identifier: "HOJA-9" });
		await f.taskManage({ operations: [{ key: "a", op: "create", subject: "x", status: "completed" }] });
		expect(f.hoja.calls).toHaveLength(0);
		const out = await f.hook("UserPromptSubmit", { prompt: "/hoja:trace upload hoja-12" }) as any;
		expect(out.decision).toBe("block");
		expect(out.reason).toMatch(/✓ HOJA-12: .*Claude Code trace/);
		const summary = await f.hook("UserPromptExpansion", { command_name: "hoja:trace", command_args: "" }) as any;
		expect(summary.reason).toContain("Session trace · Fix the flaky test");
		expect(summary.reason).toContain("Uploads are manual");
	});

	it("hoja_trace summary is read-only for the gate; upload is gated", async () => {
		const f = fixture();
		const pre = (action: string) => f.hook("PreToolUse", { tool_name: OWN + "hoja_trace", tool_input: JSON.stringify({ action }), tool_use_id: `p-${action}` });
		expect(await pre("summary")).toEqual({});
		expect((await pre("upload") as any).hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	it("the bridge records every hook event, and SessionEnd finishes the trace from disk", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "go" });
		await f.hook("PreToolUse", { tool_name: "Write", tool_input: JSON.stringify({ file_path: "x" }), tool_use_id: "w1" });
		await f.hook("SubagentStart", { agent_id: "ag9", agent_type: "Explore" });
		const records = readHookRecords(join(f.dir, "data"), "s-1");
		expect(records.map(r => r.event)).toEqual(["UserPromptSubmit", "PreToolUse", "SubagentStart"]);
		expect(records[1]).toMatchObject({ tool: "Write", decision: "deny" });
		f.rt.shim.appendEntry("hoja-task-link", { taskId: "1", state: "linked", identifier: "HOJA-5" });
		const lines = await sessionEnd({ session_id: "s-1", transcript_path: join(f.dir, "s-1.jsonl"), cwd: f.dir, reason: "prompt_input_exit" }, { ...f.env, HOJA_PLUGIN_DATA: join(f.dir, "data"), HOJA_PLUGIN_TRACE_UPLOAD: "manual" });
		expect(lines[0]).toMatch(/trace saved: .*s-1\.trace\.json/);
		const saved = collectTrace({ dataDir: join(f.dir, "data"), sessionId: "s-1", env: {} });
		expect(saved.events.map(e => e.message)).toContain("Session ended (prompt_input_exit)");
		expect(saved.spans.some(s => s.id === "tool:tu_bash")).toBe(true);
	});
});
