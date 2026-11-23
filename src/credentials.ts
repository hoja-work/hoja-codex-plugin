/**
 * Where the plugin's Hoja credential comes from, and keeping it usable.
 *
 * Two sources, in order:
 *   1. the environment (HOJA_TOKEN / HOJA_API_URL / HOJA_MCP_URL, or the plugin's userConfig mapped onto them):
 *      a personal API key the person pasted. Used as is.
 *   2. the Hoja CLI's own sign-in (`hoja auth login`): `hoja auth token --json` prints a fresh OAuth access token
 *      and the workspace's endpoints. Nothing to paste, and the token is refreshed by the CLI, so a long session
 *      asks again on expiry or on a 401 instead of failing until restart.
 *
 * Endpoints are normalised once here: a value typed without a scheme (`acme.hoja.work/mcp`) used to reach `fetch`
 * verbatim and fail with "Failed to parse URL". It now gains https://. Plain http is refused except for a loopback
 * hoja-serve, so a token is never sent in clear text to a remote host.
 */
import { execFileSync } from "node:child_process";

type Env = Record<string, string | undefined>;
export type RunCli = (args: string[]) => string;

const URL_VARS = ["HOJA_API_URL", "LINEAR_API_URL", "HOJA_MCP_URL"] as const;
const TOKEN_VARS = ["HOJA_TOKEN", "LINEAR_TOKEN"] as const;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The endpoint with a scheme, or a reason it cannot be used. Never throws. */
export function normalizeEndpoint(raw: string | undefined): { url: string; problem?: string } {
	const value = raw?.trim() ?? "";
	if (!value) return { url: "" };
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
	let parsed: URL;
	try { parsed = new URL(candidate); } catch { return { url: "", problem: `"${value}" is not a URL. Use the full address, e.g. https://acme.hoja.work/mcp.` }; }
	if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
		return { url: "", problem: `Refusing plain-http endpoint ${parsed.host}: Hoja tokens are only sent over https (loopback excepted).` };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { url: "", problem: `Unsupported scheme in "${value}".` };
	return { url: parsed.toString() };
}

export const defaultRunCli: RunCli = args => execFileSync("hoja", args, {
	encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
});

export type CliCredential = { access_token: string; expires_at?: string | number; api_url?: string; mcp_url?: string; workspace?: { name?: string; origin?: string } };

/** `hoja auth token --json`, or undefined when the CLI is absent, signed out, or prints something else. */
export function readCliCredential(run: RunCli = defaultRunCli): CliCredential | undefined {
	try {
		const parsed = JSON.parse(run(["auth", "token", "--json"]));
		return typeof parsed?.access_token === "string" && parsed.access_token ? parsed : undefined;
	} catch { return undefined; }
}

/**
 * The credential the plugin will use, applied to `env` so the vendored client (which reads process.env) sees it.
 * Returns the problems found, for the setup report. Idempotent.
 */
export class Credentials {
	source: "env" | "hoja-cli" | "none" = "none";
	problems: string[] = [];
	workspace?: string;
	private expiresAt = 0;

	constructor(private readonly env: Env = process.env, private readonly run: RunCli = defaultRunCli) {}

	apply(): this {
		this.problems = [];
		for (const name of URL_VARS) {
			if (!this.env[name]?.trim()) continue;
			const { url, problem } = normalizeEndpoint(this.env[name]);
			if (problem) { this.problems.push(`${name}: ${problem}`); delete this.env[name]; } else this.env[name] = url;
		}
		if (TOKEN_VARS.some(name => this.env[name]?.trim())) { this.source = "env"; return this; }
		this.fromCli();
		return this;
	}

	/** The token to send now; refreshes a CLI token that is about to expire. */
	token(): string {
		if (this.source === "hoja-cli" && this.expiresAt && Date.now() > this.expiresAt - 60_000) this.fromCli();
		return this.env.HOJA_TOKEN?.trim() || this.env.LINEAR_TOKEN?.trim() || "";
	}

	/** After a 401: a pasted key cannot be refreshed; a CLI sign-in can. True when a new token was obtained. */
	refresh(): boolean {
		if (this.source !== "hoja-cli") return false;
		const before = this.env.HOJA_TOKEN;
		this.fromCli();
		return this.source === "hoja-cli" && this.env.HOJA_TOKEN !== before;
	}

	private fromCli() {
		const credential = readCliCredential(this.run);
		if (!credential) {
			if (this.source === "hoja-cli") delete this.env.HOJA_TOKEN;
			this.source = "none";
			return;
		}
		this.source = "hoja-cli";
		this.env.HOJA_TOKEN = credential.access_token;
		this.workspace = credential.workspace?.name || credential.workspace?.origin;
		const expires = typeof credential.expires_at === "number" ? credential.expires_at * 1000 : Date.parse(credential.expires_at ?? "");
		this.expiresAt = Number.isFinite(expires) ? expires : 0;
		// The signed-in workspace decides the endpoints unless the person pinned them explicitly.
		for (const [name, value] of [["HOJA_API_URL", credential.api_url], ["HOJA_MCP_URL", credential.mcp_url]] as const) {
			if (this.env[name]?.trim() || !value) continue;
			const { url } = normalizeEndpoint(value);
			if (url) this.env[name] = url;
		}
	}
}

type FetchLike = (url: string, init: any) => Promise<any>;
/**
 * A fetch that always sends the current token, and on a 401 refreshes a CLI sign-in once and retries.
 * Used for both the GraphQL client and the MCP proxy, so neither holds a token that silently goes stale.
 */
export function authFetch(
	credentials: Credentials,
	base: FetchLike = fetch as any,
	extraHeaders?: () => Record<string, string | undefined>,
): FetchLike {
	const withToken = (init: any) => {
		const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
		const token = credentials.token();
		if (token) {
			for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
			headers.authorization = `Bearer ${token}`;
		}
		if (!Object.keys(headers).some(k => k.toLowerCase() === "x-hoja-actor")) headers["x-hoja-actor"] = "agent";
		if (extraHeaders) {
			for (const [k, v] of Object.entries(extraHeaders())) {
				if (v && !Object.keys(headers).some(existing => existing.toLowerCase() === k.toLowerCase())) headers[k] = v;
			}
		}
		return { ...init, headers };
	};
	return async (url, init) => {
		const response = await base(url, withToken(init));
		if (response?.status !== 401 || !credentials.refresh()) return response;
		return base(url, withToken(init));
	};
}

export const SIGN_IN_HINT = "Run `hoja auth login <your-workspace>` in a terminal (recommended), or set HOJA_TOKEN and HOJA_API_URL.";
