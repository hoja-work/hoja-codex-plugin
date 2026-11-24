/**
 * Artifacts an agent produces (screenshots, screen recordings, PDFs) become real Hoja uploads, never local paths
 * (HOJA-798). Production had 62 issue references to `/tmp/x.png`, `/root/.../ux-sweep/*.png` and friends: they only
 * ever opened on the machine that wrote them, and every one rotted. Two things here stop that:
 *
 * 1. `hoja_artifactUpload`: one call uploads local files by path (bytes go straight to object storage through the
 *    server's direct-upload flow: begin → PUT → complete), optionally attaches them to a task, and returns a
 *    shareable URL plus Markdown to paste.
 * 2. `rewriteLocalMedia`: before a write tool (comment, task create/update, review request, decision) reaches Hoja,
 *    any existing local media file the text mentions is uploaded and the path is replaced with its Hoja URL. An agent
 *    that forgets (1) still cannot publish a dead link.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

type Json = Record<string, any>;
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: any; signal?: AbortSignal }) =>
	Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;

export const MEDIA_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "pdf"];
const MEDIA_RE = new RegExp(
	String.raw`(?<![\w/:.~-])(?:file://)?(?:~/|/|\./|\.\./)?(?:[\w@%+=,.-]+/)*[\w@%+=,.-]+\.(?:${MEDIA_EXTENSIONS.join("|")})(?![\w/])`,
	"gi",
);

export interface Uploaded { path: string; url: string; absoluteUrl: string; contentType: string; size: number; title: string; markdown: string; attachmentId?: string }

export interface ArtifactClient {
	/** The deployment origin, e.g. https://acme.hoja.work */
	origin: string;
	/** Authenticated fetch for Hoja's own routes (adds the Bearer token, refreshes on 401). */
	hojaFetch: HttpFetch;
	/** Unauthenticated fetch for the presigned storage PUT. */
	plainFetch: HttpFetch;
	cwd?: string;
}

export function originOf(graphqlUrl: string): string {
	try { return new URL(graphqlUrl).origin; } catch { return ""; }
}

export function resolveLocalPath(raw: string, cwd = process.cwd()): string {
	let p = raw.startsWith("file://") ? decodeURIComponent(raw.slice("file://".length)) : raw;
	if (p.startsWith("~/")) p = homedir() + p.slice(1);
	return isAbsolute(p) ? p : resolve(cwd, p);
}

async function json(res: { status: number; text(): Promise<string> }, what: string): Promise<Json> {
	const text = await res.text();
	let body: Json = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
	if (res.status >= 400) throw new Error(`${what} failed (HTTP ${res.status}): ${body.error ?? text.slice(0, 200)}`);
	return body;
}

/** Upload one local file through begin → PUT → complete. */
export async function uploadFile(client: ArtifactClient, rawPath: string, opts: { issue?: string; title?: string; ttlDays?: number } = {}): Promise<Uploaded> {
	const path = resolveLocalPath(rawPath, client.cwd);
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${rawPath}: no such file`);
	const bytes = readFileSync(path);
	const filename = basename(path);
	const begin = await json(await client.hojaFetch(`${client.origin}/api/uploads/direct`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ filename, size: bytes.length, ...(opts.ttlDays ? { ttlDays: opts.ttlDays } : {}) }),
	}), `upload ${filename}`);
	const put = begin.put ?? {};
	const sender = put.auth ? client.hojaFetch : client.plainFetch;
	const sent = await sender(put.url, { method: "PUT", headers: { ...(put.headers ?? {}) }, body: bytes });
	if (sent.status >= 300) throw new Error(`upload ${filename}: storage refused the bytes (HTTP ${sent.status})`);
	const title = opts.title?.trim() || filename;
	const done = await json(await client.hojaFetch(begin.completeUrl ?? `${client.origin}/api/uploads/${begin.id}/complete`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify(opts.issue ? { issueId: opts.issue, title } : {}),
	}), `complete ${filename}`);
	const absoluteUrl = done.absoluteUrl ?? `${client.origin}${done.url}`;
	const contentType = String(done.contentType ?? begin.contentType ?? "");
	const markdown = contentType.startsWith("image/") ? `![${title}](${absoluteUrl})` : `[${title}](${absoluteUrl})`;
	return { path, url: done.url, absoluteUrl, contentType, size: Number(done.size ?? bytes.length), title, markdown, attachmentId: done.attachment?.id };
}

export const ARTIFACT_UPLOAD_TOOL = {
	name: "hoja_artifactUpload",
	description:
		"Upload local files (screenshots, screen recordings, PDFs, any artifact you produced) to Hoja and optionally attach them to a task. "
		+ "Pass paths (absolute or relative to the project). Bytes go straight to Hoja storage (up to 512 MB each, no base64). "
		+ "Returns each file's shareable URL and Markdown to paste into comments, descriptions or decision options (mediaUrl). "
		+ "Never put a local path (/tmp/..., /root/..., file://) in a task: it only opens on this machine. "
		+ "For many variants (e.g. 15 design options), upload them all here, then ask with hoja_taskDecisionCreate using each URL as an option's mediaUrl.",
	inputSchema: {
		type: "object",
		properties: {
			paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "Local file paths to upload." },
			issueId: { type: "string", description: "Task identifier (e.g. HOJA-123) to attach each file to." },
			titles: { type: "array", items: { type: "string" }, description: "Optional titles, same order as paths." },
			ttlDays: { type: "integer", minimum: 1, maximum: 365, description: "Delete the files after this many days." },
		},
		required: ["paths"],
	},
};

export async function runArtifactUpload(client: ArtifactClient, args: Json): Promise<Json> {
	const paths: string[] = Array.isArray(args?.paths) ? args.paths.map(String) : typeof args?.path === "string" ? [args.path] : [];
	if (!paths.length) return { content: [{ type: "text", text: "hoja_artifactUpload: pass paths: [\"/path/to/file.png\"]" }], isError: true };
	const results: Json[] = [];
	const errors: string[] = [];
	for (const [i, p] of paths.entries()) {
		try {
			const up = await uploadFile(client, p, { issue: args.issueId, title: args.titles?.[i], ttlDays: args.ttlDays });
			results.push({ path: p, url: up.url, absoluteUrl: up.absoluteUrl, contentType: up.contentType, size: up.size, markdown: up.markdown, ...(up.attachmentId ? { attachmentId: up.attachmentId } : {}) });
		} catch (error) { errors.push((error as Error).message); }
	}
	const text = JSON.stringify({ uploaded: results, ...(errors.length ? { errors } : {}) }, null, 1);
	return { content: [{ type: "text", text }], ...(results.length ? {} : { isError: true }) };
}

/** Tools whose text a person reads in Hoja: local media paths in them are uploaded and replaced. */
export function writesUserText(tool: string): boolean {
	return /^hoja_(?:issue|task)(?:Create|Update|ReviewRequest|DecisionCreate)$|^hoja_comment(?:Create|Update)$|^hoja_projectUpdateCreate$|^hoja_knowledgeDoc(?:Create|Update)$/.test(tool);
}

function issueOf(args: Json): string | undefined {
	const v = args?.issueId ?? args?.input?.issueId ?? args?.id;
	return typeof v === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+/.test(v) ? v : undefined;
}

/**
 * Replace local media paths in every string of `args` with Hoja URLs, uploading each existing file once.
 * Paths that do not exist are left alone (they may be code or prose), so this never invents a link.
 */
export async function rewriteLocalMedia(client: ArtifactClient, args: Json): Promise<{ args: Json; uploaded: Uploaded[]; errors: string[] }> {
	const cache = new Map<string, Uploaded | null>();
	const uploaded: Uploaded[] = [];
	const errors: string[] = [];
	const issue = issueOf(args);
	const rewrite = async (text: string): Promise<string> => {
		const matches = [...text.matchAll(MEDIA_RE)].map(m => m[0]);
		if (!matches.length) return text;
		let out = text;
		for (const raw of new Set(matches)) {
			const path = resolveLocalPath(raw, client.cwd);
			if (!cache.has(path)) {
				let up: Uploaded | null = null;
				if (existsSync(path) && statSync(path).isFile()) {
					try { up = await uploadFile(client, raw, { issue }); uploaded.push(up); }
					catch (error) { errors.push((error as Error).message); }
				}
				cache.set(path, up);
			}
			const up = cache.get(path);
			if (!up) continue;
			// A field that is only a path (mediaUrl, url) becomes only the URL.
			if (text.trim() === raw) return up.absoluteUrl;
			// Inside Markdown link/image syntax the URL replaces the target; bare prose gets Markdown.
			out = out.split(`](${raw})`).join(`](${up.absoluteUrl})`);
			out = out.replace(new RegExp(`(?<![\\w/:.~(-])${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`, "g"), up.markdown);
		}
		return out;
	};
	const walk = async (value: any): Promise<any> => {
		if (typeof value === "string") return rewrite(value);
		if (Array.isArray(value)) return Promise.all(value.map(walk));
		if (value && typeof value === "object") {
			const out: Json = {};
			for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
			return out;
		}
		return value;
	};
	return { args: await walk(args), uploaded, errors };
}
