/**
 * "A newer Hoja plugin is available" notice, shown once per session start.
 *
 * No host updates a plugin by itself unless told to (Claude Code only with marketplace auto-update on; Codex and
 * Antigravity never), so a user on an old version would never learn a new one exists. The SessionStart hook asks
 * this module for a one-line notice and shows it to the user (Claude Code and Codex: the hook's `systemMessage`;
 * Antigravity, which has no user-facing hook output: an injected note the agent relays).
 *
 * Bounded by design:
 *   - at most one network request a day (six hours after a failure), cached in the plugin's data directory;
 *   - the request is a plain GET of the public repository's package.json, carrying nothing about the user;
 *   - a short timeout, and every failure is silent: offline, rate-limited or malformed means "no notice";
 *   - `HOJA_PLUGIN_UPDATE_CHECK=off` turns it off.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf, type Host } from "./host.ts";
import { dataDir } from "./env.ts";

export const REPOS: Readonly<Record<Host, string>> = {
	claude: "hoja-work/hoja-claude-plugin",
	codex: "hoja-work/hoja-codex-plugin",
	antigravity: "hoja-work/hoja-antigravity-plugin",
};
const HOST_NAMES: Readonly<Record<Host, string>> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 1500;

type Cache = { repo: string; checkedAt: string; ok: boolean; latest?: string };
type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type UpdateDeps = {
	env?: NodeJS.ProcessEnv;
	/** The plugin's install root (the folder holding package.json and dist/). */
	root?: string;
	cacheFile?: string;
	now?: () => number;
	fetch?: Fetch;
};

/** dist/<entry>.mjs (bundled) or src/<file>.ts (tests) → the plugin root one level up. */
export const pluginRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function installedVersion(root: string): string | undefined {
	try {
		const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.version;
		return typeof version === "string" ? version : undefined;
	} catch { return undefined; }
}

const parts = (version: string): number[] | undefined => {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return match ? match.slice(1, 4).map(Number) : undefined;
};

/** True when `candidate` is a strictly higher major.minor.patch than `current`; anything unparseable is not newer. */
export function isNewer(candidate: string | undefined, current: string | undefined): boolean {
	const a = candidate ? parts(candidate) : undefined;
	const b = current ? parts(current) : undefined;
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

function readCache(file: string): Cache | undefined {
	try { return JSON.parse(readFileSync(file, "utf8")) as Cache; } catch { return undefined; }
}

function writeCache(file: string, cache: Cache): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(cache) + "\n");
	} catch { /* a read-only data dir only costs a request per session */ }
}

/** The latest published version, from the cache when it is fresh, else one bounded request. */
export async function latestVersion(repo: string, cacheFile: string, now: number, fetchImpl: Fetch): Promise<string | undefined> {
	const cached = readCache(cacheFile);
	if (cached?.repo === repo) {
		const age = now - Date.parse(cached.checkedAt);
		if (age >= 0 && age < (cached.ok ? CHECK_INTERVAL_MS : RETRY_AFTER_FAILURE_MS)) return cached.latest;
	}
	let latest: string | undefined;
	try {
		const response = await fetchImpl(`https://raw.githubusercontent.com/${repo}/main/package.json`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: "application/json" },
		});
		const version = response.ok ? (await response.json() as any)?.version : undefined;
		if (typeof version === "string" && parts(version)) latest = version;
	} catch { /* offline or slow: silent */ }
	const keep = cached?.repo === repo ? cached.latest : undefined;
	writeCache(cacheFile, { repo, checkedAt: new Date(now).toISOString(), ok: !!latest, ...(latest ?? keep ? { latest: latest ?? keep } : {}) });
	return latest ?? keep;
}

/** The exact command that updates this install on its host. */
export function updateCommand(host: Host, root: string): string {
	if (host === "codex") return "codex plugin marketplace upgrade && codex plugin add hoja@hoja";
	if (host === "antigravity")
		// `agy plugin install` takes a directory only; an install that kept its .git (the usual case) just pulls.
		return existsSync(join(root, ".git"))
			? `git -C ${JSON.stringify(root)} pull --ff-only`
			: `git clone --depth 1 https://github.com/${REPOS.antigravity} hoja-antigravity-plugin && agy plugin install ./hoja-antigravity-plugin`;
	return "claude plugin update hoja@hoja";
}

/** One line for the user when a newer plugin is published, else undefined. Never throws. */
export async function updateNotice(deps: UpdateDeps = {}): Promise<string | undefined> {
	const env = deps.env ?? process.env;
	if (/^(0|false|off|no)$/i.test(env.HOJA_PLUGIN_UPDATE_CHECK?.trim() ?? "")) return undefined;
	try {
		const host = hostOf(env);
		const root = deps.root ?? pluginRoot();
		const current = installedVersion(root);
		if (!current) return undefined;
		const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as Fetch);
		if (typeof fetchImpl !== "function") return undefined;
		const latest = await latestVersion(REPOS[host], deps.cacheFile ?? join(dataDir(env), "update-check.json"), (deps.now ?? Date.now)(), fetchImpl);
		if (!isNewer(latest, current)) return undefined;
		const tail = host === "claude" ? " To get updates automatically, turn on auto-update for the hoja marketplace in /plugin." : "";
		return `Hoja plugin ${latest} is available (installed: ${current}). Update with \`${updateCommand(host, root)}\`, then restart ${HOST_NAMES[host]}.${tail}`;
	} catch {
		return undefined;
	}
}
