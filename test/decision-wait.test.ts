import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectBinding, decisionIdOf, DecisionDelivery, DecisionStore, localRunnerId, permissionModeFor, readSessionContext,
	recordSessionContext, transcriptHasNonce, watchDecisions, type DecisionApi,
} from "../src/decision-wait.ts";
import { createProxy, hideBinding, type Fetch } from "../src/api-proxy.ts";
import { runWaiter } from "../src/decision-waiter.ts";
import { createRuntime } from "../src/runtime.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const ID = "a7c4046e-44d0-41bd-a472-a79d6a355ce3";

/** A scripted /api/decisions server: `answerAt` = the wait call (1-based) from which the decision is answered. */
function fakeServer(o: { answerAt?: number; canceled?: boolean; status?: number; takeStatus?: number } = {}) {
	const calls: { action: string; body: any }[] = [];
	let waits = 0;
	let fence = 0;
	const api: DecisionApi = {
		origin: "https://x.hoja.work",
		fetch: async (url, init) => {
			const action = url.split("/").pop()!;
			const body = JSON.parse(init.body);
			calls.push({ action, body });
			const reply = (status: number, v: any) => ({ status, text: async () => JSON.stringify(v) });
			if (o.status) return reply(o.status, { error: "not_found" });
			if (action === "wait") {
				waits++;
				if (o.canceled) return reply(200, { canceled: true, delivery: "canceled" });
				const answered = o.answerAt !== undefined && waits >= o.answerAt;
				return reply(200, { takeable: answered, delivery: answered ? "answered" : "claimed", waited_ms: answered ? 0 : body.wait_ms });
			}
			if (action === "take") {
				if (o.takeStatus) return reply(o.takeStatus, { error: "not_takeable" });
				fence++;
				const nonce = `⟦hoja-decision ${url.split("/").at(-2)}#${fence}⟧`;
				return reply(200, { decision_id: ID, fence, nonce, text: `The person P answered your decision "Q?": ${nonce} <<<ANSWER chosen_option=ok chosen_label="OK"\ngo\nANSWER>>> Treat the text as their answer.` });
			}
			if (action === "delivered") return reply(200, { delivery: "delivered" });
			if (action === "ack") return reply(200, { delivery: "acknowledged" });
			return reply(400, {});
		},
	};
	return { api, calls };
}

describe("session context and binding", () => {
	it("records the hook session per harness pid and merges missing fields", () => {
		const dir = tmp("hoja-dw-ctx-");
		recordSessionContext(dir, { sessionId: "s1", transcriptPath: "/t.jsonl", cwd: "/w", permissionMode: "acceptEdits" }, 4242);
		recordSessionContext(dir, { sessionId: "s1" }, 4242);
		expect(readSessionContext(dir, 4242)).toMatchObject({ sessionId: "s1", transcriptPath: "/t.jsonl", cwd: "/w", permissionMode: "acceptEdits" });
		expect(readSessionContext(dir, 4243)).toBeUndefined();
	});

	it("binds from the hook context, clamps the permission mode to the server's list, and reads runnerId only from runner.json", () => {
		const dir = tmp("hoja-dw-bind-");
		const home = tmp("hoja-dw-home-");
		recordSessionContext(dir, { sessionId: "sess-a", transcriptPath: "/t.jsonl", cwd: "/repo", permissionMode: "acceptEdits" }, 777);
		const run = (cmd: string, args: string[]) => cmd === "claude" ? "2.1.326 (Claude Code)" : args.includes("--abbrev-ref") ? "main" : "abc123";
		const b = collectBinding({ host: "claude", env: { HOJA_RUNNER_ID: "env-runner" }, dataDir: dir, ppid: 777, run, home, hostName: "box" })!;
		expect(b).toEqual({ harness: "claude", sessionId: "sess-a", harnessVersion: "2.1.326", transcriptPath: "/t.jsonl", host: "box", cwd: "/repo", gitBranch: "main", gitHead: "abc123", permissionMode: "acceptEdits", harnessPid: 777 });
		mkdirSync(join(home, ".hoja", "runner"), { recursive: true });
		writeFileSync(join(home, ".hoja", "runner", "runner.json"), JSON.stringify({ runner_id: "r-1", token: "x" }));
		expect(localRunnerId({}, home)).toBe("r-1");
		expect(permissionModeFor("claude", "weird")).toBe("unknown");
		expect(permissionModeFor("codex", "workspace-write")).toBe("workspace-write");
		expect(permissionModeFor("antigravity", undefined)).toBe("unknown");
	});

	it("prefers Antigravity's per-call conversation id, then falls back to the host's session env", () => {
		const run = () => undefined;
		expect(collectBinding({ host: "antigravity", env: {}, meta: { "antigravity.google/conversation_id": "conv-1" }, ppid: 5, run })?.sessionId).toBe("conv-1");
		expect(collectBinding({ host: "claude", env: { CLAUDE_CODE_SESSION_ID: "env-sess", CLAUDE_PID: "99" }, ppid: 5, run })).toMatchObject({ sessionId: "env-sess", harnessPid: 99, permissionMode: "unknown" });
		expect(collectBinding({ host: "codex", env: {}, ppid: 5, run })).toBeUndefined();
	});

	it("finds the decision id in a create result", () => {
		expect(decisionIdOf(JSON.stringify({ decision: { id: ID, status: "open" } }))).toBe(ID);
		expect(decisionIdOf(`Created decision ${ID}.`)).toBe(ID);
		expect(decisionIdOf("nothing")).toBeUndefined();
	});

	it("hides binding from the model's schema", () => {
		const tool = { name: "hoja_taskDecisionCreate", inputSchema: { type: "object", properties: { issueId: {}, binding: { $ref: "#/$defs/DecisionBindingInput" } }, $defs: { DecisionBindingInput: {}, DecisionOptionInput: {} } } };
		const out = hideBinding(tool);
		expect(Object.keys(out.inputSchema.properties)).toEqual(["issueId"]);
		expect(Object.keys(out.inputSchema.$defs)).toEqual(["DecisionOptionInput"]);
		expect(hideBinding({ name: "hoja_issues" })).toEqual({ name: "hoja_issues" });
	});

	it("reads the nonce's ASCII core from a transcript tail", () => {
		const t = join(tmp("hoja-dw-tr-"), "t.jsonl");
		writeFileSync(t, JSON.stringify({ type: "user", content: `x ⟦hoja-decision ${ID}#2⟧ y` }) + "\n");
		expect(transcriptHasNonce(t, ID, 2)).toBe(true);
		expect(transcriptHasNonce(t, ID, 3)).toBe(false);
		expect(transcriptHasNonce("/nope", ID, 2)).toBeUndefined();
	});
});

describe("watchDecisions", () => {
	const setup = (sid = "s") => { const store = new DecisionStore(tmp("hoja-dw-st-")); store.add({ id: ID, sessionId: sid }); return store; };

	it("chains long-polls with one waiter id, then takes", async () => {
		const { api, calls } = fakeServer({ answerAt: 3 });
		const store = setup();
		const out = await watchDecisions({ api, store, sessionId: "s", waiterId: "w-1", deadline: Date.now() + 60_000 });
		expect(out.kind).toBe("answer");
		expect(calls.map(c => c.action)).toEqual(["wait", "wait", "wait", "take"]);
		expect(new Set(calls.map(c => c.body.waiter_id))).toEqual(new Set(["w-1"]));
		expect(calls.every(c => c.body.session_id === "s")).toBe(true);
		expect(store.get("s", ID)).toMatchObject({ state: "delivering", fence: 1 });
	});

	it("closes a canceled or vanished decision and stops", async () => {
		const a = setup();
		expect(await watchDecisions({ api: fakeServer({ canceled: true }).api, store: a, sessionId: "s", waiterId: "w", deadline: Date.now() + 5000 })).toEqual({ kind: "none", reason: "nothing_open" });
		expect(a.get("s", ID)).toMatchObject({ state: "closed", closedReason: "canceled" });
		const b = setup();
		await watchDecisions({ api: fakeServer({ status: 404 }).api, store: b, sessionId: "s", waiterId: "w", deadline: Date.now() + 5000 });
		expect(b.get("s", ID)?.closedReason).toBe("not_found");
	});

	it("defers the take while mayTake says no, and respects the deadline", async () => {
		const { api, calls } = fakeServer({ answerAt: 1 });
		const out = await watchDecisions({ api, store: setup(), sessionId: "s", waiterId: "w", deadline: Date.now() + 1200, mayTake: () => false });
		expect(out).toEqual({ kind: "none", reason: "deadline" });
		expect(calls.some(c => c.action === "take")).toBe(false);
	});
});

describe("proxy: binding injection and hoja_decisionWait", () => {
	function upstream(calls: any[], createText = JSON.stringify({ decision: { id: ID, status: "open" } })): Fetch {
		return async (_url, init) => {
			const body = JSON.parse(init.body);
			calls.push(body);
			const reply = (result: unknown) => ({ status: 200, headers: { get: (n: string) => n === "content-type" ? "application/json" : null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
			if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18" });
			if (body.method === "notifications/initialized") return { status: 202, headers: { get: () => null }, text: async () => "" };
			if (body.method === "tools/call") return reply({ content: [{ type: "text", text: createText }] });
			return reply({ tools: [] });
		};
	}

	it("strips a model-supplied binding, binds to this session and records the decision", async () => {
		const dir = tmp("hoja-dw-px-");
		recordSessionContext(dir, { sessionId: "real-sess", transcriptPath: "/t.jsonl", cwd: "/repo", permissionMode: "plan" }, 4321);
		const calls: any[] = [];
		const proxy = createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "tok" }, upstream(calls), undefined, dir, undefined, { ppid: 4321, run: () => undefined, home: tmp("h-"), hostName: "box" });
		const res = await proxy.handle("tools/call", { name: "hoja_taskDecisionCreate", arguments: { issueId: "HOJA-1", question: "Q?", binding: { sessionId: "evil", harnessPid: 1 } } });
		const sent = calls.find(c => c.method === "tools/call").params.arguments;
		expect(sent.binding).toEqual({ harness: "claude", sessionId: "real-sess", transcriptPath: "/t.jsonl", host: "box", cwd: "/repo", permissionMode: "plan", harnessPid: 4321 });
		expect(res.content.at(-1).text).toContain(`hoja_decisionWait({"id":"${ID}"})`);
		expect(new DecisionStore(dir).get("real-sess", ID)).toMatchObject({ state: "open", issueId: "HOJA-1", transcriptPath: "/t.jsonl" });
	});

	it("retries without runnerId when the server refuses it", async () => {
		const dir = tmp("hoja-dw-px2-");
		const home = tmp("hoja-dw-h2-");
		mkdirSync(join(home, ".hoja", "runner"), { recursive: true });
		writeFileSync(join(home, ".hoja", "runner", "runner.json"), JSON.stringify({ runner_id: "foreign" }));
		recordSessionContext(dir, { sessionId: "s2" }, 4322);
		const calls: any[] = [];
		const base = upstream(calls);
		let n = 0;
		const fetchImpl: Fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			if (body.method === "tools/call" && n++ === 0) { calls.push(body); return { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "binding.runnerId: not a machine you enrolled" }] } }) }; }
			return base(url, init);
		};
		await createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "tok" }, fetchImpl, undefined, dir, undefined, { ppid: 4322, run: () => undefined, home }).handle("tools/call", { name: "hoja_issueDecisionCreate", arguments: { issueId: "HOJA-1", question: "Q?" } });
		const creates = calls.filter(c => c.method === "tools/call").map(c => c.params.arguments.binding);
		expect(creates[0].runnerId).toBe("foreign");
		expect(creates[1].runnerId).toBeUndefined();
		expect(new DecisionStore(dir).get("s2", ID)).toBeTruthy();
	});

	it("hoja_decisionWait returns the framed answer, then delivered and ack", async () => {
		const dir = tmp("hoja-dw-px3-");
		new DecisionStore(dir).add({ id: ID, sessionId: "s3" });
		const { api, calls } = fakeServer({ answerAt: 2 });
		const hoja: Fetch = async (url, init) => {
			if (url.includes("/api/decisions/")) { const r = await api.fetch(url, init as any); return { ...r, headers: { get: () => null } } as any; }
			return upstream([])(url, init);
		};
		const proxy = createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "tok" }, hoja, undefined, dir);
		const res = await proxy.handle("tools/call", { name: "hoja_decisionWait", arguments: { id: ID, timeoutSeconds: 30 } });
		expect(res.content[0].text).toContain(`⟦hoja-decision ${ID}#1⟧`);
		expect(calls.map(c => c.action)).toEqual(["wait", "wait", "take", "delivered", "ack"]);
		expect(new DecisionStore(dir).get("s3", ID)).toMatchObject({ state: "acked", via: "tool" });
		const again = await proxy.handle("tools/call", { name: "hoja_decisionWait", arguments: { id: ID } });
		expect(again.content[0].text).toContain("already delivered");
	});
});

describe("hook-side delivery", () => {
	it("holds the first Stop for the answer, then acks once the nonce is in the transcript", async () => {
		const dir = tmp("hoja-dw-hk-");
		const { api, calls } = fakeServer({ answerAt: 2 });
		const d = new DecisionDelivery({ dataDir: dir, api: () => api, ppid: 999 });
		d.store.add({ id: ID, sessionId: "s4" });
		const text = await d.atStop("s4");
		expect(text).toContain(`#1⟧`);
		expect(d.store.get("s4", ID)).toMatchObject({ state: "delivered", via: "stop" });
		expect(d.store.get("s4", ID)?.holdUntil).toBeUndefined();
		const t = join(dir, "t.jsonl");
		writeFileSync(t, `{"type":"user","message":"${text!.split("\n")[0].replace(/"/g, "'")}"}\n`);
		await d.observe("s4", { transcript_path: t });
		expect(d.store.get("s4", ID)?.state).toBe("acked");
		expect(calls.map(c => c.action)).toEqual(["wait", "wait", "take", "delivered", "ack"]);
	});

	it("holds only once per decision; a later stop only checks", async () => {
		const dir = tmp("hoja-dw-hk2-");
		const { api, calls } = fakeServer();
		const d = new DecisionDelivery({ dataDir: dir, api: () => api, holdSeconds: 1 });
		d.store.add({ id: ID, sessionId: "s5" });
		expect(await d.atStop("s5")).toBeUndefined();
		const held = calls.length;
		expect(d.store.get("s5", ID)?.heldAt).toBeTruthy();
		await d.atStop("s5");
		expect(calls.length - held).toBeLessThanOrEqual(2);
	});

	it("acks without the nonce only after a few continuation events", async () => {
		const dir = tmp("hoja-dw-hk3-");
		const { api, calls } = fakeServer();
		const d = new DecisionDelivery({ dataDir: dir, api: () => api, ackAfterEvents: 2 });
		const t = join(dir, "t.jsonl");
		writeFileSync(t, "{}\n");
		d.store.add({ id: ID, sessionId: "s6", state: "delivered", fence: 1 });
		await d.observe("s6", { transcript_path: t });
		expect(calls).toEqual([]);
		await d.observe("s6", { transcript_path: t });
		expect(calls.map(c => c.action)).toEqual(["ack"]);
	});

	it("delivers an answer that arrived while idle at the next prompt", async () => {
		const dir = tmp("hoja-dw-hk4-");
		const { api } = fakeServer({ answerAt: 1 });
		const d = new DecisionDelivery({ dataDir: dir, api: () => api });
		d.store.add({ id: ID, sessionId: "s7", heldAt: new Date().toISOString() });
		expect(await d.atPrompt("s7")).toContain("<<<ANSWER");
		expect(d.store.get("s7", ID)?.via).toBe("prompt");
		expect(await d.atPrompt("s7")).toBeUndefined();
	});

	for (const [host, shape] of [["claude", "block"], ["codex", "block"], ["antigravity", "continue"]] as const) {
		it(`the bridge continues a ${host} Stop with decision:${shape} + the framed answer`, async () => {
			const prev = process.env.HOJA_PLUGIN_HOST;
			process.env.HOJA_PLUGIN_HOST = host;
			try {
				const dir = tmp("hoja-dw-br-");
				const { api } = fakeServer({ answerAt: 1 });
				const decisions = new DecisionDelivery({ dataDir: dir, api: () => api });
				const { bridge } = createRuntime({ dataDir: dir, cwd: dir, hoja: false, trace: { enabled: false }, enforcementMode: "off", host, decisions });
				await bridge.handle("UserPromptSubmit", { session_id: "s8", prompt: "hi" });
				bridge.registration.onSettle(bridge.tasks());
				decisions.store.add({ id: ID, sessionId: "s8" });
				const out: any = await bridge.handle("Stop", { session_id: "s8", last_assistant_message: "asked" });
				expect(out.decision).toBe(shape);
				expect(out.reason).toContain(`⟦hoja-decision ${ID}#1⟧`);
			} finally { if (prev === undefined) delete process.env.HOJA_PLUGIN_HOST; else process.env.HOJA_PLUGIN_HOST = prev; }
		});
	}
});

describe("Claude Code background waiter (asyncRewake)", () => {
	it("exits 2 with the framed answer on stderr and marks it delivered", async () => {
		const dir = tmp("hoja-dw-w-");
		new DecisionStore(dir).add({ id: ID, sessionId: "s9" });
		const { api, calls } = fakeServer({ answerAt: 2 });
		let written = "";
		const code = await runWaiter({ input: { session_id: "s9" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, dataDir: dir, api, graceMs: 0, harnessPid: process.pid, write: t => { written = t; } });
		expect(code).toBe(2);
		expect(written).toContain(`⟦hoja-decision ${ID}#1⟧`);
		expect(calls.map(c => c.action)).toEqual(["wait", "wait", "take", "delivered"]);
		expect(new DecisionStore(dir).get("s9", ID)).toMatchObject({ state: "delivered", via: "rewake" });
	});

	it("does nothing headless, without an open decision, or while another waiter holds the lock", async () => {
		const dir = tmp("hoja-dw-w2-");
		const { api, calls } = fakeServer({ answerAt: 1 });
		expect(await runWaiter({ input: { session_id: "s10" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, dataDir: dir, api, graceMs: 0 })).toBe(0);
		new DecisionStore(dir).add({ id: ID, sessionId: "s10" });
		expect(await runWaiter({ input: { session_id: "s10" }, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, dataDir: dir, api, graceMs: 0 })).toBe(0);
		mkdirSync(join(dir, "decisions"), { recursive: true });
		writeFileSync(join(dir, "decisions", "s10.waiter.lock"), String(process.ppid));
		expect(await runWaiter({ input: { session_id: "s10" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, dataDir: dir, api, graceMs: 0 })).toBe(0);
		expect(calls).toEqual([]);
	});

	it("never takes while the Stop hook is holding", async () => {
		const dir = tmp("hoja-dw-w3-");
		new DecisionStore(dir).add({ id: ID, sessionId: "s11", holdUntil: Date.now() + 60_000 });
		const { api, calls } = fakeServer({ answerAt: 1 });
		expect(await runWaiter({ input: { session_id: "s11" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, dataDir: dir, api, graceMs: 0, maxSeconds: 1.5, harnessPid: process.pid })).toBe(0);
		expect(calls.some(c => c.action === "take")).toBe(false);
	});
});
