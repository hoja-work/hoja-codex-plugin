/**
 * How an Antigravity command hook reaches the plugin's MCP server.
 *
 * Claude Code and Codex call the server's `__hoja_hook` tool from the hook itself (`mcp_tool` hooks), so hooks and
 * tools share one process and one memory. Antigravity only runs command hooks. Its MCP server and every hook it runs
 * are children of the same `agy` process (probed: the server's ppid and each hook shell's ppid are that pid), so the
 * server listens on a Unix socket named after its parent pid, and the hook walks its own ancestry until it finds one.
 * The directory is per user and 0700; nothing is reachable by another account.
 */
import { createConnection, createServer, type Server } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uid = () => (typeof process.getuid === "function" ? process.getuid() : "user");
export const socketDir = (env: NodeJS.ProcessEnv = process.env) => env.HOJA_AGY_SOCKET_DIR?.trim() || join(tmpdir(), `hoja-agy-${uid()}`);
export const socketPath = (agyPid: number, env: NodeJS.ProcessEnv = process.env) => join(socketDir(env), `${agyPid}.sock`);

/** Parent pid of `pid`: /proc on Linux, `ps` elsewhere. */
export function parentOf(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
	} catch { /* not Linux */ }
	try {
		const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim());
		return Number.isFinite(ppid) && ppid > 0 ? ppid : undefined;
	} catch { return undefined; }
}

/** The socket of the nearest ancestor that serves one (the `agy` process), or undefined. */
export function findSocket(env: NodeJS.ProcessEnv = process.env, start = process.ppid, parent = parentOf): string | undefined {
	if (env.HOJA_AGY_SOCKET?.trim()) return env.HOJA_AGY_SOCKET.trim();
	let pid: number | undefined = start;
	for (let depth = 0; pid && pid > 1 && depth < 8; depth++) {
		const path = socketPath(pid, env);
		if (existsSync(path)) return path;
		pid = parent(pid);
	}
	return undefined;
}

/** Server side: one JSON line in, one JSON line out, per connection. */
export function listen(path: string, handle: (message: any) => Promise<unknown>, log?: (line: string) => void): Server {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	try { chmodSync(join(path, ".."), 0o700); } catch { /* best effort */ }
	try { unlinkSync(path); } catch { /* not there */ }
	const server = createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", async chunk => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const line = buffer.slice(0, end);
			buffer = "";
			let reply: unknown;
			try { reply = await handle(JSON.parse(line)); }
			catch (error) { log?.(`agy hook failed: ${(error as Error).message}`); reply = { error: (error as Error).message }; }
			socket.end(JSON.stringify(reply ?? {}) + "\n");
		});
		socket.on("error", () => { /* the hook gave up; nothing to do */ });
	});
	server.listen(path, () => { try { chmodSync(path, 0o600); } catch { /* best effort */ } });
	const cleanup = () => { try { unlinkSync(path); } catch { /* gone */ } };
	process.once("exit", cleanup);
	return server;
}

/** Client side: send one message, wait for one reply, or reject after `timeoutMs`. */
export function request(path: string, message: unknown, timeoutMs = 20_000): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let data = "";
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("timed out")); }, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
		socket.on("data", chunk => { data += chunk; });
		socket.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
		socket.on("error", error => { clearTimeout(timer); reject(error); });
	});
}
