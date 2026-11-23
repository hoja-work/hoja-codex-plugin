import { defineConfig } from "vitest/config";

// Two suites run here:
//  - vendor/trebol/**: Trebol's own tests, unmodified, against the vendored (byte-identical) engine and hooks;
//  - test/**: the Claude Code adapter's tests (MCP server, hook mapping, transcript evidence, journal).
export default defineConfig({
  test: {
    include: ["vendor/trebol/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    setupFiles: ["vendor/trebol/tests/setup/isolate-state.ts"],
    testTimeout: 30_000,
    // No suite may reach GitHub: the update notice is off unless a test turns it on with a fake fetch.
    env: { HOJA_PLUGIN_UPDATE_CHECK: "off" },
  },
});
