/**
 * MCP stdio server (newline-delimited JSON-RPC 2.0), one process per Claude Code session.
 *
 * Serves the tools Trebol's extensions register (TaskManage, hoja_list, hoja_get, hoja_project) and one unlisted
 * tool, `__hoja_hook`, that the plugin's `mcp_tool` hooks call. Because hooks and tools land in the same process, the
 * task state, the Swarm hook pipeline and hoja publication share memory exactly as they do inside Pi.
 */
import { appendFileSync } from "node:fs";
import { hostOf } from "./host.ts";
import { createInterface } from "node:readline";
import { createRuntime } from "./runtime.ts";
import { PLUGIN_VERSION } from "./trace/collect.ts";
import { applyCredentials, dataDir, enforcementMode, headless, traceDetail, traceUpload, truthy } from "./env.ts";

export const HOOK_TOOL = "__hoja_hook";

type Json = Record<string, any>;
const send = (message: Json) => process.stdout.write(JSON.stringify(message) + "\n");
const debugLog = process.env.HOJA_DEBUG_LOG?.trim();
const log = (line: string) => {
	process.stderr.write(`[hoja] ${line}\n`);
	if (debugLog) try { appendFileSync(debugLog, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
};

applyCredentials();
let elicitation = false;
let nextRequest = 0;
const waiting = new Map<string, (result: any) => void>();
const request = (method: string, params: Json) => new Promise<any>((resolve) => {
	const id = `hoja-${nextRequest++}`;
	waiting.set(id, resolve);
	send({ jsonrpc: "2.0", id, method, params });
});
/** Pi's ctx.ui.confirm (hoja_project create/remember) through MCP elicitation, when the client supports it. */
const confirm = async (title: string, message: string) => {
	const result = await request("elicitation/create", {
		message: `${title}\n\n${message}`,
		requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Confirm", description: title } }, required: ["confirm"] },
	});
	return result?.action === "accept" && result?.content?.confirm === true;
};

const runtime = createRuntime({
	dataDir: dataDir(), cwd: process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd(), log,
	confirm: (title, message) => elicitation ? confirm(title, message) : Promise.resolve(false),
	enforcementMode: enforcementMode(), headless: headless(), autogenSkills: truthy(process.env.HOJA_AUTOGEN_SKILLS),
	hoja: !truthy(process.env.HOJA_PLUGIN_DISABLE_HOJA),
	trace: { upload: traceUpload(), detail: traceDetail() },
});
if (debugLog) log(`start host=${hostOf()} dataDir=${dataDir()} enforcement=${enforcementMode()} headless=${headless()}`);
const { shim, bridge } = runtime;
let calls = 0;

async function callTool(name: string, args: Json, signal: AbortSignal): Promise<Json> {
	if (name === HOOK_TOOL) {
		const output = await bridge.handle(String(args.event ?? ""), args);
		return { content: [{ type: "text", text: JSON.stringify(output) }] };
	}
	const tool = shim.tools.get(name);
	if (!tool) return { content: [{ type: "text", text: `Error: Tool '${name}' not found` }], isError: true };
	const toolCallId = bridge.takeToolCallId(name) ?? `hoja-call-${++calls}`;
	let result: any;
	try { result = await tool.execute(toolCallId, args, signal, undefined, shim.ctx()); }
	catch (error) {
		result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: (error as any)?.details, isError: true };
	}
	const isError = result?.isError === true;
	const content = await shim.emitToolResult({ toolName: name, toolCallId, input: args, content: Array.isArray(result?.content) ? result.content : [], details: result?.details, isError });
	return { content: content.filter((part: any) => part?.type === "text").map((part: any) => ({ type: "text", text: String(part.text) })), isError };
}

const inflight = new Map<string | number, AbortController>();
async function onMessage(message: Json) {
	if (message.id !== undefined && message.method === undefined) { waiting.get(String(message.id))?.(message.result ?? { action: "cancel" }); waiting.delete(String(message.id)); return; }
	const { id, method, params } = message;
	if (debugLog) log(`<- ${method ?? "response"}${method === "tools/call" ? ` ${params?.name} ${JSON.stringify(params?.arguments ?? {}).slice(0, 400)}` : ""}`);
	try {
		if (method === "initialize") {
			elicitation = !!params?.capabilities?.elicitation;
			return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hoja", version: PLUGIN_VERSION } } });
		}
		if (method === "tools/list") {
			// Pi puts every registered tool in the prompt. Claude Code defers MCP tools behind ToolSearch unless asked not
			// to, and a deferred TaskManage cannot be reached while the task gate blocks everything else.
			const tools = [...shim.tools.values()].map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters, _meta: { "anthropic/alwaysLoad": true } }));
			return send({ jsonrpc: "2.0", id, result: { tools } });
		}
		if (method === "tools/call") {
			const controller = new AbortController();
			inflight.set(id, controller);
			try { return send({ jsonrpc: "2.0", id, result: await callTool(String(params?.name), params?.arguments ?? {}, controller.signal) }); }
			finally { inflight.delete(id); }
		}
		if (method === "notifications/cancelled") { inflight.get(params?.requestId)?.abort(); return; }
		if (id === undefined) return; // other notifications
		if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
	} catch (error) {
		log(`${method} failed: ${(error as Error).stack ?? error}`);
		if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: (error as Error).message } });
	}
}

createInterface({ input: process.stdin }).on("line", line => {
	if (!line.trim()) return;
	let message: Json;
	try { message = JSON.parse(line); } catch { return; }
	void onMessage(message);
}).on("close", async () => { await shim.emit("session_shutdown"); process.exit(0); });
