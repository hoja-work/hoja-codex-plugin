/**
 * SessionStart command hook. Claude Code fires SessionStart before plugin MCP servers connect, so this runs the same
 * registrations in a short-lived process and prints what Pi appends to the system prompt at `before_agent_start`:
 *  - extensions/taskmanage/extension.ts  <task_completion_contract> (extracted at build time from the vendored file)
 *  - the TaskManage tool's promptSnippet + promptGuidelines (registerTaskManage)
 *  - extensions/hoja-mode/extension.ts   HOJA_RULE + project guidance, only while this chat's Hoja mode is on
 */
import { readFileSync } from "node:fs";
import { createRuntime } from "./runtime.ts";
import { applyCredentials, dataDir, traceDetail } from "./env.ts";
import { TraceRecorder } from "./trace/recorder.ts";
import { TASK_COMPLETION_CONTRACT } from "./generated/contract.ts";
import { updateNotice } from "./update-check.ts";

export async function sessionContext(input: { session_id?: string; transcript_path?: string; cwd?: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const { shim } = createRuntime({ dataDir: dataDir(env), cwd: input.cwd || process.cwd(), hoja: !/^(1|true)$/i.test(env.HOJA_PLUGIN_DISABLE_HOJA ?? "") });
	if (input.session_id) await shim.bindSession(input.session_id, input.transcript_path, input.cwd);
	const tool = shim.tools.get("TaskManage");
	let systemPrompt = "";
	for (const result of await shim.emit("before_agent_start", { systemPrompt: "", prompt: "" }))
		if (result && typeof result.systemPrompt === "string") systemPrompt += result.systemPrompt;
	return [
		tool?.promptSnippet ?? "",
		...(tool?.promptGuidelines ?? []).map(line => `- ${line}`),
		TASK_COMPLETION_CONTRACT,
		systemPrompt.trim(),
	].filter(Boolean).join("\n");
}

async function main() {
	applyCredentials();
	let input: any = {};
	try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin: still emit the static context */ }
	// SessionStart at launch reaches no MCP server (mcp_tool hooks are skipped then), so it is recorded here.
	new TraceRecorder({ dataDir: dataDir(), detail: traceDetail() }).record(input.session_id, "SessionStart", input);
	// The update check runs alongside the context build; it is bounded (one cached request a day, 1.5 s timeout).
	const [additionalContext, notice] = await Promise.all([sessionContext(input), updateNotice()]);
	// `systemMessage` is shown to the user (Claude Code and Codex), never added to the model's context.
	process.stdout.write(JSON.stringify({ ...(notice ? { systemMessage: notice } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}
if (process.argv[1] && /session-start\.(m?js|ts)$/.test(process.argv[1])) main().catch(error => { process.stderr.write(String(error?.stack ?? error)); process.exit(1); });
