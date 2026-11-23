/**
 * What a trace may carry. Traces leave the machine (they are uploaded to a Hoja issue), so every preview passes
 * through `scrub` (known credential shapes + the values of secret-looking environment variables) and `clip`.
 */
const PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bsk-ant-[A-Za-z0-9_-]{16,}/g,
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\b(?:hoja|lin)_(?:api|oauth)_[A-Za-z0-9]{16,}/g,
];
/** `Authorization: Bearer x`, `token=x`, `"password": "x"`: the key stays, the value goes. */
const ASSIGNMENTS = /((?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?(?:bearer\s+)?)([^\s"',;&]{8,})/gi;
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

export class Redactor {
	private readonly literals: string[];
	constructor(env: Record<string, string | undefined> = process.env) {
		this.literals = Object.entries(env)
			.filter(([name, value]) => SECRET_ENV.test(name) && typeof value === "string" && value.trim().length >= 8)
			.map(([, value]) => value!.trim())
			.sort((a, b) => b.length - a.length);
	}
	scrub(text: string): string {
		let out = text;
		for (const literal of this.literals) if (out.includes(literal)) out = out.split(literal).join("[redacted]");
		for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
		return out.replace(ASSIGNMENTS, "$1[redacted]");
	}
}

/** Longest single content field a trace keeps (prompts, tool inputs and outputs, responses). Only pathological
 *  outputs reach it; everything else is kept whole and `fitTrace` trims only when the whole trace is too big. */
export const FIELD_CAP = 256_000;

/** Head and tail of a long text with the middle elided: errors and summaries sit at the end of tool output. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6), tail = max - head;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "")}\n… [${omitted} chars omitted] …\n${text.slice(text.length - tail).replace(/^[\uDC00-\uDFFF]/, "")}`;
}

/** At most `max` characters, cut on a character boundary, with the dropped length stated. */
export function clip(text: string, max: number, counted = true): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
	return counted ? `${head}… [+${text.length - head.length} chars]` : `${head.trimEnd()}…`;
}

/** `create Fix flaky test, #3 → completed` */
function taskOps(ops: any[]): string {
	return ops.map(op => op?.op === "create" ? `create ${op.subject ?? ""}`.trim()
		: op?.op === "update" ? `#${op.taskId ?? "?"}${op.status ? ` → ${op.status}` : op.active ? " focus" : " update"}`
		: String(op?.op ?? "")).filter(Boolean).join(", ");
}

/** A compact, readable preview of a tool input: the field that says what the call does first. */
export function inputPreview(tool: string, input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input;
	const i = input as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map(k => i[k]).find(v => typeof v === "string" && v) as string | undefined;
	const lead = tool === "Bash" ? pick("command")
		: /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) ? pick("file_path", "notebook_path")
		: /^(Grep|Glob)$/.test(tool) ? [pick("pattern"), pick("path")].filter(Boolean).join("  in ")
		: /^(WebFetch|WebSearch)$/.test(tool) ? pick("url", "query")
		: tool === "Agent" || tool === "Task" ? pick("description", "prompt")
		: tool === "TaskManage" && Array.isArray(i.operations) ? taskOps(i.operations)
		: pick("action", "query", "identifier", "issue", "subject", "description", "url", "name", "command", "path");
	if (lead) return lead;
	const pairs = Object.entries(i).filter(([, v]) => v !== null && ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : v}`);
	if (pairs.length) return pairs.join(" ");
	try { return JSON.stringify(input); } catch { return String(input); }
}

/** One short label for a span: `Bash · npm test`, `Edit · src/app.ts`. */
export function toolLabel(tool: string, input: unknown): string {
	const preview = inputPreview(tool, input).split("\n")[0];
	return preview && preview !== "{}" ? `${tool} · ${clip(preview, 100, false)}` : tool;
}
