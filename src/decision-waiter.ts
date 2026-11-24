/**
 * Claude Code idle delivery (HOJA-799 stage 3): `node dist/decision-wait.mjs`, registered as a command Stop hook with
 * `asyncRewake: true`. Claude Code runs it in the background after every stop; when this session has an open bound
 * decision it chains long-polls until the answer arrives, takes it, and exits 2 with the framed answer on stderr,
 * which wakes the idle session with that text as its next input (verified against Claude Code 2.1.326, see README).
 *
 * It exits 0 at once (nothing to do) when the session has no open bound decision, when another waiter of the same
 * session is already running, or when the session is headless (`claude -p` runs async hooks to completion; the Stop
 * hold and the runner's cold path cover it). It never takes while the Stop hook is holding (that hold delivers in the
 * same turn), and stops without taking once Claude Code itself is gone, so an answer is never consumed by a dead
 * session: the server's cold path then resumes it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMcpUrl } from "./api-proxy.ts";
import { authFetch } from "./credentials.ts";
import { originOf } from "./artifacts.ts";
import { applyCredentials, credentials, dataDir, truthy } from "./env.ts";
import { hostOf } from "./host.ts";
import {
	acquireLock, alive, confirmDelivered, decisionsDir, DecisionStore, newWaiterId, releaseLock, watchDecisions, type DecisionApi,
} from "./decision-wait.ts";
import { resolveHojaToken } from "../vendor/trebol/.pi/lib/claw/hoja.ts";

/** Hoja's decision REST routes with this process's credential (the asker's own), or undefined when unconfigured. */
export function decisionApi(env: NodeJS.ProcessEnv = process.env): DecisionApi | undefined {
	const origin = originOf(resolveMcpUrl(env));
	if (!origin || !(credentials.token() || resolveHojaToken(env))) return undefined;
	const client = hostOf(env) === "claude" ? "claude-code" : hostOf(env);
	return { origin, fetch: authFetch(credentials, fetch as any, () => ({ "x-hoja-actor": "agent", "x-hoja-client": client })) as any };
}

export interface WaiterOptions {
	input: Record<string, any>;
	env?: NodeJS.ProcessEnv;
	dataDir: string;
	api: DecisionApi | undefined;
	maxSeconds?: number;
	harnessPid?: number;
	graceMs?: number;
	write?: (text: string) => void;
	log?: (line: string) => void;
}

/** One background wait. Returns the exit code: 2 with the answer written, 0 otherwise. */
export async function runWaiter(o: WaiterOptions): Promise<number> {
	const env = o.env ?? process.env;
	const sessionId = typeof o.input.session_id === "string" ? o.input.session_id : "";
	const entry = env.CLAUDE_CODE_ENTRYPOINT;
	if (entry && entry !== "cli" && !truthy(env.HOJA_DECISION_REWAKE)) return 0;
	if (!sessionId || !o.api) return 0;
	const store = new DecisionStore(o.dataDir);
	if (!store.open(sessionId).length) return 0;
	const lock = join(decisionsDir(o.dataDir), `${sessionId}.waiter.lock`);
	if (!acquireLock(lock)) return 0;
	const harness = o.harnessPid ?? process.ppid;
	const harnessAlive = () => harness <= 1 || alive(harness);
	const controller = new AbortController();
	const watchdog = setInterval(() => { if (!harnessAlive()) controller.abort(); }, 2000);
	try {
		// Let the Stop hook's synchronous hold (same event, separate process) mark itself first.
		await new Promise(r => setTimeout(r, o.graceMs ?? 1500));
		const out = await watchDecisions({
			api: o.api, store, sessionId, waiterId: newWaiterId("rewake"),
			deadline: Date.now() + (o.maxSeconds ?? 86_340) * 1000, signal: controller.signal, log: o.log,
			mayTake: d => !(d.holdUntil && d.holdUntil > Date.now()) && harnessAlive(),
		});
		if (out.kind !== "answer") return 0;
		await confirmDelivered(o.api, store, out.decision, "rewake", o.log);
		(o.write ?? (t => process.stderr.write(t)))(out.take.text);
		return 2;
	} finally {
		clearInterval(watchdog);
		releaseLock(lock);
	}
}

async function main() {
	applyCredentials();
	let input: Record<string, any> = {};
	try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
	const arg = process.argv.indexOf("--max-seconds");
	const maxSeconds = arg > 0 ? Number(process.argv[arg + 1]) || undefined : undefined;
	const code = await runWaiter({ input, dataDir: dataDir(), api: decisionApi(), maxSeconds });
	process.exit(code);
}
if (process.argv[1] && /decision-wait(?:er)?\.(m?js|ts)$/.test(process.argv[1])) main().catch(() => process.exit(0));
