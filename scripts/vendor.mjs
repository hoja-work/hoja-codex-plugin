#!/usr/bin/env node
// Copies Trebol's TaskManage engine, Swarm builtin hooks and hoja-mode into vendor/trebol/<same path>, byte for byte,
// and records each file's SHA-256 plus the source commit in vendor/MANIFEST.json.
//   TREBOL_ROOT=~/src/trebol node scripts/vendor.mjs   re-vendor from a Trebol checkout
//   node scripts/vendor.mjs --check                     fail if any vendored file differs from its manifest hash (and,
//                                                       with TREBOL_ROOT set, from the source file itself)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.TREBOL_ROOT?.trim() ? resolve(process.env.TREBOL_ROOT.trim()) : undefined;
const vendor = join(plugin, "vendor", "trebol");
const manifestPath = join(plugin, "vendor", "MANIFEST.json");

/** Runtime closure: bundled into dist/. Computed from the import graph of the three entry points below. */
export const RUNTIME = [
	"packages/tools/taskmanage/src/task-manage.ts",
	"packages/tools/taskmanage/src/swarm-validate.ts",
	"packages/tools/taskmanage/src/persistence.ts",
	"packages/tools/taskmanage/src/task-hooks.ts",
	".pi/lib/runtime/swarm-builtin-hooks.ts",
	".pi/lib/runtime/swarm-toolclass.ts",
	".pi/lib/runtime/task-gate-resume.ts",
	".pi/lib/runtime/swarm-stdin-conflict.ts",
	".pi/lib/runtime/mode-footer.ts",
	".pi/lib/runtime/session-mode-entry.ts",
	".pi/lib/runtime/tool-contract.ts",
	".pi/lib/policy/swarm-annoyance-nudge.ts",
	".pi/lib/policy/swarm-sleep-blocker.ts",
	".pi/lib/claw/hoja.ts",
	".pi/lib/tools/swarm-hoja.contract.ts",
	"extensions/hoja-mode/extension.ts",
	"extensions/hoja-mode/lifecycle.ts",
	"extensions/hoja-mode/project.ts",
	"extensions/hoja-mode/projects.ts",
	"extensions/hoja-mode/publish.ts",
];
/** Kept for provenance and parity tests only; never bundled. extension.ts is the source of the completion contract. */
export const REFERENCE = [
	"extensions/taskmanage/extension.ts",
	"packages/tools/taskmanage/src/swarm-hook-runtime.ts",
	"packages/tools/taskmanage/src/workflow.ts",
	"packages/tools/taskmanage/src/interaction.ts",
	"packages/tools/taskmanage/src/index.ts",
	"packages/context/autogenskills/src/index.ts",
	"packages/context/autogenskills/src/swarm-render.ts",
];
/** Trebol's own test suites whose import closure lies entirely inside the vendored set; they run unmodified. */
export const TESTS = [
	".pi/test/claw/hoja-credentials.test.ts",
	".pi/test/claw/hoja-endpoint.test.ts",
	".pi/test/policy/swarm-annoyance-nudge.test.ts",
	".pi/test/policy/swarm-sleep-blocker.test.ts",
	".pi/test/runtime/swarm-builtin-hooks.test.ts",
	".pi/test/runtime/swarm-stdin-conflict.test.ts",
	".pi/test/tools/hoja-config.test.ts",
	".pi/test/tools/hoja-lifecycle.test.ts",
	".pi/test/tools/hoja-mode-restore.test.ts",
	".pi/test/tools/hoja-mode.test.ts",
	".pi/test/tools/hoja-project.test.ts",
	".pi/test/tools/hoja-projects.test.ts",
	".pi/test/tools/hoja-publish.test.ts",
	".pi/test/tools/hoja-recovery-cache.test.ts",
	".pi/test/tools/hoja-recovery.test.ts",
	"packages/tools/taskmanage/test/call-label.test.ts",
	"packages/tools/taskmanage/test/evidence-diagnostics.test.ts",
	"packages/tools/taskmanage/test/evidence-regressions.test.ts",
	"packages/tools/taskmanage/test/persistence.test.ts",
	"packages/tools/taskmanage/test/questions.test.ts",
	"packages/tools/taskmanage/test/review-regressions.test.ts",
	"packages/tools/taskmanage/test/swarm-hook-runtime.test.ts",
	"packages/tools/taskmanage/test/task-hooks.test.ts",
	"packages/tools/taskmanage/test/task-manage.test.ts",
	"packages/tools/taskmanage/test/workflow.test.ts",
	"tests/setup/isolate-state.ts",
];
const ALL = [...RUNTIME, ...REFERENCE, ...TESTS];
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

if (process.argv.includes("--check")) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const problems = [];
	for (const rel of ALL) {
		const vendored = join(vendor, rel);
		if (!existsSync(vendored)) { problems.push(`missing ${rel}`); continue; }
		const hash = sha(vendored);
		if (manifest.files[rel] !== hash) problems.push(`modified ${rel} (manifest ${manifest.files[rel]?.slice(0, 12)}, now ${hash.slice(0, 12)})`);
		const original = source && join(source, rel);
		if (original && existsSync(original) && sha(original) !== hash) problems.push(`drifted from source ${rel}`);
	}
	if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
	console.log(`vendor ok: ${ALL.length} files match MANIFEST.json (source ${manifest.sourceCommit})`);
} else {
	if (!source) { console.error("set TREBOL_ROOT to a cloverinternational/trebol checkout"); process.exit(1); }
	const files = {};
	for (const rel of ALL) {
		const from = join(source, rel);
		if (!existsSync(from)) throw new Error(`source file missing: ${from}`);
		mkdirSync(dirname(join(vendor, rel)), { recursive: true });
		copyFileSync(from, join(vendor, rel));
		files[rel] = sha(join(vendor, rel));
	}
	let commit = "unknown";
	try { commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"]).toString().trim(); } catch {}
	writeFileSync(manifestPath, JSON.stringify({ source: "cloverinternational/trebol", sourceCommit: commit, files }, null, 2) + "\n");
	console.log(`vendored ${ALL.length} files from ${source} @ ${commit}`);
}
