import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteLocalMedia, runArtifactUpload, uploadFile, writesUserText, type ArtifactClient } from "../src/artifacts.ts";
import { createProxy, type Fetch } from "../src/api-proxy.ts";

/** A Hoja deployment with object storage: begin → presigned PUT → complete. */
function fakeDeployment() {
	const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
	const stored = new Map<string, Buffer>();
	let n = 0;
	const hojaFetch = async (url: string, init: any) => {
		calls.push({ url, ...init });
		const body = init.body ? JSON.parse(init.body) : {};
		if (url.endsWith("/api/uploads/direct")) {
			const id = `blob${++n}`;
			const ext = body.filename.split(".").pop();
			const ctype = ext === "png" ? "image/png" : ext === "mp4" ? "video/mp4" : "application/pdf";
			return { status: 201, text: async () => JSON.stringify({ id, url: `/api/uploads/${id}.${ext}`, contentType: ctype, size: body.size,
				put: { url: `https://bucket.example/${id}.${ext}?sig=1`, method: "PUT", headers: { "Content-Type": ctype } },
				completeUrl: `https://acme.hoja.work/api/uploads/${id}/complete` }) };
		}
		const m = /\/api\/uploads\/(blob\d+)\/complete$/.exec(url);
		if (m) {
			const key = [...stored.keys()].find(k => k.startsWith(m[1]))!;
			return { status: 200, text: async () => JSON.stringify({ id: m[1], url: `/api/uploads/${key}`, absoluteUrl: `https://acme.hoja.work/api/uploads/${key}`,
				contentType: key.endsWith(".png") ? "image/png" : "video/mp4", size: stored.get(key)!.length,
				...(body.issueId ? { attachment: { id: `att-${m[1]}`, title: body.title } } : {}) }) };
		}
		return { status: 404, text: async () => "{}" };
	};
	const plainFetch = async (url: string, init: any) => {
		calls.push({ url, ...init });
		stored.set(new URL(url).pathname.slice(1), Buffer.from(init.body));
		return { status: 200, text: async () => "" };
	};
	const client: ArtifactClient = { origin: "https://acme.hoja.work", hojaFetch, plainFetch };
	return { client, calls, stored };
}

const dir = mkdtempSync(join(tmpdir(), "hoja-artifacts-"));
const shot = join(dir, "shot.png");
writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
const video = join(dir, "demo.mp4");
writeFileSync(video, Buffer.alloc(64, 7));

describe("artifact uploads", () => {
	it("uploads a file by path straight to storage and attaches it", async () => {
		const { client, calls, stored } = fakeDeployment();
		const up = await uploadFile(client, shot, { issue: "HOJA-1", title: "Before" });
		expect(up.absoluteUrl).toBe("https://acme.hoja.work/api/uploads/blob1.png");
		expect(up.markdown).toBe("![Before](https://acme.hoja.work/api/uploads/blob1.png)");
		expect(up.attachmentId).toBe("att-blob1");
		expect(stored.get("blob1.png")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
		const put = calls.find(c => c.method === "PUT")!;
		expect(put.headers).toEqual({ "Content-Type": "image/png" });
		expect(put.headers.authorization).toBeUndefined();
	});

	it("the tool reports per-file results and errors", async () => {
		const { client } = fakeDeployment();
		const res = await runArtifactUpload(client, { paths: [shot, join(dir, "missing.png")], issueId: "HOJA-2" });
		const body = JSON.parse(res.content[0].text);
		expect(body.uploaded).toHaveLength(1);
		expect(body.errors[0]).toContain("no such file");
		expect(res.isError).toBeUndefined();
	});

	it("rewrites existing local media paths in task text, once per file, and leaves other paths alone", async () => {
		const { client, stored } = fakeDeployment();
		const args = {
			issueId: "HOJA-3",
			body: `Screenshot: ${shot}\nAgain ${shot}, recording [demo](${video}), code at /root/src/app.py, gone /tmp/nope-404.png, remote https://x.com/a.png`,
			options: [{ label: "A", mediaUrl: shot }],
		};
		const { args: out, uploaded } = await rewriteLocalMedia(client, args);
		expect(uploaded).toHaveLength(2);
		expect(stored.size).toBe(2);
		expect(out.body).toContain("Screenshot: ![shot.png](https://acme.hoja.work/api/uploads/blob1.png)");
		expect(out.body).toContain("Again ![shot.png](https://acme.hoja.work/api/uploads/blob1.png),");
		expect(out.body).toContain("[demo](https://acme.hoja.work/api/uploads/blob2.mp4)");
		expect(out.body).toContain("/root/src/app.py");
		expect(out.body).toContain("/tmp/nope-404.png");
		expect(out.body).toContain("https://x.com/a.png");
		expect(out.body).not.toContain(shot);
		expect(out.options[0].mediaUrl).toBe("https://acme.hoja.work/api/uploads/blob1.png");
	});

	it("only rewrites tools whose text people read", () => {
		for (const t of ["hoja_commentCreate", "hoja_taskCreate", "hoja_issueUpdate", "hoja_taskReviewRequest", "hoja_taskDecisionCreate"]) expect(writesUserText(t)).toBe(true);
		for (const t of ["hoja_issues", "hoja_task", "hoja_uploadMedia", "hoja_taskDelete"]) expect(writesUserText(t)).toBe(false);
	});

	it("the proxy lists the tool and rewrites a comment before forwarding it", async () => {
		const dep = fakeDeployment();
		const sent: any[] = [];
		const sse = (m: unknown) => `event: message\ndata: ${JSON.stringify(m)}\n\n`;
		const fetchImpl: Fetch = async (url, init) => {
			if (!url.endsWith("/mcp")) return dep.client.hojaFetch(url, init) as any;
			const body = JSON.parse(init.body);
			sent.push(body);
			const reply = (result: unknown) => ({ status: 200, headers: { get: (n: string) => n === "content-type" ? "text/event-stream" : null }, text: async () => sse({ jsonrpc: "2.0", id: body.id, result }) });
			if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18" });
			if (body.method === "notifications/initialized") return { status: 202, headers: { get: () => null }, text: async () => "" };
			if (body.method === "tools/list") return reply({ tools: [{ name: "hoja_commentCreate" }] });
			return reply({ content: [{ type: "text", text: "ok" }] });
		};
		const proxy = createProxy({ HOJA_API_URL: "https://acme.hoja.work/graphql", HOJA_TOKEN: "tok" }, fetchImpl, undefined, undefined, dep.client.plainFetch as any);
		expect((await proxy.handle("tools/list", {})).tools.map((t: any) => t.name)).toEqual(["hoja_artifactUpload", "hoja_decisionWait", "hoja_commentCreate"]);
		const res = await proxy.handle("tools/call", { name: "hoja_commentCreate", arguments: { issueId: "HOJA-4", body: `see ${shot}` } });
		const forwarded = sent.find(b => b.method === "tools/call");
		expect(forwarded.params.arguments.body).toBe("see ![shot.png](https://acme.hoja.work/api/uploads/blob1.png)");
		expect(res.content.at(-1).text).toContain("Uploaded");
		const direct = dep.calls.find(c => c.url.endsWith("/api/uploads/direct"))!;
		expect(direct.headers.authorization).toBe("Bearer tok");
		const tool = await proxy.handle("tools/call", { name: "hoja_artifactUpload", arguments: { paths: [video] } });
		expect(JSON.parse(tool.content[0].text).uploaded[0].contentType).toBe("video/mp4");
	});
});
