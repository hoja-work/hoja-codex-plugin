/**
 * HOJA-757: agents register every request and reconcile it before the turn ends, without being reminded.
 * Bridge-level checks of the vendored work-registration policy plus the adapter fixes found in real traces.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.ts";

const OWN = "mcp__plugin_hoja_hoja__";
const line = (o: unknown) => JSON.stringify(o) + "\n";

function fixture(options: Record<string, unknown> = {}, host?: string) {
	const dir = mkdtempSync(join(tmpdir(), "hoja-reg-"));
	const transcript = join(dir, "t.jsonl");
	writeFileSync(transcript, line({ type: "user", message: { role: "user", content: "go" } }));
	const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "advise", ...(host ? { host } : {}), ...options } as any);
	let cwd = dir;
	const hook = (event: string, payload: Record<string, unknown> = {}) => rt.bridge.handle(event, { session_id: "s-reg", transcript_path: transcript, cwd, agent_id: "", event, ...payload });
	const post = (tool_name: string, tool_input: unknown, tool_response: unknown = "ok", id = Math.random().toString(36).slice(2)) =>
		hook("PostToolUse", { tool_name, tool_input: JSON.stringify(tool_input), tool_response: typeof tool_response === "string" ? tool_response : JSON.stringify(tool_response), tool_use_id: id });
	const tm = async (operations: unknown[]) => {
		const tool = rt.shim.tools.get("TaskManage")!;
		const result = await tool.execute("tm", { operations }, undefined, undefined, rt.shim.ctx());
		await post(OWN + "TaskManage", { operations }, result.content);
		return JSON.parse(result.content[0].text);
	};
	const ctx = (out: any) => String(out?.hookSpecificOutput?.additionalContext ?? out?.reason ?? "");
	return { dir, rt, hook, post, tm, ctx, setCwd: (next: string) => { cwd = next; } };
}

describe("work registration through the Claude Code bridge (HOJA-757)", () => {
	it("adds the registration line to a user-authored prompt and not to a background notification", async () => {
		const f = fixture();
		await f.hook("SessionStart");
		expect(f.ctx(await f.hook("UserPromptSubmit", { prompt: "help me clean the disk" }))).toContain("[Work registration]");
		expect(f.ctx(await f.hook("UserPromptSubmit", { prompt: "<task-notification><status>completed</status></task-notification>" }))).not.toContain("[Work registration]");
	});

	it("still asks for a task on a new request after every earlier task completed", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "fix the bug" });
		await f.tm([{ key: "a", op: "create", subject: "Fix the bug", status: "in_progress", active: true, questions: [{ id: "q", text: "Done?" }] }]);
		writeFileSync(join(f.dir, "fix.md"), "fixed\n");
		const done = await f.tm([{ key: "b", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "yes", evidence: "fix.md#L1" }] }]);
		expect(done.status).toBe("succeeded");
		expect(f.ctx(await f.hook("UserPromptSubmit", { prompt: "now merge and deploy" }))).toContain("create a TaskManage task");
	});

	it("names the active task when a new request arrives mid-task", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "fix the bug" });
		await f.tm([{ key: "a", op: "create", subject: "Fix the bug", status: "in_progress", active: true, questions: [{ id: "q", text: "Done?" }] }]);
		const text = f.ctx(await f.hook("UserPromptSubmit", { prompt: "also update both READMEs" }));
		expect(text).toContain("task #1");
		expect(text).toContain("Do not fold a new request into #1");
	});

	it("does not replay a stale pre-tool nudge at the next prompt", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "edit the file" });
		const pre = await f.hook("PreToolUse", { tool_name: "Edit", tool_input: JSON.stringify({ file_path: "a" }), tool_use_id: "e1" });
		expect(f.ctx(pre)).toContain("No active task is focused");
		await f.tm([{ key: "a", op: "create", subject: "Edit", status: "in_progress", active: true, questions: [{ id: "q", text: "Done?" }] }]);
		const next = f.ctx(await f.hook("UserPromptSubmit", { prompt: "<task-notification>done</task-notification>" }));
		expect(next).not.toContain("No active task is focused");
	});

	it("continues the turn once to reconcile a focused task after acting work (Claude Code shape)", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "fix it" });
		await f.tm([{ key: "a", op: "create", subject: "Fix it", status: "in_progress", active: true, questions: [{ id: "q", text: "Done?" }] }]);
		await f.post("Edit", { file_path: "a.py" });
		await f.post("Bash", { command: "python3 -m unittest -q" });
		const stop: any = await f.hook("Stop", { last_assistant_message: "Fixed." });
		expect(stop.hookSpecificOutput?.hookEventName).toBe("Stop");
		expect(f.ctx(stop)).toContain("reconcile task #1");
		// Once per turn: the continuation's own Stop ends the turn.
		expect(await f.hook("Stop", { last_assistant_message: "Done." })).toEqual({});
	});

	it("asks to register acting work done with no task, in the Codex Stop shape", async () => {
		const prev = process.env.HOJA_PLUGIN_HOST;
		process.env.HOJA_PLUGIN_HOST = "codex";
		try {
			const f = fixture();
			await f.hook("UserPromptSubmit", { prompt: "commit everything" });
			await f.post("Bash", { command: "git add -A" });
			await f.post("Bash", { command: "git commit -m x" });
			const stop: any = await f.hook("Stop", { last_assistant_message: "Committed." });
			expect(stop.decision).toBe("block");
			expect(stop.reason).toContain("without a task");
		} finally {
			if (prev === undefined) delete process.env.HOJA_PLUGIN_HOST; else process.env.HOJA_PLUGIN_HOST = prev;
		}
	});

	it("does not count a subagent's tool calls against the parent's turn", async () => {
		const f = fixture();
		await f.hook("UserPromptSubmit", { prompt: "investigate" });
		await f.hook("PostToolUse", { tool_name: "Edit", tool_input: JSON.stringify({ file_path: "a" }), tool_response: "ok", tool_use_id: "s1", agent_id: "sub-1" });
		await f.hook("PostToolUse", { tool_name: "Edit", tool_input: JSON.stringify({ file_path: "b" }), tool_response: "ok", tool_use_id: "s2", agent_id: "sub-1" });
		expect(await f.hook("Stop", { last_assistant_message: "Done." })).toEqual({});
	});

	it("keeps the session's starting directory citable after the agent cds elsewhere", async () => {
		const f = fixture();
		writeFileSync(join(f.dir, "notes.md"), "# Notes\n\nline\n");
		await f.hook("SessionStart");
		await f.hook("UserPromptSubmit", { prompt: "write notes" });
		await f.tm([{ key: "a", op: "create", subject: "Notes", status: "in_progress", active: true, questions: [{ id: "q", text: "Where?" }] }]);
		const elsewhere = join(f.dir, "sub");
		mkdirSync(elsewhere);
		f.setCwd(elsewhere);
		await f.hook("PostToolUse", { tool_name: "Bash", tool_input: JSON.stringify({ command: "cd sub" }), tool_response: "", tool_use_id: "cd1" });
		const done = await f.tm([{ key: "b", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "notes.md", evidence: "notes.md#L1" }] }]);
		expect(done.status).toBe("succeeded");
	});
});
