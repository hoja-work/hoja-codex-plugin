/**
 * Antigravity CLI host (HOJA-727): hook translation, the gate under agy's shapes, the socket that carries command
 * hooks to the MCP server, agy transcripts for evidence and traces. Payload shapes are the ones agy 1.5.14 sent to a
 * probe plugin; the transcripts in test/fixtures are real agy runs (paths replaced).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyToBridge, agyToolCall, bridgeToAgy, failOpen } from "../src/agy.ts";
import { findSocket, listen, request, socketPath } from "../src/agy-socket.ts";
import { handleAgyHook } from "../src/agy-hook.ts";
import { createRuntime } from "../src/runtime.ts";
import { parseAgyTranscript, parseTranscript } from "../src/transcript.ts";
import { buildTrace } from "../src/trace/build.ts";
import { Redactor } from "../src/trace/redact.ts";
import { traceSubtitle } from "../src/trace/upload.ts";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
let previousHost: string | undefined;
beforeAll(() => { previousHost = process.env.HOJA_PLUGIN_HOST; process.env.HOJA_PLUGIN_HOST = "antigravity"; });
afterAll(() => { if (previousHost === undefined) delete process.env.HOJA_PLUGIN_HOST; else process.env.HOJA_PLUGIN_HOST = previousHost; });

const common = (extra: Record<string, unknown> = {}) => ({
	conversationId: "conv-1", transcriptPath: "/nonexistent/transcript_full.jsonl", cwd: "/work/demo",
	workspacePaths: ["/work/demo"], modelName: "gemini-4-neon-high", lastUserInput: "go", ...extra,
});
const tool = (name: string, args: Record<string, unknown>, id = `call_${name}`) => ({ id, name, args });

describe("agy hook shapes", () => {
	it("unwraps call_mcp_tool and maps built-ins onto the names the gate classifies", () => {
		expect(agyToolCall(tool("call_mcp_tool", { ServerName: "hoja_hoja", ToolName: "TaskManage", Arguments: { operations: [] } }))).toEqual({ tool_name: "mcp__hoja_hoja__TaskManage", tool_input: { operations: [] }, tool_use_id: "call_call_mcp_tool" });
		expect(agyToolCall(tool("run_command", { CommandLine: "ls -la" })).tool_input.command).toBe("ls -la");
		expect(agyToolCall(tool("write_file", { Path: "/w/a.txt", Content: "x" }))).toMatchObject({ tool_name: "Write", tool_input: { file_path: "/w/a.txt", content: "x" } });
		expect(agyToolCall(tool("read_file", { Path: "/w/a.txt" })).tool_name).toBe("Read");
		expect(agyToolCall(tool("brand_new_tool", { x: 1 })).tool_name).toBe("brand_new_tool");
	});
	it("maps agy events onto the bridge's, and the bridge's answers back", () => {
		expect(agyToBridge("PreInvocation", common({ invocationNum: 0, lastUserInput: "hoja:tasks" }))).toMatchObject({ event: "UserPromptSubmit", payload: { session_id: "conv-1", prompt: "hoja:tasks" } });
		expect(agyToBridge("PreInvocation", common({ invocationNum: 2 })).event).toBe("PreInvocation");
		expect(agyToBridge("PostInvocation", common()).event).toBe("PostToolBatch");
		expect(agyToBridge("PostToolUse", common({ toolCall: tool("run_command", { CommandLine: "false" }), error: "exit status 1", stepIdx: 4 }))).toMatchObject({ event: "PostToolUseFailure", payload: { error: "exit status 1", step_idx: 4 } });
		expect(bridgeToAgy("PreToolUse", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no task" } })).toEqual({ decision: "deny", reason: "no task" });
		// Never "allow": that would bypass Antigravity's own permissions. "ask" defers to them; {} would deny.
		expect(bridgeToAgy("PreToolUse", {})).toEqual({ decision: "ask" });
		expect(bridgeToAgy("PreToolUse", { hookSpecificOutput: { additionalContext: "nudge" } })).toEqual({ decision: "ask" });
		expect(bridgeToAgy("PreInvocation", { decision: "block", reason: "board" })).toEqual({ injectSteps: [{ systemMessage: { systemMessage: "board" } }], terminationBehavior: "terminate" });
		expect(bridgeToAgy("PostInvocation", { hookSpecificOutput: { additionalContext: "ctx" } })).toEqual({ injectSteps: [{ systemMessage: { systemMessage: "ctx" } }] });
		expect(bridgeToAgy("Stop", { decision: "continue", reason: "focus a task" })).toEqual({ decision: "continue", reason: "focus a task" });
		expect(failOpen("PreToolUse")).toEqual({ decision: "ask" });
		// The plugin vouches only for its own bookkeeping tools; the hosted API and everything else stay with agy.
		const own = (tool: string, input: Record<string, unknown> = {}) => bridgeToAgy("PreToolUse", {}, { tool_name: `mcp__hoja_hoja__${tool}`, tool_input: input });
		expect(own("TaskManage")).toEqual({ decision: "allow" });
		expect(own("hoja_setup")).toEqual({ decision: "allow" });
		expect(own("hoja_trace", { action: "summary" })).toEqual({ decision: "allow" });
		expect(own("hoja_trace", { action: "upload" })).toEqual({ decision: "ask" });
		expect(own("hoja_project", { action: "create" })).toEqual({ decision: "ask" });
		expect(bridgeToAgy("PreToolUse", {}, { tool_name: "mcp__hoja_hoja-api__hoja_issueCreate", tool_input: {} })).toEqual({ decision: "ask" });
		expect(bridgeToAgy("PreToolUse", {}, { tool_name: "Write", tool_input: {} })).toEqual({ decision: "ask" });
		// A deny always wins, even for the plugin's own tools.
		expect(bridgeToAgy("PreToolUse", { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "x" } }, { tool_name: "mcp__hoja_hoja__TaskManage", tool_input: {} })).toEqual({ decision: "deny", reason: "x" });
		expect(failOpen("Stop")).toEqual({});
	});
});

describe("the gate under Antigravity", () => {
	function setup() {
		const dir = mkdtempSync(join(tmpdir(), "hoja-agy-"));
		const transcript = join(dir, "transcript_full.jsonl");
		writeFileSync(transcript, JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T00:00:00Z", content: "<USER_REQUEST>\ngo\n</USER_REQUEST>" }) + "\n");
		const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block", host: "antigravity" });
		const hook = async (event: string, extra: Record<string, unknown> = {}) => {
			const { event: e, payload } = agyToBridge(event, common({ transcriptPath: transcript, cwd: dir, ...extra }));
			return bridgeToAgy(event, await rt.bridge.handle(e, payload));
		};
		return { dir, rt, hook };
	}
	it("denies a write without a focused task, defers reads to Antigravity, never blocks TaskManage", async () => {
		const { hook } = setup();
		expect(await hook("PreToolUse", { toolCall: tool("write_file", { Path: "/w/a.txt", Content: "x" }), stepIdx: 3 })).toMatchObject({ decision: "deny", reason: expect.stringContaining("TASK ENFORCEMENT") });
		expect(await hook("PreToolUse", { toolCall: tool("read_file", { Path: "/w/a.txt" }), stepIdx: 5 })).toEqual({ decision: "ask" });
		expect(await hook("PreToolUse", { toolCall: tool("run_command", { CommandLine: "ls" }), stepIdx: 6 })).toEqual({ decision: "ask" });
		expect(await hook("PreToolUse", { toolCall: tool("run_command", { CommandLine: "touch x" }), stepIdx: 7 })).toMatchObject({ decision: "deny" });
		expect(await hook("PreToolUse", { toolCall: tool("call_mcp_tool", { ServerName: "hoja_hoja", ToolName: "TaskManage", Arguments: { operations: [{ key: "a", op: "list" }] } }), stepIdx: 8 })).toEqual({ decision: "ask" });
		expect(await hook("PreToolUse", { toolCall: tool("command_status", { CommandId: "1" }), stepIdx: 9 })).toEqual({ decision: "ask" });
	});
	it("answers hoja:tasks locally and ends the turn before the model is called", async () => {
		const { hook } = setup();
		const out: any = await hook("PreInvocation", { invocationNum: 0, lastUserInput: "hoja:tasks" });
		expect(out.terminationBehavior).toBe("terminate");
		expect(out.injectSteps[0].systemMessage.systemMessage).toContain("All tasks:");
	});
	it("opens the gate once a task is focused through the unwrapped MCP name", async () => {
		const { rt, hook } = setup();
		await hook("PreInvocation", { invocationNum: 0, lastUserInput: "write a file" });
		const taskManage = rt.shim.tools.get("TaskManage")!;
		await hook("PreToolUse", { toolCall: tool("call_mcp_tool", { ServerName: "hoja_hoja", ToolName: "TaskManage", Arguments: {} }, "call_tm"), stepIdx: 2 });
		await taskManage.execute(rt.bridge.takeToolCallId("TaskManage") ?? "call_tm", { operations: [{ key: "t", op: "create", subject: "Write a file", status: "in_progress", active: true, questions: [{ id: "q", text: "Exists?" }] }] }, undefined, undefined, rt.shim.ctx());
		expect(await hook("PreToolUse", { toolCall: tool("write_file", { Path: "/w/a.txt", Content: "x" }), stepIdx: 4 })).toEqual({ decision: "ask" });
	});
	it("keeps a pre-tool nudge until the model's next call (agy's PreToolUse cannot carry one)", async () => {
		const { rt, hook } = setup();
		// Simulate a nudge from the pipeline for this call.
		(rt.bridge.pipeline as any).preTool = () => ({ context: "Consider focusing a task." });
		expect(await hook("PreToolUse", { toolCall: tool("read_file", { Path: "/w/a" }), stepIdx: 2 })).toEqual({ decision: "ask" });
		const next: any = await hook("PostInvocation", { invocationNum: 1 });
		expect(next.injectSteps[0].systemMessage.systemMessage).toContain("Consider focusing a task.");
	});
	it("Stop continues a turn that ended on a gate block, in agy's shape", async () => {
		const { dir, hook } = setup();
		const transcript = join(dir, "transcript_full.jsonl");
		writeFileSync(transcript, [
			{ step_index: 0, type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T00:00:00Z", content: "<USER_REQUEST>\nwrite a.txt\n</USER_REQUEST>" },
			{ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T00:00:01Z", tool_calls: [{ name: "write_file", args: { Path: "/w/a.txt", Content: "x" } }] },
			{ step_index: 2, type: "GENERIC", status: "ERROR", created_at: "2026-11-23T00:00:02Z", error: "tool call denied by pre-tool hook: [TASK ENFORCEMENT - BLOCKED] YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK. Create one with TaskManage.", content: "Created At: x\nEncountered error in step execution: tool call denied by pre-tool hook: [TASK ENFORCEMENT - BLOCKED] YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK" },
			{ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T00:00:03Z", content: "I was blocked." },
		].map(e => JSON.stringify(e)).join("\n") + "\n");
		await hook("PreInvocation", { invocationNum: 0, lastUserInput: "write a.txt" });
		const out: any = await hook("Stop", { terminationReason: "NO_TOOL_CALL", continuationActive: false, fullyIdle: true });
		expect(out.decision).toBe("continue");
		expect(out.reason.length).toBeGreaterThan(20);
	});
});

describe("socket transport", () => {
	it("a hook finds its agy ancestor's socket and gets the bridge's answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-sock-"));
		const env = { HOJA_AGY_SOCKET_DIR: dir } as NodeJS.ProcessEnv;
		const path = socketPath(4242, env);
		const server = listen(path, async (m: any) => ({ echo: m.event }));
		await new Promise(r => server.once("listening", r));
		// hook (pid 10) → sh (pid 11) → agy (pid 4242)
		const chain: Record<number, number> = { 10: 11, 11: 4242, 4242: 1 };
		expect(findSocket(env, 10, pid => chain[pid])).toBe(path);
		expect(findSocket({ HOJA_AGY_SOCKET_DIR: join(dir, "none") } as any, 10, pid => chain[pid])).toBeUndefined();
		expect(await request(path, { event: "Stop" })).toEqual({ echo: "Stop" });
		server.close();
	});
	it("handleAgyHook fails open when no server is reachable", async () => {
		const env = { HOJA_AGY_SOCKET: join(tmpdir(), "hoja-no-such.sock"), HOJA_PLUGIN_HOST: "antigravity" } as NodeJS.ProcessEnv;
		expect(await handleAgyHook("PreToolUse", common({ toolCall: tool("write_file", { Path: "/x" }) }), env)).toEqual({ decision: "ask" });
		expect(await handleAgyHook("Stop", common(), env)).toEqual({});
	});
	it("handleAgyHook carries a real gate decision over the socket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-sock2-"));
		const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block", host: "antigravity" });
		const path = join(dir, "s.sock");
		const server = listen(path, (m: any) => rt.bridge.handle(m.event, m.payload));
		await new Promise(r => server.once("listening", r));
		const env = { ...process.env, HOJA_AGY_SOCKET: path, HOJA_PLUGIN_DATA: join(dir, "data") };
		expect(await handleAgyHook("PreToolUse", common({ toolCall: tool("write_file", { Path: "/x", Content: "y" }), stepIdx: 2 }), env)).toMatchObject({ decision: "deny" });
		server.close();
	});
});

describe("agy transcripts", () => {
	it("become Pi messages: user turns, tool calls answered in order, MCP calls by their unwrapped name", () => {
		const messages = parseTranscript(fixture("agy-transcript.jsonl"));
		expect(messages).toEqual(parseAgyTranscript(fixture("agy-transcript.jsonl")));
		expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringMatching(/^First call the probe_echo tool/) }] });
		const results = messages.filter(m => m.role === "toolResult") as any[];
		expect(results.map(r => r.toolName)).toEqual(["Read", "mcp__hojaprobe_hojaprobe__probe_echo", "Bash", "Write"]);
		expect(results[2].content[0].text).toContain("Command exited with code 0");
		expect(results.every(r => !r.isError)).toBe(true);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
	it("a hook denial is an error result", () => {
		const results = parseAgyTranscript(fixture("agy-blocked.jsonl")).filter(m => m.role === "toolResult") as any[];
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolName: "Bash", isError: true });
	});
	it("build a trace: model calls with tokens, tool calls, hook-precise timing, blocked calls", () => {
		const hooks = [
			{ at: "2026-11-23T00:58:44.100Z", event: "UserPromptSubmit", invocationNum: 0 },
			{ at: "2026-11-23T00:58:49.900Z", event: "PreToolUse", tool: "Read", toolUseId: "call_r", stepIdx: 2 },
			{ at: "2026-11-23T00:58:50.020Z", event: "PostToolUse", tool: "Read", toolUseId: "call_r", stepIdx: 2 },
			{ at: "2026-11-23T00:58:50.100Z", event: "PreInvocation", invocationNum: 1 },
			{ at: "2026-11-23T00:58:56.400Z", event: "PreToolUse", tool: "mcp__hojaprobe_hojaprobe__probe_echo", toolUseId: "call_m", stepIdx: 4 },
			{ at: "2026-11-23T00:58:56.950Z", event: "PostToolUse", tool: "mcp__hojaprobe_hojaprobe__probe_echo", toolUseId: "call_m", stepIdx: 4 },
			{ at: "2026-11-23T00:58:57.000Z", event: "PreInvocation", invocationNum: 2 },
			{ at: "2026-11-23T00:59:01.000Z", event: "PreToolUse", tool: "Bash", toolUseId: "call_b", stepIdx: 7 },
			{ at: "2026-11-23T00:59:01.750Z", event: "PostToolUse", tool: "Bash", toolUseId: "call_b", stepIdx: 7 },
			{ at: "2026-11-23T00:59:02.000Z", event: "PreInvocation", invocationNum: 3 },
			{ at: "2026-11-23T00:59:08.000Z", event: "PreToolUse", tool: "Write", toolUseId: "call_w", stepIdx: 9 },
			{ at: "2026-11-23T00:59:08.300Z", event: "PostToolUse", tool: "Write", toolUseId: "call_w", stepIdx: 9 },
			{ at: "2026-11-23T00:59:09.000Z", event: "PreInvocation", invocationNum: 4 },
			{ at: "2026-11-23T00:59:10.200Z", event: "Stop" },
		];
		const trace = buildTrace({ sessionId: "f933fde3", transcript: fixture("agy-transcript.jsonl"), hooks, plugin: "p", redactor: new Redactor({}) });
		expect(trace.source.host).toBe("antigravity");
		expect(trace.session).toMatchObject({ basis: "transcript", models: ["gemini-4-neon-high"] });
		const llm = trace.spans.filter(s => s.kind === "llm");
		expect(llm).toHaveLength(5);
		expect(llm[0]).toMatchObject({ start: "2026-11-23T00:58:44.100Z", end: "2026-11-23T00:58:49.900Z", durationMs: 5800 });
		expect(llm[0].attrs!.usage).toEqual({ input_tokens: 9029, output_tokens: 334, cache_read_tokens: 0, cache_creation_tokens: 0 });
		const tools = trace.spans.filter(s => s.kind === "tool");
		expect(tools.map(t => t.name)).toEqual([
			"Read · /root/.gemini/antigravity-cli/mcp/hojaprobe_hojaprobe/probe_echo.json",
			"hojaprobe_hojaprobe/probe_echo · text=\"hi\"",
			"Bash · ls",
			"Write · /work/demo/notes.txt",
		]);
		expect(tools[2]).toMatchObject({ id: "tool:call_b", status: "ok", durationMs: 750, attrs: { exitCode: 0, step: 7 } });
		expect(trace.totals).toMatchObject({ turns: 1, llmCalls: 5, toolCalls: 4, toolErrors: 0, blocked: 0, filesTouched: ["/work/demo/notes.txt"] });
		expect(traceSubtitle(trace)).toMatch(/^Antigravity trace · /);
	});
	it("a hook-denied call is blocked in the trace", () => {
		const trace = buildTrace({ sessionId: "de31bc6e", transcript: fixture("agy-blocked.jsonl"), hooks: [], plugin: "p", redactor: new Redactor({}) });
		const span = trace.spans.find(s => s.kind === "tool")!;
		expect(span).toMatchObject({ status: "blocked", name: "Bash · touch notes2.txt && echo made" });
		expect(trace.totals.blocked).toBe(1);
	});
});
