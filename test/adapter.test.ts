import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseTranscript } from "../src/transcript.ts";

const OWN_TOOL_PREFIX = "mcp__plugin_hoja_hoja__";
import { createRuntime } from "../src/runtime.ts";
import { readJournal } from "../src/pi-shim.ts";
import { responseText } from "../src/hook-bridge.ts";
import { TASK_COMPLETION_CONTRACT } from "../src/generated/contract.ts";
import { sessionContext } from "../src/session-start.ts";
import { TASK_GATE_CONTINUE_SENTINEL } from "../vendor/trebol/.pi/lib/runtime/task-gate-resume.ts";

const root = resolve(__dirname, "..");
const line = (o: unknown) => JSON.stringify(o) + "\n";
const assistant = (id: string, content: unknown[], stop_reason: string | null) => line({ type: "assistant", message: { id, role: "assistant", content, stop_reason } });
const toolResult = (tool_use_id: string, text: string, is_error = false) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: [{ type: "text", text }], is_error }] } });

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hoja-plugin-"));
	const transcript = join(dir, "t.jsonl");
	writeFileSync(transcript, line({ type: "user", message: { role: "user", content: "go" } }));
	const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block" });
	const base = { session_id: "s-1", transcript_path: transcript, cwd: dir, agent_id: "" };
	const hook = (event: string, extra: Record<string, unknown> = {}) => rt.bridge.handle(event, { ...base, event, ...extra });
	const pre = (tool_name: string, tool_input: unknown, tool_use_id = "x") => hook("PreToolUse", { tool_name, tool_input: JSON.stringify(tool_input), tool_use_id });
	const call = async (name: string, args: unknown, id: string) => {
		await pre(OWN_TOOL_PREFIX + name, args, id);
		const tool = rt.shim.tools.get(name)!;
		const result = await tool.execute(rt.bridge.takeToolCallId(name) ?? id, args, undefined, undefined, rt.shim.ctx());
		return JSON.parse(result.content[0].text);
	};
	return { dir, transcript, rt, hook, pre, call };
}

describe("transcript → Pi messages", () => {
	it("merges per-block assistant lines, maps stop reasons, names tool results canonically", () => {
		const text = line({ type: "user", message: { role: "user", content: "hi" } })
			+ assistant("m1", [{ type: "text", text: "a" }], null)
			+ assistant("m1", [{ type: "tool_use", id: "t1", name: OWN_TOOL_PREFIX + "TaskManage", input: {} }], "tool_use")
			+ toolResult("t1", "ok")
			+ assistant("m2", [{ type: "text", text: "done" }], "end_turn");
		const messages = parseTranscript(text);
		expect(messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[1]).toMatchObject({ stopReason: "toolUse", content: [{ type: "text" }, { type: "toolCall", id: "t1", name: "TaskManage" }] });
		expect(messages[2]).toMatchObject({ toolName: "TaskManage", toolCallId: "t1", isError: false });
		expect(messages[3]).toMatchObject({ stopReason: "stop" });
	});
	it("extracts tool_response text from strings, MCP content, and Bash objects", () => {
		expect(responseText("plain")).toBe("plain");
		expect(responseText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(responseText({ stdout: "out", stderr: "err", interrupted: false })).toBe("out\nerr");
		expect(responseText(JSON.stringify({ stdout: "x" }))).toBe("x");
	});
});

describe("hook bridge decisions (vendored Swarm pipeline)", () => {
	let f: ReturnType<typeof fixture>;
	beforeEach(() => { f = fixture(); });

	it("blocks mutating tools without a focused task with Trebol's exact block text, allows read-only and schema loading", async () => {
		const denied: any = await f.pre("Bash", { command: "touch /tmp/x" });
		expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("[TASK ENFORCEMENT - BLOCKED] YOU CANNOT EXECUTE ANY TOOL WITHOUT A TASK");
		expect(await f.pre("Bash", { command: "ls -la" })).toEqual({});
		expect(await f.pre("Read", { file_path: "/etc/hostname" })).toEqual({});
		expect(await f.pre("ToolSearch", { query: "select:TaskManage" })).toEqual({});
		expect(await f.pre(OWN_TOOL_PREFIX + "TaskManage", { operations: [] })).toEqual({});
	});

	it("unblocks once TaskManage focuses a task; still blocks bare sleep", async () => {
		const created = await f.call("TaskManage", { operations: [{ key: "a", op: "create", subject: "S", status: "in_progress", active: true, questions: [{ id: "q", text: "?" }] }] }, "c1");
		expect(created.status).toBe("succeeded");
		expect(await f.pre("Bash", { command: "touch /tmp/x" })).toEqual({});
		const sleep: any = await f.pre("Bash", { command: "sleep 30" });
		expect(sleep.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("Stop after a task-gate block continues the turn once per budget (Pi agent_before_settle)", async () => {
		const denied: any = await f.pre("Bash", { command: "touch /tmp/x" }, "b1");
		appendFileSync(f.transcript, assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "touch /tmp/x" } }], "tool_use")
			+ toolResult("b1", denied.hookSpecificOutput.permissionDecisionReason, true)
			+ assistant("m2", [{ type: "text", text: "I was blocked, stopping." }], "end_turn"));
		const first: any = await f.hook("Stop", { stop_hook_active: false });
		expect(first.hookSpecificOutput?.hookEventName).toBe("Stop");
		expect(first.hookSpecificOutput.additionalContext).toContain(TASK_GATE_CONTINUE_SENTINEL);
		await f.hook("UserPromptSubmit", { prompt: "again" }); // a real user turn refills the budget
		const again: any = await f.hook("Stop", { stop_hook_active: false });
		expect(again.hookSpecificOutput?.additionalContext).toContain(TASK_GATE_CONTINUE_SENTINEL);
	});

	it("validates tool evidence against the Claude transcript under both Claude and Trebol tool names", async () => {
		await f.call("TaskManage", { operations: [{ key: "a", op: "create", subject: "S", status: "in_progress", active: true, questions: [{ id: "q", text: "?" }] }] }, "c1");
		const complete = (evidence: string) => f.call("TaskManage", { operations: [{ key: "c", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "yes", evidence }] }] }, "c2");
		expect((await complete("tool:Bash")).status).toBe("failed");
		appendFileSync(f.transcript, assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: {} }], "tool_use") + toolResult("b1", "ok")
			+ assistant("m2", [{ type: "tool_use", id: "c1", name: OWN_TOOL_PREFIX + "TaskManage", input: {} }], "tool_use") + toolResult("c1", "ok"));
		expect((await complete(`tool:${OWN_TOOL_PREFIX}TaskManage#1`)).status).toBe("succeeded");
	});

	it("journals task state per session and restores it in a fresh process", async () => {
		await f.call("TaskManage", { operations: [{ key: "a", op: "create", subject: "Persist me", questions: [{ id: "q", text: "?" }] }] }, "c1");
		expect(readJournal(join(f.dir, "data"), "s-1").length).toBeGreaterThan(0);
		const again = createRuntime({ dataDir: join(f.dir, "data"), cwd: f.dir, hoja: false });
		await again.shim.bindSession("s-1", f.transcript, f.dir);
		expect(again.manager.snapshot().tasks.map(t => t.subject)).toEqual(["Persist me"]);
	});

	it("answers /hoja:tasks locally without a model turn", async () => {
		const out: any = await f.hook("UserPromptExpansion", { command_name: "hoja:tasks", command_args: "" });
		expect(out.decision).toBe("block");
		expect(out.reason).toContain("All tasks:");
	});
});

describe("prompt and packaging parity", () => {
	it("carries Pi's <task_completion_contract> byte-for-byte", () => {
		const source = readFileSync(join(root, "vendor/trebol/extensions/taskmanage/extension.ts"), "utf8");
		expect(TASK_COMPLETION_CONTRACT.startsWith("<task_completion_contract>")).toBe(true);
		expect(source).toContain(JSON.stringify(TASK_COMPLETION_CONTRACT).slice(1, -1));
	});
	it("SessionStart context = TaskManage snippet + guidelines + contract", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-ss-"));
		const text = await sessionContext({ session_id: "ss", cwd: dir }, { CLAUDE_PLUGIN_DATA: dir, HOJA_PLUGIN_DISABLE_HOJA: "1" } as any);
		expect(text).toContain("TaskManage");
		expect(text).toContain(TASK_COMPLETION_CONTRACT);
	});
	it("hooks.json only forwards to the plugin's own bridge tool", () => {
		// One test for both packagings: the Claude Code plugin (.claude-plugin) and the Codex plugin (.codex-plugin).
		const codex = existsSync(join(root, ".codex-plugin/plugin.json"));
		const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")).hooks;
		for (const [event, groups] of Object.entries<any[]>(hooks)) for (const g of groups) for (const h of g.hooks) {
			if (h.type === "mcp_tool") { expect(h.server).toBe(codex ? "hoja" : "plugin:hoja:hoja"); expect(h.tool).toBe("__hoja_hook"); expect(h.input.event).toBe(event); }
			else if (codex) expect(h.command).toBe('HOJA_PLUGIN_HOST=codex node "$PLUGIN_ROOT/dist/session-start.mjs"');
			else expect(h.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/dist/session-start.mjs");
		}
		if (codex) {
			const servers = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
			expect(Object.keys(servers).sort()).toEqual(["hoja", "hoja_api"]);
			for (const server of Object.values<any>(servers)) expect(server.env.HOJA_PLUGIN_HOST).toBe("codex");
			// Codex never passes hook placeholders it lacks; agent_id is not a Codex tool/prompt field.
			expect(JSON.stringify(hooks)).not.toContain("${agent_id}");
		}
	});
	it("bundled MCP server speaks JSON-RPC and loads its tools upfront", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-srv-"));
		const child = spawn("node", [join(root, "dist/server.mjs")], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLAUDE_PLUGIN_DATA: dir, HOJA_PLUGIN_DISABLE_HOJA: "1" } });
		const replies: any[] = [];
		let buffer = "";
		const got = new Promise<void>(done => child.stdout.on("data", chunk => {
			buffer += chunk;
			const lines = buffer.split("\n"); buffer = lines.pop()!;
			for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
			if (replies.length >= 2) done();
		}));
		child.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }));
		child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
		await got; child.stdin.end();
		expect(replies[0].result.serverInfo.name).toBe("hoja");
		const tools = replies[1].result.tools;
		expect(tools.map((t: any) => t.name)).toContain("TaskManage");
		expect(tools.every((t: any) => t._meta["anthropic/alwaysLoad"] === true)).toBe(true);
	}, 20000);
});
