import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleAgyHook } from "../src/agy-hook.ts";
import { CHECK_INTERVAL_MS, isNewer, RETRY_AFTER_FAILURE_MS, updateCommand, updateNotice } from "../src/update-check.ts";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ON = { HOJA_PLUGIN_UPDATE_CHECK: "" };

function install(version = "0.5.1", git = false) {
	const root = mkdtempSync(join(tmpdir(), "hoja-update-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version }));
	if (git) mkdirSync(join(root, ".git"));
	return { root, cacheFile: join(root, "data", "update-check.json") };
}

function fakeFetch(answer: () => { ok: boolean; body?: unknown } | Error) {
	const calls: string[] = [];
	const fetch = async (url: string) => {
		calls.push(url);
		const result = answer();
		if (result instanceof Error) throw result;
		return { ok: result.ok, json: async () => result.body };
	};
	return { fetch, calls };
}

describe("update notice", () => {
	it("compares major.minor.patch numerically and never calls garbage newer", () => {
		expect(isNewer("0.5.10", "0.5.9")).toBe(true);
		expect(isNewer("1.0.0", "0.9.9")).toBe(true);
		expect(isNewer("0.5.1", "0.5.1")).toBe(false);
		expect(isNewer("0.5.0", "0.5.1")).toBe(false);
		expect(isNewer("latest", "0.5.1")).toBe(false);
		expect(isNewer(undefined, "0.5.1")).toBe(false);
	});

	it("tells a Claude Code user the exact command when a newer version is published", async () => {
		const { root, cacheFile } = install("0.5.1");
		const { fetch, calls } = fakeFetch(() => ({ ok: true, body: { version: "0.5.2" } }));
		const notice = await updateNotice({ env: ON, root, cacheFile, now: () => NOW, fetch });
		expect(notice).toBe("Hoja plugin 0.5.2 is available (installed: 0.5.1). Update with `claude plugin update hoja@hoja`, then restart Claude Code. To get updates automatically, turn on auto-update for the hoja marketplace in /plugin.");
		expect(calls).toEqual(["https://raw.githubusercontent.com/hoja-work/hoja-claude-plugin/main/package.json"]);
	});

	it("names each host's own repository and update command", async () => {
		const { root, cacheFile } = install("0.5.1", true);
		const { fetch, calls } = fakeFetch(() => ({ ok: true, body: { version: "0.6.0" } }));
		const codex = await updateNotice({ env: { ...ON, HOJA_PLUGIN_HOST: "codex" }, root, cacheFile, now: () => NOW, fetch });
		expect(codex).toContain("`codex plugin marketplace upgrade && codex plugin add hoja@hoja`, then restart Codex.");
		expect(calls[0]).toContain("hoja-work/hoja-codex-plugin");
		expect(updateCommand("antigravity", root)).toBe(`git -C ${JSON.stringify(root)} pull --ff-only`);
		expect(updateCommand("antigravity", install().root)).toBe("git clone --depth 1 https://github.com/hoja-work/hoja-antigravity-plugin hoja-antigravity-plugin && agy plugin install ./hoja-antigravity-plugin");
	});

	it("says nothing when up to date, offline, malformed or turned off", async () => {
		const { root, cacheFile } = install("0.5.1");
		expect(await updateNotice({ env: ON, root, cacheFile, now: () => NOW, fetch: fakeFetch(() => ({ ok: true, body: { version: "0.5.1" } })).fetch })).toBeUndefined();
		const other = install("0.5.1");
		expect(await updateNotice({ env: ON, ...other, now: () => NOW, fetch: fakeFetch(() => new Error("offline")).fetch })).toBeUndefined();
		const third = install("0.5.1");
		expect(await updateNotice({ env: ON, ...third, now: () => NOW, fetch: fakeFetch(() => ({ ok: true, body: { version: "soon" } })).fetch })).toBeUndefined();
		const off = fakeFetch(() => ({ ok: true, body: { version: "9.9.9" } }));
		expect(await updateNotice({ env: { HOJA_PLUGIN_UPDATE_CHECK: "off" }, ...install(), now: () => NOW, fetch: off.fetch })).toBeUndefined();
		expect(off.calls).toEqual([]);
	});

	it("asks GitHub at most once a day, and retries a failure after six hours", async () => {
		const { root, cacheFile } = install("0.5.1");
		let answer: () => { ok: boolean; body?: unknown } | Error = () => ({ ok: true, body: { version: "0.5.2" } });
		const { fetch, calls } = fakeFetch(() => answer());
		await updateNotice({ env: ON, root, cacheFile, now: () => NOW, fetch });
		// Within the day the cached answer is reused, and the notice keeps showing.
		expect(await updateNotice({ env: ON, root, cacheFile, now: () => NOW + CHECK_INTERVAL_MS - 1, fetch })).toContain("0.5.2");
		expect(calls).toHaveLength(1);
		// After a day it asks again; a failure keeps the last known version and is retried after six hours.
		answer = () => new Error("offline");
		const later = NOW + CHECK_INTERVAL_MS;
		expect(await updateNotice({ env: ON, root, cacheFile, now: () => later, fetch })).toContain("0.5.2");
		expect(calls).toHaveLength(2);
		await updateNotice({ env: ON, root, cacheFile, now: () => later + RETRY_AFTER_FAILURE_MS - 1, fetch });
		expect(calls).toHaveLength(2);
		await updateNotice({ env: ON, root, cacheFile, now: () => later + RETRY_AFTER_FAILURE_MS, fetch });
		expect(calls).toHaveLength(3);
		expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toMatchObject({ repo: "hoja-work/hoja-claude-plugin", ok: false, latest: "0.5.2" });
	});

	it("asks the Antigravity agent to relay the notice, since its hooks cannot show it", async () => {
		const { root, cacheFile } = install("0.5.1");
		const dir = mkdtempSync(join(tmpdir(), "hoja-agy-"));
		const env = { ...ON, HOJA_PLUGIN_HOST: "antigravity", HOJA_PLUGIN_DATA: join(dir, "data"), HOJA_PLUGIN_DISABLE_HOJA: "1" };
		const { fetch } = fakeFetch(() => ({ ok: true, body: { version: "0.6.0" } }));
		const out: any = await handleAgyHook("SessionStart", { cascadeId: "c1", workspaceUris: [`file://${dir}`] }, env, { root, cacheFile, now: () => NOW, fetch });
		const text = out.injectSteps[0].systemMessage.systemMessage as string;
		expect(text).toContain("<hoja_plugin_update>");
		expect(text).toContain("Hoja plugin 0.6.0 is available");
		expect(text).toContain("<task_completion_contract>");
	});
});
