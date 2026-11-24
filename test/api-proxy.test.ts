import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy, parseMessages, resolveMcpUrl, type Fetch } from "../src/api-proxy.ts";
import { readTouchedIssues, recordActiveSession } from "../src/trace/touched.ts";
import { canonicalToolName } from "../src/transcript.ts";
import { createRuntime, hojaDoctor } from "../src/runtime.ts";

const sse = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
function fakeHoja(calls: { body: any; headers: Record<string, string> }[]): Fetch {
	return async (_url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ body, headers: init.headers });
		const reply = (result: unknown) => ({ status: 200, headers: { get: (n: string) => n === "content-type" ? "text/event-stream" : null }, text: async () => sse({ jsonrpc: "2.0", id: body.id, result }) });
		if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: "hoja", version: "1.0.1" }, instructions: "Hoja is a work tracker" });
		if (body.method === "notifications/initialized") return { status: 202, headers: { get: () => null }, text: async () => "" };
		if (body.method === "tools/list") return body.params?.cursor
			? reply({ tools: [{ name: "hoja_commentCreate", inputSchema: { type: "object" } }] })
			: reply({ tools: [{ name: "hoja_issues", inputSchema: { type: "object" } }], nextCursor: "p2" });
		if (body.method === "tools/call") return reply({ content: [{ type: "text", text: `called ${body.params.name}` }] });
		return { status: 400, headers: { get: () => null }, text: async () => "" };
	};
}

describe("hosted Hoja API proxy", () => {
	it("resolves the MCP endpoint like Trebol resolves GraphQL, with no default", () => {
		expect(resolveMcpUrl({ HOJA_MCP_URL: "https://a.hoja.work/mcp" })).toBe("https://a.hoja.work/mcp");
		expect(resolveMcpUrl({ HOJA_API_URL: "https://b.hoja.work/graphql?x=1" })).toBe("https://b.hoja.work/mcp");
		expect(resolveMcpUrl({ LINEAR_API_URL: "https://c.hoja.work/graphql" })).toBe("https://c.hoja.work/mcp");
		expect(resolveMcpUrl({})).toBe("");
	});
	it("parses JSON and SSE bodies", () => {
		expect(parseMessages('{"id":1}', "application/json")).toEqual([{ id: 1 }]);
		expect(parseMessages(": ping\n\n" + sse({ id: 2 }), "text/event-stream; charset=utf-8")).toEqual([{ id: 2 }]);
	});
	it("fails closed without endpoint or token: no tools, reason in instructions", async () => {
		const proxy = createProxy({});
		expect((await proxy.handle("initialize", { protocolVersion: "2025-06-18" })).instructions).toContain("No Hoja endpoint configured");
		expect(await proxy.handle("tools/list", {})).toEqual({ tools: [] });
		const noToken = createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql" });
		expect((await noToken.handle("initialize", {})).instructions).toContain("HOJA_TOKEN is not set");
	});
	it("forwards initialize instructions, paginated tools/list and tools/call with a Bearer token and actor/session headers", async () => {
		const calls: any[] = [];
		const dataDir = mkdtempSync(join(tmpdir(), "hoja-proxy-act-"));
		recordActiveSession(dataDir, "sess-proxy-1", process.ppid);
		const proxy = createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "tok", HOJA_PLUGIN_DATA: dataDir }, fakeHoja(calls));
		expect((await proxy.handle("initialize", { protocolVersion: "2025-06-18" })).instructions).toBe("Hoja is a work tracker");
		expect((await proxy.handle("tools/list", {})).tools.map((t: any) => t.name)).toEqual(["hoja_artifactUpload", "hoja_decisionWait", "hoja_issues", "hoja_commentCreate"]);
		expect(await proxy.handle("tools/call", { name: "hoja_issues", arguments: {} })).toEqual({ content: [{ type: "text", text: "called hoja_issues" }] });
		expect(readTouchedIssues(dataDir, "sess-proxy-1")).toEqual([]);
		await proxy.handle("tools/call", { name: "hoja_commentCreate", arguments: { issueId: "HOJA-77", body: "hi" } });
		expect(readTouchedIssues(dataDir, "sess-proxy-1")).toEqual(["HOJA-77"]);
		expect(calls.every(c => c.headers.authorization === "Bearer tok")).toBe(true);
		expect(calls.every(c => c.headers["x-hoja-actor"] === "agent" && c.headers["x-hoja-session-id"] === "sess-proxy-1")).toBe(true);
		expect(calls.filter(c => c.body.method === "initialize")).toHaveLength(1);
	});
	it("reports a rejected token as a tool error, not a crash", async () => {
		const proxy = createProxy({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "bad" }, async () => ({ status: 401, headers: { get: () => null }, text: async () => "" }));
		const r = await proxy.handle("tools/call", { name: "hoja_issues", arguments: {} });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("rejected the token (401)");
	});
});

describe("hosted API tools under Pi's names", () => {
	it("maps plugin names to Pi's mcp__hoja__ namespace", () => {
		expect(canonicalToolName("mcp__plugin_hoja_hoja-api__hoja_issueCreate")).toBe("mcp__hoja__hoja_issueCreate");
		expect(canonicalToolName("mcp__plugin_hoja_hoja_api__hoja_issues")).toBe("mcp__hoja__hoja_issues");
		expect(canonicalToolName("mcp__plugin_hoja_hoja__TaskManage")).toBe("TaskManage");
		expect(canonicalToolName("Bash")).toBe("Bash");
	});
	it("gates them like Pi gates mcp__hoja__ tools, and accepts their evidence under either name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hoja-api-"));
		const transcript = join(dir, "t.jsonl");
		writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "go" } }) + "\n");
		const rt = createRuntime({ dataDir: join(dir, "data"), cwd: dir, hoja: false });
		const base = { session_id: "s", transcript_path: transcript, cwd: dir, agent_id: "" };
		const pre: any = await rt.bridge.handle("PreToolUse", { ...base, tool_name: "mcp__plugin_hoja_hoja-api__hoja_issueCreate", tool_input: "{}", tool_use_id: "a" });
		expect(pre.hookSpecificOutput.permissionDecision).toBe("deny");
		const tool = rt.shim.tools.get("TaskManage")!;
		const run = async (args: unknown) => JSON.parse((await tool.execute("c", args, undefined, undefined, rt.shim.ctx())).content[0].text);
		await run({ operations: [{ key: "a", op: "create", subject: "S", status: "in_progress", active: true, questions: [{ id: "q", text: "?" }] }] });
		appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "tool_use", id: "h1", name: "mcp__plugin_hoja_hoja-api__hoja_issues", input: {} }], stop_reason: "tool_use" } }) + "\n"
			+ JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "h1", content: "ok" }] } }) + "\n");
		expect((await run({ operations: [{ key: "c", op: "update", taskId: "1", status: "completed", answers: [{ question: "q", answer: "y", evidence: "tool:mcp__plugin_hoja_hoja-api__hoja_issues" }] }] })).status).toBe("succeeded");
	});
});

describe("/hoja:setup doctor", () => {
	it("names missing credentials without probing and never echoes a token", async () => {
		expect((await hojaDoctor({})).join("\n")).toMatch(/HOJA_TOKEN is not set[\s\S]*No Hoja endpoint configured/);
		const lines = (await hojaDoctor({ HOJA_API_URL: "https://x.hoja.work/graphql", HOJA_TOKEN: "s3cret" }, async (url: string) => url.endsWith("/graphql")
			? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { viewer: { name: "Ada" } } }) }
			: { status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: "up-1", result: { serverInfo: { name: "hoja", version: "1.0.1" } } }) })).join("\n");
		expect(lines).toContain("signed in as Ada");
		expect(lines).toContain("✓ hoja 1.0.1");
		expect(lines).toContain("https://x.hoja.work/mcp");
		expect(lines).not.toContain("s3cret");
	});
});
