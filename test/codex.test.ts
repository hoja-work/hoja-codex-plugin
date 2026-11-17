import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalToolName, parseTranscript } from "../src/transcript.ts";
import { createRuntime } from "../src/runtime.ts";
import { TASK_GATE_CONTINUE_SENTINEL } from "../vendor/trebol/.pi/lib/runtime/task-gate-resume.ts";

// The Codex plugin runs the same adapter with HOJA_PLUGIN_HOST=codex (see the hoja-codex-plugin repo's .mcp.json).
const previous = process.env.HOJA_PLUGIN_HOST;
beforeAll(() => { process.env.HOJA_PLUGIN_HOST = "codex"; });
afterAll(() => { if (previous === undefined) delete process.env.HOJA_PLUGIN_HOST; else process.env.HOJA_PLUGIN_HOST = previous; });

const line = (o: unknown) => JSON.stringify(o) + "\n";
const item = (payload: unknown) => line({ timestamp: "t", type: "response_item", payload });
const user = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const say = (text: string) => item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (call_id: string, name: string, namespace?: string) => item({ type: "function_call", name, ...(namespace ? { namespace } : {}), arguments: "{}", call_id });
const output = (call_id: string, text: string) => item({ type: "function_call_output", call_id, output: text });
const META = line({ timestamp: "t", type: "session_meta", payload: { id: "s-1", cwd: "/w" } });

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hoja-codex-"));
	const transcript = join(dir, "rollout.jsonl");
	writeFileSync(transcript, META + user("<environment_context>\n  <cwd>/w</cwd>\n</environment_context>") + user("go"));
	const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block" });
	const base = { session_id: "s-1", transcript_path: transcript, cwd: dir };
	const hook = (event: string, extra: Record<string, unknown> = {}) => rt.bridge.handle(event, { ...base, event, ...extra });
	const pre = (tool_name: string, tool_input: unknown, tool_use_id = "x") => hook("PreToolUse", { tool_name, tool_input, tool_use_id });
	const run = async (name: string, args: unknown, id: string) => {
		await pre("mcp__hoja__" + name, args, id);
		const tool = rt.shim.tools.get(name)!;
		const result = await tool.execute(rt.bridge.takeToolCallId(name) ?? id, args, undefined, undefined, rt.shim.ctx());
		await hook("PostToolUse", { tool_name: "mcp__hoja__" + name, tool_input: args, tool_use_id: id, tool_response: result });
		return JSON.parse(result.content[0].text);
	};
	return { dir, transcript, rt, hook, pre, run };
}

describe("Codex names and rollout transcripts", () => {
	it("canonicalizes Codex tool names to Trebol's", () => {
		expect(canonicalToolName("mcp__hoja__TaskManage")).toBe("TaskManage");
		expect(canonicalToolName("mcp__hoja_api__hoja_viewer")).toBe("mcp__hoja__hoja_viewer");
		expect(canonicalToolName("exec_command")).toBe("Bash");
		expect(canonicalToolName("apply_patch")).toBe("apply_patch");
	});
	it("rebuilds Pi messages from a rollout: one assistant turn per model turn, injected context skipped", () => {
		const messages = parseTranscript(META + user("<environment_context>x</environment_context>") + user("hi")
			+ say("listing") + call("c1", "TaskManage", "mcp__hoja") + call("c2", "exec_command") + output("c1", "ok") + output("c2", "done")
			+ say("finished"));
		expect(messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(messages[1]).toMatchObject({ stopReason: "toolUse", content: [{ type: "text", text: "listing" }, { type: "toolCall", id: "c1", name: "TaskManage" }, { type: "toolCall", id: "c2", name: "Bash" }] });
		expect(messages[2]).toMatchObject({ toolName: "TaskManage" });
		expect(messages[3]).toMatchObject({ toolName: "Bash" });
		expect(messages[4]).toMatchObject({ stopReason: "stop" });
	});
});

describe("Codex hook bridge", () => {
	let f: ReturnType<typeof fixture>;
	beforeEach(() => { f = fixture(); });

	it("denies with Codex's PreToolUse shape and lets own tools through", async () => {
		const denied: any = await f.pre("Bash", { command: "touch /tmp/x" });
		expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
		expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("[TASK ENFORCEMENT - BLOCKED]");
		expect(await f.pre("mcp__hoja__TaskManage", { operations: [] })).toEqual({});
	});

	it("validates evidence against the Codex rollout under Codex and Trebol names", async () => {
		await f.run("TaskManage", { operations: [{ key: "a", op: "create", subject: "S", status: "in_progress", active: true, questions: [{ id: "q", text: "?" }] }] }, "c1");
		const complete = (evidence: string) => f.run("TaskManage", { operations: [{ key: "c", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "yes", evidence }] }] }, "c2");
		expect((await complete("tool:Bash")).status).toBe("failed");
		appendFileSync(f.transcript, call("b1", "exec_command") + output("b1", "ok") + call("t1", "TaskManage", "mcp__hoja") + output("t1", "ok"));
		expect((await complete("tool:mcp__hoja__TaskManage#1")).status).toBe("succeeded");
	});

	it("Stop after a gate block continues through decision:block (Codex continuation prompt)", async () => {
		const denied: any = await f.pre("Bash", { command: "touch /tmp/x" }, "b1");
		appendFileSync(f.transcript, call("b1", "exec_command") + output("b1", `Command blocked by PreToolUse hook: ${denied.hookSpecificOutput.permissionDecisionReason}`) + say("I was blocked, stopping."));
		const first: any = await f.hook("Stop", { stop_hook_active: false, last_assistant_message: "I was blocked, stopping." });
		expect(first.decision).toBe("block");
		expect(first.reason).toContain(TASK_GATE_CONTINUE_SENTINEL);
		expect(first.hookSpecificOutput).toBeUndefined();
	});

	it("runs registered commands from UserPromptSubmit (Codex has no UserPromptExpansion)", async () => {
		for (const prompt of ["/hoja:tasks", "hoja:tasks", "  hoja:tasks  "]) {
			const out: any = await f.hook("UserPromptSubmit", { prompt });
			expect(out.decision).toBe("block");
			expect(out.reason).toContain("All tasks:");
		}
		expect(await f.hook("UserPromptSubmit", { prompt: "/hoja:nonexistent" })).not.toHaveProperty("decision");
		expect(await f.hook("UserPromptSubmit", { prompt: "hoja tasks are broken, fix them" })).not.toHaveProperty("decision");
	});

	it("flushes turn context on the PostToolUse that settles the last in-flight call (no PostToolBatch)", async () => {
		await f.run("TaskManage", { operations: [{ key: "a", op: "create", subject: "S", status: "in_progress", active: true, questions: [{ id: "q", text: "?" }] }] }, "c1");
		const flushes: string[] = [];
		const original = f.rt.bridge.pipeline.flushTurn.bind(f.rt.bridge.pipeline);
		(f.rt.bridge.pipeline as any).flushTurn = () => { flushes.push("flush"); return original(); };
		await f.pre("Bash", { command: "touch a" }, "p1");
		await f.pre("Bash", { command: "touch b" }, "p2");
		await f.hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "touch a" }, tool_use_id: "p1", tool_response: "" });
		expect(flushes).toEqual([]);
		await f.hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "touch b" }, tool_use_id: "p2", tool_response: "" });
		expect(flushes).toEqual(["flush"]);
	});
});

describe("Codex data directory", () => {
	it("the MCP server derives the PLUGIN_DATA directory Codex gives hooks from its install path", async () => {
		const { dataDir } = await import("../src/env.ts");
		const env = { HOJA_PLUGIN_HOST: "codex" } as any;
		expect(dataDir(env, "/h/.codex/plugins/cache/hoja/hoja/0.3.0/dist/server.mjs")).toBe("/h/.codex/plugins/data/hoja-hoja");
		expect(dataDir({ ...env, PLUGIN_DATA: "/h/.codex/plugins/data/hoja-hoja" }, "/x/session-start.mjs")).toBe("/h/.codex/plugins/data/hoja-hoja");
		expect(dataDir({ ...env, CODEX_HOME: "/c" }, "/src/hoja/dist/server.mjs")).toBe("/c/plugins/data/hoja-standalone");
	});
});
