/**
 * Composition root: the same registrations Trebol's Pi extensions perform, against the Pi shim.
 *
 *  extensions/taskmanage/extension.ts  → registerTaskManage(...) + task manager handle + builtin Swarm hook pipeline
 *                                         (block mode) + silent task-hooks coordinator + /tasks
 *  extensions/hoja-mode/extension.ts   → registerHojaMode(pi)  (hoja_list, hoja_get, hoja_project, publication, /hoja)
 *
 * Everything below `vendor/trebol/` is byte-identical to Trebol (see vendor/MANIFEST.json).
 */
import { registerTaskManage, taskManageRenderers, taskWidgetRenderer, type TaskManager } from "../vendor/trebol/packages/tools/taskmanage/src/task-manage.ts";
import { registerTaskHooks } from "../vendor/trebol/packages/tools/taskmanage/src/task-hooks.ts";
import { registerHojaMode } from "../vendor/trebol/extensions/hoja-mode/extension.ts";
import { HojaClient, HOJA_ENDPOINT_HINT, MISSING_HOJA_TOKEN, resolveHojaToken, resolveHojaUrl } from "../vendor/trebol/.pi/lib/claw/hoja.ts";
import { canonicalToolName } from "./transcript.ts";
import { PiShim, type ShimOptions } from "./pi-shim.ts";
import { HookBridge, type BridgeOptions } from "./hook-bridge.ts";
import { resolveMcpUrl, UpstreamMcp } from "./api-proxy.ts";
import { wrapHojaWriter } from "./hoja-writer.ts";

export const TASK_MANAGER_SYMBOL = Symbol.for("pi-swarm-task-manager");

/**
 * `tool:mcp__plugin_hoja_hoja__TaskManage#2` (Claude) or `tool:mcp__hoja__TaskManage#2` (Codex) is how the host sees
 * the tool; Trebol records it as `TaskManage` (likewise the hosted API proxy's tools → `mcp__hoja__X`).
 */
const alias = (name: unknown) => typeof name === "string" && canonicalToolName(name) !== name ? canonicalToolName(name) : undefined;
const toolAliases = new Proxy({} as Record<string, readonly string[]>, {
	get: (_target, name) => { const a = alias(name); return a ? [a] : undefined; },
	has: (_target, name) => alias(name) !== undefined,
});

export interface RuntimeOptions extends ShimOptions, BridgeOptions {
	/** Injected in tests; production uses HojaClient resolved from HOJA_API_URL/HOJA_TOKEN (or LINEAR_*). */
	hojaClient?: unknown;
	hoja?: boolean;
}

export interface Runtime { shim: PiShim; manager: TaskManager; bridge: HookBridge }

export function createRuntime(options: RuntimeOptions): Runtime {
	const shim = new PiShim(options);
	const manager = registerTaskManage(shim.api as any, taskManageRenderers, { workspaceRoot: options.cwd, toolAliases });
	// extensions/taskmanage/extension.ts: Swarm's builtin hooks read task state through this handle.
	(globalThis as any)[TASK_MANAGER_SYMBOL] = manager;
	const bridge = new HookBridge(shim, manager, options);
	// extensions/taskmanage/extension.ts: the secondary coordinator is silent bookkeeping (task audit events) only.
	registerTaskHooks(shim.api as any, manager, { enforcementMode: "off", silent: true });
	// /tasks: Pi opens a read-only TUI browser; Claude Code shows the same widget as text.
	shim.api.registerCommand("tasks", { description: "Show the read-only task board", handler: () => taskBoard(manager) });
	// Publication goes through the same client Trebol's hoja-mode uses; the wrapper only adds what Trebol's
	// createIssue cannot express (the task's description and priority). See src/hoja-writer.ts.
	if (options.hoja !== false) {
		const client = (options.hojaClient ?? new HojaClient()) as object;
		registerHojaMode(shim.api, wrapHojaWriter(client, () => manager.snapshot().tasks, options.log) as any);
	}
	// One report behind both entry points: the /setup command (answered by the hook, no model turn) and the
	// `hoja_setup` tool, which is the fallback when that hook could not run.
	const setupReport = async (ctx: any = shim.ctx()): Promise<string> => {
		const hoja = shim.commands.get("hoja");
		const before = shim.notifications.length;
		if (hoja) await hoja.handler("status", ctx);
		const mode = shim.notifications.slice(before).map(n => n.message).join(" ");
		shim.notifications.length = before;
		return [`Task enforcement: ${options.enforcementMode ?? "block"}`, ...(await hojaDoctor()), mode && `Hoja mode: ${mode}`].filter(Boolean).join("\n");
	};
	// Claude-only: one place to see why Hoja is or isn't working (credential sources, both endpoints, mode, gate).
	shim.api.registerCommand("setup", {
		description: "Check Hoja credentials, endpoints, project and task enforcement",
		handler: (_args: string, ctx: any) => setupReport(ctx),
	});
	// Read-only fallback for the same report. Claude Code fails a hook open when its MCP server is not connected, so
	// commands/*.md tells the model to call this instead of guessing why the command reached it.
	shim.api.registerTool({
		name: "hoja_setup", label: "Hoja setup check",
		description: "Read-only health check for this plugin: task enforcement mode, Hoja credential sources, the GraphQL endpoint and the hosted MCP endpoint, Hoja mode for this chat and the task board. Prints the same report as /hoja:setup. Call it when /hoja:setup did not answer locally, and show its output verbatim.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_id: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: any) =>
			({ content: [{ type: "text", text: await setupReport(ctx ?? shim.ctx()) }], details: {} }),
	});
	return { shim, manager, bridge };
}

type Probe = (url: string, init: any) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
/** Never prints the token: only which variable supplied it and what each endpoint answered. */
export async function hojaDoctor(env: Record<string, string | undefined> = process.env, probe: Probe = fetch as any): Promise<string[]> {
	const graphql = resolveHojaUrl(env);
	const token = resolveHojaToken(env);
	const tokenSource = ["HOJA_TOKEN", "LINEAR_TOKEN"].find(name => env[name]?.trim());
	const lines = [
		`Token: ${token ? `set (from ${tokenSource}${env.HOJA_PLUGIN_TOKEN?.trim() ? ", plugin userConfig" : ""})` : MISSING_HOJA_TOKEN}`,
		`GraphQL endpoint: ${graphql || HOJA_ENDPOINT_HINT}`,
	];
	if (graphql && token) {
		try {
			const r = await probe(graphql, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query: "query { viewer { name } }" }), signal: AbortSignal.timeout(10_000) });
			const name = r.status === 200 ? JSON.parse(await r.text())?.data?.viewer?.name : undefined;
			lines.push(name ? `  ✓ signed in as ${name}` : `  ✗ HTTP ${r.status}`);
		} catch (error) { lines.push(`  ✗ ${(error as Error).message}`); }
	}
	const mcp = resolveMcpUrl(env);
	lines.push(`Hoja API MCP endpoint (hoja-api server): ${mcp || "not configured (set HOJA_MCP_URL or a GraphQL endpoint)"}`);
	if (mcp && token) {
		try {
			const result = await new UpstreamMcp(mcp, token, probe as any).send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hoja-setup", version: "0" } });
			lines.push(`  ✓ ${result?.serverInfo?.name ?? "server"} ${result?.serverInfo?.version ?? ""}`.trimEnd());
		} catch (error) { lines.push(`  ✗ ${(error as Error).message}`); }
	}
	return lines;
}

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
export function taskBoard(manager: TaskManager, width = 100): string {
	const tasks = manager.snapshot().tasks.filter(t => t.status !== "deleted");
	const widget = taskWidgetRenderer(tasks, plain).render(width);
	const icon = (s: string) => s === "completed" ? "✓" : s === "in_progress" ? "◉" : "○";
	const all = tasks.map(t => `  ${icon(t.status)} #${t.id}${t.parentTaskId ? ` (child of #${t.parentTaskId})` : ""} ${t.subject} [${t.status}${t.active ? ", active" : ""}]`);
	return [...widget, "", "All tasks:", ...(all.length ? all : ["  (none)"])].join("\n");
}
