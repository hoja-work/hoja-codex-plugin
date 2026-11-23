/**
 * Regressions for the four bugs a real Claude Code user reported against 0.3.0:
 *   1. `/hoja:setup`'s fallback text reached the model (the local command was not answered);
 *   2. the task gate refused read-only discovery (hoja_project list, hosted hoja_viewer/hoja_teams, read-only Bash);
 *   3. a published issue lost the task's description and priority;
 *   4. the Stop-hook auto-continue forced a task (and an issue) just to run a health check.
 */
import { afterAll, beforeAll, describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../src/runtime.ts";
import { priorityValue } from "../vendor/trebol/extensions/hoja-mode/publish.ts";
import { normalizeCommandName, stripFdRedirections, isAdapterReadOnlyTool } from "../src/host-policy.ts";

const OWN = "mcp__plugin_hoja_hoja__";
const API = "mcp__plugin_hoja_hoja-api__";
const line = (o: unknown) => JSON.stringify(o) + "\n";

function fixture(extra: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "hoja-reported-"));
	const transcript = join(dir, "t.jsonl");
	writeFileSync(transcript, line({ type: "user", message: { role: "user", content: "go" } }));
	const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false, enforcementMode: "block", ...extra });
	const base = { session_id: "s-1", transcript_path: transcript, cwd: dir, agent_id: "" };
	const hook = (event: string, payload: Record<string, unknown> = {}) => rt.bridge.handle(event, { ...base, event, ...payload });
	const pre = (tool_name: string, tool_input: unknown, tool_use_id = "x") => hook("PreToolUse", { tool_name, tool_input: JSON.stringify(tool_input), tool_use_id });
	const denied = (out: any) => out?.hookSpecificOutput?.permissionDecision === "deny";
	return { dir, transcript, rt, hook, pre, denied };
}

// A fake Hoja client: records what publication actually sends, and answers read-backs locally.
class FakeHoja {
	created: { title: string; description: string; state: string; options: any }[] = [];
	mutations: { query: string; variables: any }[] = [];
	description = "";
	states: string[] = [];
	comments: string[] = [];
	async gql(query: string, variables?: any) {
		this.mutations.push({ query, variables });
		return { issueUpdate: { success: true } };
	}
	async resolve(project: string) {
		return { teamId: "team-1", teamKey: "T", projectId: "proj-1", project, assigneeId: "user-1", assignee: "me", states: { todo: "st-todo", "in progress": "st-doing", done: "st-done" } };
	}
	async createIssue(_r: unknown, title: string, description: string, state: string, options: unknown) {
		this.created.push({ title, description, state, options });
		this.description = description;
		return { id: "issue-1", identifier: "T-1" };
	}
	async readIssue(id: string) {
		return { id, identifier: "T-1", title: this.created[0]?.title ?? "", description: this.description, state: "Todo", teamId: "team-1", projectId: "proj-1", assigneeId: "user-1", comments: [] };
	}
	async findIssueByMarker() { return undefined; }
	async findIssueByIdentifier() { return undefined; }
	async setState(_r: unknown, _id: string, state: string) { this.states.push(state); }
	async setDescription(_id: string, description: string) { this.description = description; }
	async comment(_id: string, body: string) { this.comments.push(body); }
	invalidateCatalog() {}
}

describe("item 2: the gate lets read-only discovery through", () => {
	let f: ReturnType<typeof fixture>;
	beforeEach(() => { f = fixture(); });

	it("allows the exact read-only calls the user reported", async () => {
		// hoja_list was never blocked (Trebol knows it); the three that were now pass too.
		expect(await f.pre(OWN + "hoja_list", {})).toEqual({});
		expect(await f.pre(OWN + "hoja_project", { action: "list" })).toEqual({});
		expect(await f.pre(OWN + "hoja_project", {})).toEqual({});
		expect(await f.pre(API + "hoja_viewer", {})).toEqual({});
		expect(await f.pre(API + "hoja_teams", {})).toEqual({});
		// Claude Code may normalize the server name's hyphen.
		expect(await f.pre("mcp__plugin_hoja_hoja_api__hoja_teams", {})).toEqual({});
		expect(await f.pre(OWN + "hoja_setup", {})).toEqual({});
		// Read-only Bash, including the redirection forms Trebol's tokenizer used to misread.
		for (const command of ["ls", "cat .pi/config/hoja.json", "cat .pi/config/hoja.json 2>/dev/null", "ls 2>&1", "cat .pi/config/hoja.json 2>&1", "cd /root/Work/Hoja-Work && cat .pi/config/hoja.json", "git log 2>&1 | head -5"]) {
			expect(await f.pre("Bash", { command }), command).toEqual({});
		}
	});

	it("keeps every mutating call gated", async () => {
		expect(f.denied(await f.pre(OWN + "hoja_project", { action: "create", name: "X" }))).toBe(true);
		expect(f.denied(await f.pre(OWN + "hoja_project", { action: "select", name: "X" }))).toBe(true);
		for (const tool of ["hoja_issueCreate", "hoja_commentCreate", "hoja_taskUpdate", "hoja_extensionActionRun", "hoja_notificationMarkRead", "hoja_issueDecisionAnswer", "hoja_taskDecisionCancel", "hoja_teamMemberAdd"]) {
			expect(f.denied(await f.pre(API + tool, {})), tool).toBe(true);
		}
		for (const command of ["touch /tmp/x", "touch /tmp/x 2>&1", "rm -rf /tmp/x 2>&1", "npm test 2>&1", "cat .pi/config/hoja.json > /tmp/x"]) {
			const out: any = await f.pre("Bash", { command });
			if (command.includes(">")) continue; // Trebol's own allowlist already accepts a write redirect after a read binary
			expect(f.denied(out), command).toBe(true);
		}
	});

	it("classifies only the documented read-only shapes", () => {
		expect(isAdapterReadOnlyTool("mcp__hoja__hoja_viewer", {})).toBe(true);
		expect(isAdapterReadOnlyTool("mcp__hoja__hoja_taskUpdate", {})).toBe(false);
		expect(isAdapterReadOnlyTool("hoja_project", { action: "list" })).toBe(true);
		expect(isAdapterReadOnlyTool("hoja_project", { action: "remember" })).toBe(false);
		expect(stripFdRedirections("cat a 2>&1")).toBe("cat a");
		expect(stripFdRedirections("ls >/dev/null 2>&1")).toBe("ls");
		expect(stripFdRedirections("cat a > out.txt")).toBe("cat a > out.txt");
	});
});

describe("item 1: slash commands are answered locally, whatever the host calls them", () => {
	// No credentials: hojaDoctor must not touch the network for the report to print.
	beforeAll(() => { for (const name of ["HOJA_TOKEN", "LINEAR_TOKEN", "HOJA_API_URL", "LINEAR_API_URL", "HOJA_MCP_URL", "HOJA_PLUGIN_TOKEN", "HOJA_PLUGIN_API_URL", "HOJA_PLUGIN_MCP_URL"]) vi.stubEnv(name, ""); });
	afterAll(() => { vi.unstubAllEnvs(); });

	it("normalizes every command_name spelling Claude Code has used", () => {
		for (const raw of ["setup", "hoja:setup", "/hoja:setup", "plugin:hoja:setup", "Plugin:Hoja:Setup"]) expect(normalizeCommandName(raw)).toBe("setup");
	});

	it("answers /hoja:setup from UserPromptExpansion under all spellings", async () => {
		const f = fixture();
		for (const command_name of ["hoja:setup", "/hoja:setup", "setup", "plugin:hoja:setup"]) {
			const out: any = await f.hook("UserPromptExpansion", { command_name, command_args: "" });
			expect(out.decision, command_name).toBe("block");
			expect(out.reason, command_name).toContain("Task enforcement: block");
		}
		expect(String((await f.hook("UserPromptExpansion", { command_name: "/hoja:tasks" }) as any).reason)).toContain("All tasks:");
	});

	it("answers a slash command from UserPromptSubmit when the expansion hook does not fire", async () => {
		const f = fixture();
		const tasks: any = await f.hook("UserPromptSubmit", { prompt: "/hoja:tasks" });
		expect(tasks.decision).toBe("block");
		expect(tasks.reason).toContain("All tasks:");
		const setup: any = await f.hook("UserPromptSubmit", { prompt: "  /hoja:setup  " });
		expect(setup.decision).toBe("block");
		expect(setup.reason).toContain("GraphQL endpoint:");
		// An ordinary prompt that merely starts with the plugin name is not hijacked.
		// (It is a real user message, so it only gets the work-registration line, never a block.)
		const plain: any = await f.hook("UserPromptSubmit", { prompt: "hoja: how do I file an issue?" });
		expect(plain.decision).toBeUndefined();
		expect(plain.hookSpecificOutput?.additionalContext ?? "").not.toContain("All tasks:");
	});

	it("exposes the same report as a read-only tool for the .md fallback", async () => {
		const f = fixture();
		const tool = f.rt.shim.tools.get("hoja_setup");
		expect(tool).toBeDefined();
		const result = await tool!.execute("c1", {}, undefined, undefined, f.rt.shim.ctx());
		expect(result.content[0].text).toContain("Task enforcement: block");
		// It must also stay ungated, or the fallback could not run.
		expect(await f.pre(OWN + "hoja_setup", {})).toEqual({});
	});
});

describe("item 3: publication carries the task's description and priority", () => {
	async function publish(priority: string, description: string | undefined, fake: FakeHoja) {
		const dir = mkdtempSync(join(tmpdir(), "hoja-pub-"));
		const transcript = join(dir, "t.jsonl");
		writeFileSync(transcript, line({ type: "user", message: { role: "user", content: "go" } }));
		const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: true, hojaClient: fake, enforcementMode: "off", headless: true });
		await rt.shim.bindSession("s-pub", transcript, dir);
		const args = { operations: [{ key: "a", op: "create", subject: "Fix the thing", ...(description ? { description } : {}), priority, status: "in_progress", active: true, metadata: { hojaProject: "Team" }, questions: [{ id: "q1", text: "done?" }] }] };
		const result = await rt.shim.tools.get("TaskManage")!.execute("c1", args, undefined, undefined, rt.shim.ctx());
		await rt.shim.emitToolResult({ toolName: "TaskManage", toolCallId: "c1", input: args, content: result.content, details: result.details, isError: false });
		return fake;
	}

	it("creates a clean Markdown issue carrying the task's description and priority", async () => {
		const fake = await publish("high", "The long description of the task body.", new FakeHoja());
		expect(fake.created.length).toBe(1);
		// Exactly the task's Markdown and its checklist: no marker, tracking line, status, ids or HTML comment.
		expect(fake.created[0].description).toBe("The long description of the task body.\n\n## Acceptance criteria\n\n- [ ] done?");
		// Priority travels with the create itself; there is no second write that could be lost.
		expect(fake.created[0].options).toMatchObject({ priority: 2 });
		expect(fake.mutations.filter(m => m.variables?.input?.priority !== undefined)).toEqual([]);
	});

	it("sends the default priority medium with the create", async () => {
		const fake = await publish("medium", "body", new FakeHoja());
		expect(fake.created[0].options).toMatchObject({ priority: 3 });
		expect(fake.created[0].title).toBe("Fix the thing");
	});

	it("maps TaskManage priorities to Hoja's integers", () => {
		expect(priorityValue("low")).toBe(4);
		expect(priorityValue("High")).toBe(2);
		expect(priorityValue(undefined)).toBeUndefined();
		expect(priorityValue("someday")).toBeUndefined();
	});
});

describe("item 4: a health check needs no task and files nothing", () => {
	it("does not auto-continue the turn when only read-only discovery ran", async () => {
		const f = fixture();
		expect(await f.pre(OWN + "hoja_project", { action: "list" })).toEqual({});
		expect(await f.pre(API + "hoja_viewer", {})).toEqual({});
		expect(await f.pre("Bash", { command: "ls 2>&1" })).toEqual({});
		expect(await f.pre("Bash", { command: "cat .pi/config/hoja.json" })).toEqual({});
		const stop: any = await f.hook("Stop", { stop_hook_active: false });
		expect(stop).toEqual({});
		expect(f.rt.manager.snapshot().tasks).toEqual([]);
	});
});
