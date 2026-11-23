/**
 * The Antigravity command hook: `node ./dist/agy-hook.mjs <Event>`, one process per hook call.
 *
 * SessionStart is answered here (the same context the Claude/Codex SessionStart hook prints, as an injected system
 * message), because it only needs files. Every other event is translated (agy.ts) and handed to this session's MCP
 * server over its socket (agy-socket.ts), where the vendored Trebol pipeline decides, exactly as for Claude Code.
 * When the server cannot be reached the hook fails open: PreToolUse answers `ask` (Antigravity's own permissions
 * decide), everything else answers nothing.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { agyBase, agyToBridge, bridgeToAgy, failOpen } from "./agy.ts";
import { findSocket, request } from "./agy-socket.ts";
import { applyCredentials, dataDir, traceDetail } from "./env.ts";
import { sessionContext } from "./session-start.ts";
import { TraceRecorder } from "./trace/recorder.ts";

const debug = (line: string) => {
	const log = process.env.HOJA_DEBUG_LOG?.trim();
	if (log) try { appendFileSync(log, `${new Date().toISOString()} [agy-hook] ${line}\n`); } catch { /* best effort */ }
};

export async function handleAgyHook(event: string, payload: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
	if (event === "SessionStart") {
		const base = agyBase(payload);
		new TraceRecorder({ dataDir: dataDir(env), detail: traceDetail(env) }).record(base.session_id, "SessionStart", { ...base, source: "startup" });
		const text = await sessionContext({ session_id: base.session_id, transcript_path: base.transcript_path, cwd: base.cwd }, env);
		return text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {};
	}
	const socket = findSocket(env);
	if (!socket) { debug(`${event}: no hoja server socket found; failing open`); return failOpen(event); }
	const { event: bridgeEvent, payload: bridgePayload } = agyToBridge(event, payload);
	try {
		const out = await request(socket, { event: bridgeEvent, payload: bridgePayload });
		if (out?.error) { debug(`${event}: server error ${out.error}`); return failOpen(event); }
		return bridgeToAgy(event, out, event === "PreToolUse" ? { tool_name: bridgePayload.tool_name, tool_input: bridgePayload.tool_input } : undefined);
	} catch (error) {
		debug(`${event}: ${(error as Error).message}; failing open`);
		return failOpen(event);
	}
}

async function main() {
	const event = process.argv[2] ?? "";
	let payload: Record<string, any> = {};
	try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* empty */ }
	if (event === "SessionStart") applyCredentials();
	const out = await handleAgyHook(event, payload);
	process.stdout.write(JSON.stringify(out) + "\n");
}
if (process.argv[1] && /agy-hook\.(m?js|ts)$/.test(process.argv[1]))
	main().catch(error => { debug(`crashed: ${error?.stack ?? error}`); process.stdout.write(JSON.stringify(failOpen(process.argv[2] ?? "")) + "\n"); });
