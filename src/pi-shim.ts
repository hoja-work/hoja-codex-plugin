/**
 * The Pi ExtensionAPI surface that Trebol's TaskManage and hoja-mode actually use, backed by Claude Code.
 *
 * Trebol's extensions are registered against this object UNCHANGED. Claude Code hook events are translated into the
 * Pi lifecycle events those extensions subscribe to (see hook-bridge.ts), tools registered here are served over MCP
 * (server.ts), and `appendEntry` writes the same custom entries Pi writes into its session file, to a per-session
 * JSONL journal, so state survives restarts, `--resume` and `--continue` exactly as Pi's does.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordActiveSession } from "./trace/touched.ts";
import { TranscriptReader } from "./transcript.ts";

export type Handler = (event: any, ctx: any) => any;
export interface PiTool {
	name: string; label?: string; description: string; parameters: unknown;
	promptSnippet?: string; promptGuidelines?: string[];
	execute(id: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: any): Promise<any> | any;
}
export interface PiCommand { description: string; handler: (args: string, ctx: any) => unknown }
export interface Confirm { (title: string, message: string): Promise<boolean> }

export interface ShimOptions { dataDir: string; cwd: string; confirm?: Confirm; log?: (line: string) => void }

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export class PiShim {
	readonly tools = new Map<string, PiTool>();
	readonly commands = new Map<string, PiCommand>();
	private readonly handlers = new Map<string, Handler[]>();
	private entries: any[] = [];
	private seq = 0;
	readonly transcript = new TranscriptReader();
	sessionId?: string;
	cwd: string;
	/** Messages extensions sent to `ctx.ui.notify`; the hook bridge surfaces them where Claude Code can show them. */
	notifications: { message: string; level: string }[] = [];
	/**
	 * Stable evidence roots for TaskManage: the directory the session started in (and CLAUDE_PROJECT_DIR). `cwd`
	 * follows every hook payload, i.e. wherever the agent's shell last `cd`-ed, and TaskManage resolves citations
	 * against it; without these, valid workspace evidence was rejected as outside_allowed_roots after a `cd` (HOJA-757).
	 * Mutated in place: registerTaskManage keeps this array by reference.
	 */
	readonly evidenceRoots: string[] = [];
	widgets = new Map<string, unknown>();

	constructor(private readonly options: ShimOptions) {
		this.cwd = options.cwd;
		const project = process.env.CLAUDE_PROJECT_DIR?.trim();
		if (project) this.evidenceRoots.push(project);
	}

	/** The object handed to `registerTaskManage(pi, …)` and `registerHojaMode(pi, …)`. */
	readonly api = {
		registerTool: (tool: PiTool) => {
			if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
			this.tools.set(tool.name, tool);
		},
		registerCommand: (name: string, spec: PiCommand) => { this.commands.set(name, spec); },
		registerShortcut: (_shortcut: string, _spec: unknown) => { /* no keyboard shortcuts in Claude Code plugins */ },
		on: (event: string, handler: Handler) => { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); },
		appendEntry: (customType: string, data?: unknown) => this.appendEntry(customType, data),
		sendMessage: (_message: unknown, _options?: unknown) => { /* not used by the ported extensions */ },
	};

	private journalPath(sessionId: string) {
		return join(this.options.dataDir, "sessions", `${SAFE_ID.test(sessionId) ? sessionId : "invalid-session"}.jsonl`);
	}

	appendEntry(customType: string, data?: unknown) {
		const entry = { type: "custom", customType, data: data === undefined ? undefined : structuredClone(data), id: `${Date.now().toString(36)}-${(this.seq++).toString(36)}`, timestamp: new Date().toISOString() };
		this.entries.push(entry);
		if (!this.sessionId) return;
		try {
			mkdirSync(join(this.options.dataDir, "sessions"), { recursive: true, mode: 0o700 });
			appendFileSync(this.journalPath(this.sessionId), JSON.stringify(entry) + "\n", { mode: 0o600 });
		} catch (error) { this.options.log?.(`journal write failed: ${(error as Error).message}`); }
	}

	/** Pi's branch: journaled custom entries, then the session's tool-result messages from the Claude transcript. */
	branch(): readonly unknown[] { return [...this.entries, ...this.transcript.toolResultEntries()]; }

	readonly sessionManager = {
		getEntries: () => this.branch(),
		getBranch: () => this.branch(),
		getSessionId: () => this.sessionId,
	};

	ctx(extra: Record<string, unknown> = {}) {
		const notify = (message: string, level = "info") => { this.notifications.push({ message: String(message), level }); this.options.log?.(`[${level}] ${message}`); };
		return {
			cwd: this.cwd,
			hasUI: !!this.options.confirm,
			sessionManager: this.sessionManager,
			hasPendingMessages: () => false,
			ui: {
				notify,
				setWidget: (key: string, content: unknown) => { if (content === undefined) this.widgets.delete(key); else this.widgets.set(key, content); },
				setStatus: () => {}, requestRender: () => {},
				...(this.options.confirm ? { confirm: this.options.confirm } : {}),
			},
			...extra,
		};
	}

	async emit(event: string, payload: Record<string, unknown> = {}, ctx = this.ctx()): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			try { results.push(await handler({ type: event, ...payload }, ctx)); }
			catch (error) { this.options.log?.(`${event} handler failed: ${(error as Error).message}`); }
		}
		return results;
	}

	/** Pi's tool_result chain: each handler may replace `content`, and the next handler sees the replacement. */
	async emitToolResult(event: { toolName: string; toolCallId: string; input: unknown; content: any[]; details?: unknown; isError: boolean }): Promise<any[]> {
		let content = event.content;
		const ctx = this.ctx();
		for (const handler of this.handlers.get("tool_result") ?? []) {
			try {
				const result = await handler({ type: "tool_result", ...event, content }, ctx);
				if (result && Array.isArray(result.content)) content = result.content;
			} catch (error) { this.options.log?.(`tool_result handler failed: ${(error as Error).message}`); }
		}
		return content;
	}

	/** Bind to a Claude Code session: load its journal and replay Pi's session_start (after session_shutdown of the old one). */
	async bindSession(sessionId: string, transcriptPath?: string, cwd?: string) {
		if (cwd) this.cwd = cwd;
		this.transcript.setPath(transcriptPath);
		if (sessionId) recordActiveSession(this.options.dataDir, sessionId);
		if (sessionId === this.sessionId) return false;
		if (this.sessionId) await this.emit("session_shutdown");
		this.sessionId = sessionId;
		// The first cwd a session binds with is where it started; it stays citable for the whole session.
		if (cwd && !this.evidenceRoots.includes(cwd)) this.evidenceRoots.push(cwd);
		this.entries = [];
		const path = this.journalPath(sessionId);
		if (existsSync(path)) {
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try { this.entries.push(JSON.parse(line)); } catch { /* a torn final line must not hide earlier state */ }
			}
		}
		await this.emit("session_start");
		return true;
	}
}

/** Read a session's journal without a running server (used by the SessionStart command hook). */
export function readJournal(dataDir: string, sessionId: string): any[] {
	if (!SAFE_ID.test(sessionId)) return [];
	const path = join(dataDir, "sessions", `${sessionId}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}
