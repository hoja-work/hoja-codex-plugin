/**
 * SessionStart command hook. Claude Code fires SessionStart before plugin MCP servers connect, so this runs the same
 * registrations in a short-lived process and prints what Pi appends to the system prompt at `before_agent_start`:
 *  - extensions/taskmanage/extension.ts  <task_completion_contract> (extracted at build time from the vendored file)
 *  - the TaskManage tool's promptSnippet + promptGuidelines (registerTaskManage)
 *  - extensions/hoja-mode/extension.ts   HOJA_RULE + project guidance, only while this chat's Hoja mode is on
 */
import { readFileSync } from "node:fs";
import { createRuntime } from "./runtime.ts";
import { applyCredentials, dataDir } from "./env.ts";
import { TASK_COMPLETION_CONTRACT } from "./generated/contract.ts";

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
	const additionalContext = await sessionContext(input);
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
}
if (process.argv[1] && /session-start\.(m?js|ts)$/.test(process.argv[1])) main().catch(error => { process.stderr.write(String(error?.stack ?? error)); process.exit(1); });
