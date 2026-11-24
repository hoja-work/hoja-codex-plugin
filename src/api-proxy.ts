/**
 * The hosted Hoja product MCP endpoint (`https://<workspace>/mcp`, ~50 tools: issues, comments, decisions, projects,
 * cycles…) exposed to Claude Code as a stdio server.
 *
 * Trebol's Pi setup pairs hoja-mode with this endpoint (`~/.pi/agent/mcp.json` "hoja": streamable HTTP, Bearer token
 * resolved from the environment at spawn). Linear, GitHub and GitLab ship their hosted servers the same way in their
 * Claude Code plugins, but a plugin `url` is static, while Trebol deliberately has no default endpoint
 * (.pi/lib/claw/hoja.ts). So the endpoint and token resolve here, with the vendored rules, and the proxy fails closed:
 * unconfigured, it serves no tools and says why.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HOJA_ENDPOINT_HINT, MISSING_HOJA_TOKEN, resolveHojaToken, resolveHojaUrl } from "../vendor/trebol/.pi/lib/claw/hoja.ts";
import { applyCredentials, dataDir } from "./env.ts";
import { authFetch, normalizeEndpoint, SIGN_IN_HINT, type Credentials } from "./credentials.ts";
import { hostOf } from "./host.ts";
import { appendTouchedIssues, extractTouchedIssuesFromTool, readActiveSession } from "./trace/touched.ts";
import {
	BOUND_NOTE, collectBinding, confirmAcked, confirmDelivered, DECISION_CREATE_TOOLS, DECISION_WAIT_TOOL, DecisionStore, decisionIdOf,
	MAX_TOOL_WAIT_S, newWaiterId, watchDecisions, type Binding, type DecisionApi, type RunCommand,
} from "./decision-wait.ts";
import { ARTIFACT_UPLOAD_TOOL, originOf, rewriteLocalMedia, runArtifactUpload, writesUserText, type ArtifactClient, type HttpFetch } from "./artifacts.ts";

type Json = Record<string, any>;
type Env = Record<string, string | undefined>;

/** HOJA_MCP_URL, else the GraphQL endpoint's host with path /mcp (the inverse of resolveHojaUrl's MCP→GraphQL rule). */
export function resolveMcpUrl(env: Env = process.env): string {
	const direct = env.HOJA_MCP_URL?.trim();
	if (direct) return normalizeEndpoint(direct).url;
	const graphql = resolveHojaUrl(env);
	if (!graphql) return "";
	try { const u = new URL(graphql); u.pathname = "/mcp"; u.search = ""; u.hash = ""; return u.toString(); } catch { return ""; }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** Minimal streamable-HTTP MCP client: one POST per message; the answer is JSON or an SSE stream. */
export class UpstreamMcp {
	private session?: string;
	private seq = 0;
	protocolVersion = "2025-06-18";
	constructor(
		readonly url: string,
		private readonly token: string,
		private readonly fetchImpl: Fetch = fetch as any,
		private readonly extraHeaders?: () => Record<string, string | undefined>,
	) {}

	async send(method: string, params: Json | undefined, notification = false, signal?: AbortSignal): Promise<any> {
		const id = notification ? undefined : `up-${++this.seq}`;
		const headers: Record<string, string> = {
			"content-type": "application/json", accept: "application/json, text/event-stream",
			authorization: `Bearer ${this.token}`, "mcp-protocol-version": this.protocolVersion,
			"x-hoja-actor": "agent",
		};
		if (this.extraHeaders) {
			for (const [k, v] of Object.entries(this.extraHeaders())) {
				if (v) headers[k] = v;
			}
		}
		if (this.session) headers["mcp-session-id"] = this.session;
		const response = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, ...(params ? { params } : {}) }), signal });
		const session = response.headers.get("mcp-session-id");
		if (session) this.session = session;
		const text = await response.text();
		if (notification) return undefined;
		if (response.status === 401 || response.status === 403) throw new Error(`Hoja MCP rejected the token (${response.status}). ${SIGN_IN_HINT}`);
		if (response.status >= 400) throw new Error(`Hoja MCP ${this.url} answered HTTP ${response.status}`);
		const message = parseMessages(text, response.headers.get("content-type") ?? "").find(m => m.id === id);
		if (!message) throw new Error(`Hoja MCP returned no response for ${method}`);
		if (message.error) throw new Error(message.error.message ?? `Hoja MCP ${method} failed`);
		return message.result;
	}
}

export function parseMessages(body: string, contentType: string): Json[] {
	if (!contentType.includes("text/event-stream")) { try { const v = JSON.parse(body); return Array.isArray(v) ? v : [v]; } catch { return []; } }
	const out: Json[] = [];
	for (const event of body.split(/\r?\n\r?\n/)) {
		const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
		if (data) try { out.push(JSON.parse(data)); } catch { /* keep-alive or partial */ }
	}
	return out;
}

/** The model never sees (or fills) `binding`: the plugin owns the session identity. */
export function hideBinding(tool: Json): Json {
	if (!DECISION_CREATE_TOOLS.has(String(tool?.name)) || !tool?.inputSchema?.properties?.binding) return tool;
	const { binding: _drop, ...properties } = tool.inputSchema.properties;
	const { DecisionBindingInput: _def, ...defs } = tool.inputSchema.$defs ?? {};
	return { ...tool, inputSchema: { ...tool.inputSchema, properties, ...(tool.inputSchema.$defs ? { $defs: defs } : {}) } };
}

export interface ProxyDeps { run?: RunCommand; ppid?: number; home?: string; hostName?: string }

export function createProxy(env: Env = process.env, fetchImpl?: Fetch, credentials?: Credentials, pluginDataDir?: string, storageFetch?: HttpFetch, deps: ProxyDeps = {}) {
	const url = resolveMcpUrl(env);
	const token = credentials ? credentials.token() : resolveHojaToken(env);
	const configProblem = credentials?.problems.join(" ") ?? "";
	const problem = configProblem || (!url ? HOJA_ENDPOINT_HINT : !token ? `${MISSING_HOJA_TOKEN}. ${SIGN_IN_HINT}` : "");
	const sessionDir = pluginDataDir ?? (env.HOJA_PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA ? dataDir(env) : "");
	const host = hostOf(env);
	const clientName = host === "claude" ? "claude-code" : host;
	const headerProvider = () => ({
		"x-hoja-actor": "agent",
		"x-hoja-client": clientName,
		...(sessionDir ? { "x-hoja-session-id": readActiveSession(sessionDir) } : {}),
	});
	const transport = credentials ? authFetch(credentials, (fetchImpl ?? fetch) as any, headerProvider) as Fetch : fetchImpl;
	const upstream = problem ? undefined : new UpstreamMcp(url, token, transport, headerProvider);
	let ready: Promise<Json> | undefined;
	let failure = problem;
	// Hoja's REST upload routes share the MCP transport's auth; the presigned storage PUT carries its own signature.
	const hojaFetch: HttpFetch = credentials
		? authFetch(credentials, (fetchImpl ?? fetch) as any, headerProvider) as any
		: (u, init) => ((fetchImpl ?? fetch) as any)(u, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, ...headerProvider() } });
	const artifacts: ArtifactClient = { origin: originOf(url), hojaFetch, plainFetch: (storageFetch ?? fetch) as any, cwd: env.CLAUDE_PROJECT_DIR || process.cwd() };
	const decisionApi: DecisionApi = { origin: artifacts.origin, fetch: hojaFetch as any };
	const decisions = sessionDir ? new DecisionStore(sessionDir) : undefined;
	/** One stable waiter id for every wait and take this process makes (the server remembers the take's holder). */
	const waiterId = newWaiterId("tool");
	const bindingFor = (meta?: Json): Binding | undefined =>
		collectBinding({ host, env: env as NodeJS.ProcessEnv, dataDir: sessionDir || undefined, meta, ppid: deps.ppid, run: deps.run, home: deps.home, hostName: deps.hostName });

	/** hoja_taskDecisionCreate / hoja_issueDecisionCreate: strip any model-supplied binding, add the session's own. */
	async function createDecision(params: Json, signal?: AbortSignal): Promise<Json> {
		const { binding: _ignored, ...args } = params?.arguments ?? {};
		const binding = bindingFor(params?._meta);
		const call = (b?: Binding) => upstream!.send("tools/call", { ...params, arguments: b ? { ...args, binding: b } : args }, false, signal);
		let result = await call(binding);
		const text = (r: Json) => Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? "").join("\n") : "";
		// The server refuses a runnerId the asker did not enroll; the decision still binds hot without it.
		if (binding?.runnerId && result?.isError && /runner/i.test(text(result))) {
			const { runnerId: _r, ...rest } = binding;
			result = await call(rest);
		}
		if (!binding || result?.isError) return result;
		const id = decisionIdOf(text(result));
		if (id && decisions) {
			decisions.add({ id, sessionId: binding.sessionId, issueId: typeof args.issueId === "string" ? args.issueId : undefined, question: typeof args.question === "string" ? args.question.slice(0, 200) : undefined, transcriptPath: binding.transcriptPath });
			if (Array.isArray(result?.content)) result.content = [...result.content, { type: "text", text: BOUND_NOTE(id) }];
		}
		return result;
	}

	/** hoja_decisionWait: stage 1, in-turn. The framed answer is the tool result; delivered + ack follow at once. */
	async function decisionWait(params: Json, signal?: AbortSignal): Promise<Json> {
		const args = params?.arguments ?? {};
		const id = typeof args.id === "string" ? args.id.trim() : "";
		const seconds = Math.max(1, Math.min(MAX_TOOL_WAIT_S, Number(args.timeoutSeconds) || 300));
		const reply = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
		if (!id) return reply("id is required: the decision id hoja_taskDecisionCreate returned.", true);
		if (!decisions) return reply("Waiting needs the plugin data directory; it is not configured.", true);
		let rec = findDecision(decisions, id);
		if (!rec) {
			const binding = bindingFor(params?._meta);
			if (!binding) return reply(`Decision ${id} is not bound to this session, so its answer cannot be delivered here. Poll it with hoja_taskDecision.`, true);
			rec = decisions.add({ id, sessionId: binding.sessionId });
		}
		if (rec.state === "delivered" || rec.state === "acked") return reply(`Decision ${id} was already delivered into this session${rec.via ? ` (via ${rec.via})` : ""}; its answer is above in the conversation.`);
		if (rec.state === "closed") return reply(`Decision ${id} is closed (${rec.closedReason ?? "unknown"}); there is no answer to deliver.`);
		if (rec.state === "delivering") return reply(`Decision ${id} is being delivered by another part of this session right now; the answer will appear as your next input.`);
		const out = await watchDecisions({ api: decisionApi, store: decisions, sessionId: rec.sessionId, waiterId, ids: [id], deadline: Date.now() + seconds * 1000, signal });
		if (out.kind === "answer") {
			await confirmDelivered(decisionApi, decisions, out.decision, "tool");
			// The tool result is the session's next input by construction: acknowledge right away.
			await confirmAcked(decisionApi, decisions, { ...out.decision, state: "delivered" });
			return reply(out.take.text);
		}
		const now = decisions.get(rec.sessionId, id);
		if (now?.state === "closed") return reply(`Decision ${id} ended without an answer to deliver here (${now.closedReason}).`);
		if (now && now.state !== "open") return reply(`Decision ${id} was delivered by another part of this session (${now.via ?? now.state}); its answer is in the conversation.`);
		return reply(`No answer yet after ${seconds}s; decision ${id} is still open. Call hoja_decisionWait again, or end your turn: the answer will be delivered into this session when the person answers.`);
	}
	const connect = (protocolVersion: string) => ready ??= (async () => {
		upstream!.protocolVersion = protocolVersion;
		const result = await upstream!.send("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: `hoja-${host}-plugin`, version: "0.2.0" } });
		if (typeof result?.protocolVersion === "string") upstream!.protocolVersion = result.protocolVersion;
		await upstream!.send("notifications/initialized", undefined, true);
		return result;
	})().catch(error => { failure = (error as Error).message; ready = undefined; throw error; });

	async function handle(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
		if (method === "initialize") {
			const protocolVersion = params?.protocolVersion ?? "2025-06-18";
			let instructions = "";
			if (upstream) { try { instructions = (await connect(protocolVersion))?.instructions ?? ""; } catch { /* reported below */ } }
			if (failure) instructions = `Hoja API unavailable: ${failure}`;
			return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "hoja-api", version: "0.2.0" }, ...(instructions ? { instructions } : {}) };
		}
		if (method === "tools/list") {
			if (!upstream) return { tools: [] };
			try {
				await connect(upstream.protocolVersion);
				const tools: Json[] = [];
				let cursor: string | undefined;
				do { const page = await upstream.send("tools/list", cursor ? { cursor } : {}, false, signal); tools.push(...(page?.tools ?? [])); cursor = page?.nextCursor; } while (cursor);
				return { tools: [ARTIFACT_UPLOAD_TOOL, DECISION_WAIT_TOOL, ...tools.map(hideBinding)] };
			} catch { return { tools: [] }; }
		}
		if (method === "tools/call") {
			if (!upstream) return { content: [{ type: "text", text: `Hoja API unavailable: ${failure}` }], isError: true };
			try {
				await connect(upstream.protocolVersion);
				const name = String(params?.name ?? "");
				if (name === ARTIFACT_UPLOAD_TOOL.name) return await runArtifactUpload(artifacts, params?.arguments ?? {});
				if (name === DECISION_WAIT_TOOL.name) return await decisionWait(params, signal);
				let notes: string[] = [];
				if (writesUserText(name) && params?.arguments) {
					const rewritten = await rewriteLocalMedia(artifacts, params.arguments);
					params = { ...params, arguments: rewritten.args };
					notes = [
						...rewritten.uploaded.map(u => `Uploaded ${u.path} → ${u.absoluteUrl} (the local path was replaced with this link).`),
						...rewritten.errors.map(e => `Could not upload a referenced file: ${e}. Use hoja_artifactUpload, never a local path.`),
					];
				}
				const result = DECISION_CREATE_TOOLS.has(name) ? await createDecision(params, signal) : await upstream.send("tools/call", params, false, signal);
				if (notes.length && Array.isArray(result?.content)) result.content = [...result.content, { type: "text", text: notes.join("\n") }];
				if (sessionDir && !result?.isError) {
					const activeSid = readActiveSession(sessionDir);
					if (activeSid) {
						const text = Array.isArray(result?.content) ? result.content.map((c: any) => c?.text ?? "").join("\n") : "";
						const touched = extractTouchedIssuesFromTool(String(params?.name ?? ""), params?.arguments, text);
						if (touched.length) appendTouchedIssues(sessionDir, activeSid, touched);
					}
				}
				return result;
			}
			catch (error) { return { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
		}
		if (method === "ping") return {};
		throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
	}
	return { handle, url, problem: () => failure };
}

/** A decision recorded by this plugin, in any session's store (the model passes only the id). */
function findDecision(store: DecisionStore, id: string) {
	try {
		for (const file of readdirSync(join(store.dataDir, "decisions"))) {
			if (!file.endsWith(".json") || file.startsWith(".")) continue;
			const hit = store.get(file.slice(0, -5), id);
			if (hit) return hit;
		}
	} catch { /* no store yet */ }
	return undefined;
}

function main() {
	const credentials = applyCredentials();
	const proxy = createProxy(process.env, undefined, credentials, dataDir());
	const send = (m: Json) => process.stdout.write(JSON.stringify(m) + "\n");
	const inflight = new Map<unknown, AbortController>();
	createInterface({ input: process.stdin }).on("line", async line => {
		let message: Json;
		try { message = JSON.parse(line); } catch { return; }
		const { id, method, params } = message;
		if (method === "notifications/cancelled") { inflight.get(params?.requestId)?.abort(); return; }
		if (id === undefined || typeof method !== "string") return;
		const controller = new AbortController();
		inflight.set(id, controller);
		try { send({ jsonrpc: "2.0", id, result: await proxy.handle(method, params ?? {}, controller.signal) }); }
		catch (error) { send({ jsonrpc: "2.0", id, error: { code: (error as any).code ?? -32603, message: (error as Error).message } }); }
		finally { inflight.delete(id); }
	}).on("close", () => process.exit(0));
}
if (process.argv[1] && /api-proxy\.(m?js|ts)$/.test(process.argv[1])) main();
