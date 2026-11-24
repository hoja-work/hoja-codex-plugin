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
import { createInterface } from "node:readline";
import { HOJA_ENDPOINT_HINT, MISSING_HOJA_TOKEN, resolveHojaToken, resolveHojaUrl } from "../vendor/trebol/.pi/lib/claw/hoja.ts";
import { applyCredentials, dataDir } from "./env.ts";
import { authFetch, normalizeEndpoint, SIGN_IN_HINT, type Credentials } from "./credentials.ts";
import { hostOf } from "./host.ts";
import { appendTouchedIssues, extractTouchedIssuesFromTool, readActiveSession } from "./trace/touched.ts";
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

export function createProxy(env: Env = process.env, fetchImpl?: Fetch, credentials?: Credentials, pluginDataDir?: string, storageFetch?: HttpFetch) {
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
				return { tools: [ARTIFACT_UPLOAD_TOOL, ...tools] };
			} catch { return { tools: [] }; }
		}
		if (method === "tools/call") {
			if (!upstream) return { content: [{ type: "text", text: `Hoja API unavailable: ${failure}` }], isError: true };
			try {
				await connect(upstream.protocolVersion);
				const name = String(params?.name ?? "");
				if (name === ARTIFACT_UPLOAD_TOOL.name) return await runArtifactUpload(artifacts, params?.arguments ?? {});
				let notes: string[] = [];
				if (writesUserText(name) && params?.arguments) {
					const rewritten = await rewriteLocalMedia(artifacts, params.arguments);
					params = { ...params, arguments: rewritten.args };
					notes = [
						...rewritten.uploaded.map(u => `Uploaded ${u.path} → ${u.absoluteUrl} (the local path was replaced with this link).`),
						...rewritten.errors.map(e => `Could not upload a referenced file: ${e}. Use hoja_artifactUpload, never a local path.`),
					];
				}
				const result = await upstream.send("tools/call", params, false, signal);
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
