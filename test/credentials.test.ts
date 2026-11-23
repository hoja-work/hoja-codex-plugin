import { describe, expect, it } from "vitest";
import { authFetch, Credentials, normalizeEndpoint, type RunCli } from "../src/credentials.ts";
import { createProxy, resolveMcpUrl } from "../src/api-proxy.ts";

const cli = (...answers: (object | Error)[]): RunCli & { calls: number } => {
	const run = Object.assign(((_args: string[]) => {
		const next = answers[Math.min(run.calls++, answers.length - 1)];
		if (next instanceof Error) throw next;
		return JSON.stringify(next);
	}) as RunCli, { calls: 0 });
	return run;
};

describe("endpoint normalisation", () => {
	it("adds https:// to an address typed without a scheme (the 'Failed to parse URL' report)", () => {
		expect(normalizeEndpoint("hoja.hoja.work/mcp")).toEqual({ url: "https://hoja.hoja.work/mcp" });
		expect(resolveMcpUrl({ HOJA_MCP_URL: "acme.hoja.work/mcp" })).toBe("https://acme.hoja.work/mcp");
	});
	it("refuses plain http to a remote host but allows a loopback hoja-serve", () => {
		expect(normalizeEndpoint("http://acme.hoja.work/graphql").problem).toMatch(/plain-http/);
		expect(normalizeEndpoint("http://127.0.0.1:8787/graphql")).toEqual({ url: "http://127.0.0.1:8787/graphql" });
	});
	it("reports garbage instead of throwing", () => {
		expect(normalizeEndpoint("https://").problem).toBeTruthy();
		expect(normalizeEndpoint("")).toEqual({ url: "" });
	});
});

describe("credential sources", () => {
	it("a pasted token wins and the CLI is never run", () => {
		const run = cli(new Error("must not run"));
		const env: Record<string, string | undefined> = { HOJA_TOKEN: "pasted", HOJA_MCP_URL: "acme.hoja.work/mcp" };
		const credentials = new Credentials(env, run).apply();
		expect(credentials.source).toBe("env");
		expect(run.calls).toBe(0);
		expect(env.HOJA_MCP_URL).toBe("https://acme.hoja.work/mcp");
	});
	it("falls back to `hoja auth login` and takes the workspace endpoints from it", () => {
		const env: Record<string, string | undefined> = {};
		const credentials = new Credentials(env, cli({
			access_token: "oauth-1", expires_at: Math.floor(Date.now() / 1000) + 3600,
			api_url: "https://acme.hoja.work/graphql", mcp_url: "https://acme.hoja.work/mcp", workspace: { name: "Acme" },
		})).apply();
		expect(credentials.source).toBe("hoja-cli");
		expect(env).toMatchObject({ HOJA_TOKEN: "oauth-1", HOJA_API_URL: "https://acme.hoja.work/graphql", HOJA_MCP_URL: "https://acme.hoja.work/mcp" });
		expect(credentials.workspace).toBe("Acme");
	});
	it("an explicitly configured endpoint is not overridden by the CLI's", () => {
		const env: Record<string, string | undefined> = { HOJA_MCP_URL: "https://pinned.hoja.work/mcp" };
		new Credentials(env, cli({ access_token: "t", mcp_url: "https://other.hoja.work/mcp" })).apply();
		expect(env.HOJA_MCP_URL).toBe("https://pinned.hoja.work/mcp");
	});
	it("no CLI and no token: source none, nothing invented", () => {
		const env: Record<string, string | undefined> = {};
		expect(new Credentials(env, cli(new Error("ENOENT"))).apply().source).toBe("none");
		expect(env.HOJA_TOKEN).toBeUndefined();
	});
	it("a bad configured URL is dropped and reported, not sent to fetch", () => {
		const env: Record<string, string | undefined> = { HOJA_TOKEN: "t", HOJA_API_URL: "http://evil.example/graphql" };
		const credentials = new Credentials(env, cli()).apply();
		expect(env.HOJA_API_URL).toBeUndefined();
		expect(credentials.problems.join()).toMatch(/HOJA_API_URL/);
	});
	it("refreshes a CLI token that is about to expire before sending it", () => {
		const env: Record<string, string | undefined> = {};
		const run = cli({ access_token: "old", expires_at: Math.floor(Date.now() / 1000) + 10 }, { access_token: "new", expires_at: Math.floor(Date.now() / 1000) + 3600 });
		const credentials = new Credentials(env, run).apply();
		expect(credentials.token()).toBe("new");
	});
});

describe("authFetch", () => {
	it("retries once with a refreshed CLI token after a 401", async () => {
		const env: Record<string, string | undefined> = {};
		const credentials = new Credentials(env, cli({ access_token: "stale" }, { access_token: "fresh" })).apply();
		const seen: string[] = [];
		const fetchImpl = authFetch(credentials, async (_url, init) => {
			seen.push(init.headers.authorization);
			return { status: init.headers.authorization === "Bearer fresh" ? 200 : 401 };
		});
		expect((await fetchImpl("https://acme.hoja.work/mcp", { headers: { Authorization: "Bearer stale" } })).status).toBe(200);
		expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
	});
	it("a pasted key is not retried: a 401 is the answer", async () => {
		const credentials = new Credentials({ HOJA_TOKEN: "pasted" }, cli(new Error("must not run"))).apply();
		let calls = 0;
		const fetchImpl = authFetch(credentials, async () => { calls++; return { status: 401 }; });
		expect((await fetchImpl("https://x/mcp", {})).status).toBe(401);
		expect(calls).toBe(1);
	});
});

describe("proxy with CLI credentials", () => {
	it("fails closed with a sign-in hint when nothing is configured", async () => {
		const credentials = new Credentials({}, cli(new Error("ENOENT"))).apply();
		const proxy = createProxy({ HOJA_MCP_URL: "https://acme.hoja.work/mcp" }, undefined, credentials);
		expect((await proxy.handle("initialize", { protocolVersion: "2025-06-18" })).instructions).toMatch(/hoja auth login/);
	});
});
