/**
 * SessionEnd command hook: finish the session's trace and, depending on `trace_upload`, attach it to Hoja.
 *
 * A command hook, not an mcp_tool hook: the docs do not promise the plugin's MCP server is still connected at
 * SessionEnd, and observational events do not wait for it. This process rebuilds the same state from disk (task
 * journal + hook records + transcript), so it needs nothing from the server.
 *
 * The hook itself only appends the SessionEnd record and returns: Claude Code's default SessionEnd budget is 1.5 s
 * shared by every hook, and Codex clamps a SessionEnd hook to 3 s. Building the trace, a `hoja auth token` refresh and
 * the upload run in a detached worker (`--finish`) that outlives the hook. HOJA_TRACE_SYNC=1 runs it inline.
 *
 *   completion   (default) catch up: attach to completed, linked tasks whose upload never happened
 *   session-end  also attach the final trace to every issue this session's tasks are linked to
 *   manual, off  only save the trace locally
 */
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { applyCredentials, applyUserConfig, dataDir, traceDetail, traceUpload, truthy } from "./env.ts";
import { createRuntime } from "./runtime.ts";
import { hojaLinks } from "./trace/collect.ts";
import { TraceRecorder } from "./trace/recorder.ts";
import { readLedger } from "./trace/upload.ts";

type EndInput = { session_id?: string; transcript_path?: string; cwd?: string; reason?: string };

/** The part that must happen before the hook returns: the SessionEnd record itself. */
export function recordSessionEnd(input: EndInput, env: NodeJS.ProcessEnv = process.env) {
	if (input.session_id) new TraceRecorder({ dataDir: dataDir(env), detail: traceDetail(env) }).record(input.session_id, "SessionEnd", input);
}

/** Record, then finish inline (tests, HOJA_TRACE_SYNC=1). */
export async function sessionEnd(input: EndInput, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	recordSessionEnd(input, env);
	return finishSession(input, env);
}

/** Save the final trace and upload what `trace_upload` asks for. Runs in the detached worker. */
export async function finishSession(input: EndInput, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const sessionId = input.session_id;
	if (!sessionId) return [];
	const dir = dataDir(env);
	const mode = traceUpload(env);
	// The same registrations the server performs, replayed from the journal: tasks and Hoja links, no network.
	const { shim, traces } = createRuntime({ dataDir: dir, cwd: input.cwd || process.cwd(), hoja: false, trace: { upload: mode, detail: traceDetail(env), env } });
	await shim.bindSession(sessionId, input.transcript_path, input.cwd);
	const out: string[] = [];
	const summary = await traces.run("path");
	out.push(`trace saved: ${summary}`);
	if (mode === "off" || mode === "manual" || traces.uploadProblem()) return out;
	out.push(...await traces.afterTaskManage());
	out.push(...await traces.syncSession("session-end"));
	if (mode === "session-end") {
		const done = new Set(readLedger(dir, sessionId).filter(e => e.reason === "session-end").map(e => e.issue));
		for (const issue of new Set(hojaLinks(shim.branch()).values())) {
			if (done.has(issue)) continue;
			try { await traces.upload(issue, "session-end"); out.push(`trace attached to ${issue}`); }
			catch (error) { out.push(`trace not attached to ${issue}: ${(error as Error).message}`); }
		}
	}
	return out;
}

const debug = (lines: string[]) => {
	const log = process.env.HOJA_DEBUG_LOG?.trim();
	if (log && lines.length) try { appendFileSync(log, lines.map(l => `${new Date().toISOString()} [session-end] ${l}\n`).join("")); } catch { /* best effort */ }
};

async function main() {
	if (process.argv[2] === "--finish") {
		// The same credential resolution as the server: userConfig, the environment, then `hoja auth login`.
		applyCredentials();
		let input: EndInput = {};
		try { input = JSON.parse(process.argv[3] ?? "{}"); } catch { /* nothing to finish */ }
		debug(await finishSession(input));
		return;
	}
	applyUserConfig();
	let input: EndInput = {};
	try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* nothing to do */ }
	const { session_id, transcript_path, cwd, reason } = input;
	recordSessionEnd(input);
	if (!session_id) return;
	if (truthy(process.env.HOJA_TRACE_SYNC)) { applyCredentials(); debug(await finishSession(input)); return; }
	// Its own process group, no stdio tied to the hook: the host can end the hook without ending the worker.
	spawn(process.execPath, [process.argv[1], "--finish", JSON.stringify({ session_id, transcript_path, cwd, reason })], { detached: true, stdio: "ignore", env: process.env }).unref();
}
if (process.argv[1] && /trace-hook\.(m?js|ts)$/.test(process.argv[1])) main().catch(error => { process.stderr.write(`[hoja] trace: ${error?.message ?? error}\n`); process.exit(0); });
