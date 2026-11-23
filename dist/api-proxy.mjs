// Built by scripts/build.mjs from src/ and vendor/trebol/ (see vendor/MANIFEST.json). Do not edit.

// src/api-proxy.ts
import { createInterface } from "node:readline";

// vendor/trebol/.pi/lib/claw/hoja.ts
var HOJA_TOKEN_VARS = ["HOJA_TOKEN", "LINEAR_TOKEN"];
var HOJA_URL_VARS = ["HOJA_API_URL", "LINEAR_API_URL"];
var HOJA_ENDPOINT_HINT = "No Hoja endpoint configured. Set HOJA_API_URL (e.g. https://workspace.hoja.work/graphql) or HOJA_MCP_URL; LINEAR_API_URL is honoured only as a deprecated alias.";
function resolveHojaUrl(env = process.env, override) {
  const direct = override?.trim() || credentialValue(HOJA_URL_VARS, env);
  if (direct) return direct;
  const mcp = env.HOJA_MCP_URL?.trim();
  if (!mcp) return "";
  try {
    const parsed = new URL(mcp);
    parsed.pathname = "/graphql";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
function resolveHojaToken(env = process.env, override) {
  return override ?? credentialValue(HOJA_TOKEN_VARS, env) ?? "";
}
var MISSING_HOJA_TOKEN = "HOJA_TOKEN is not set (deprecated fallback LINEAR_TOKEN is also unset); Hoja is unavailable";
function credentialValue(names, env = process.env) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return void 0;
}

// src/credentials.ts
import { execFileSync } from "node:child_process";
var URL_VARS = ["HOJA_API_URL", "LINEAR_API_URL", "HOJA_MCP_URL"];
var TOKEN_VARS = ["HOJA_TOKEN", "LINEAR_TOKEN"];
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function normalizeEndpoint(raw) {
  const value = raw?.trim() ?? "";
  if (!value) return { url: "" };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: "", problem: `"${value}" is not a URL. Use the full address, e.g. https://acme.hoja.work/mcp.` };
  }
  if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
    return { url: "", problem: `Refusing plain-http endpoint ${parsed.host}: Hoja tokens are only sent over https (loopback excepted).` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { url: "", problem: `Unsupported scheme in "${value}".` };
  return { url: parsed.toString() };
}
var defaultRunCli = (args) => execFileSync("hoja", args, {
  encoding: "utf8",
  timeout: 15e3,
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true
});
function readCliCredential(run = defaultRunCli) {
  try {
    const parsed = JSON.parse(run(["auth", "token", "--json"]));
    return typeof parsed?.access_token === "string" && parsed.access_token ? parsed : void 0;
  } catch {
    return void 0;
  }
}
var Credentials = class {
  constructor(env = process.env, run = defaultRunCli) {
    this.env = env;
    this.run = run;
  }
  env;
  run;
  source = "none";
  problems = [];
  workspace;
  expiresAt = 0;
  apply() {
    this.problems = [];
    for (const name of URL_VARS) {
      if (!this.env[name]?.trim()) continue;
      const { url, problem } = normalizeEndpoint(this.env[name]);
      if (problem) {
        this.problems.push(`${name}: ${problem}`);
        delete this.env[name];
      } else this.env[name] = url;
    }
    if (TOKEN_VARS.some((name) => this.env[name]?.trim())) {
      this.source = "env";
      return this;
    }
    this.fromCli();
    return this;
  }
  /** The token to send now; refreshes a CLI token that is about to expire. */
  token() {
    if (this.source === "hoja-cli" && this.expiresAt && Date.now() > this.expiresAt - 6e4) this.fromCli();
    return this.env.HOJA_TOKEN?.trim() || this.env.LINEAR_TOKEN?.trim() || "";
  }
  /** After a 401: a pasted key cannot be refreshed; a CLI sign-in can. True when a new token was obtained. */
  refresh() {
    if (this.source !== "hoja-cli") return false;
    const before = this.env.HOJA_TOKEN;
    this.fromCli();
    return this.source === "hoja-cli" && this.env.HOJA_TOKEN !== before;
  }
  fromCli() {
    const credential = readCliCredential(this.run);
    if (!credential) {
      if (this.source === "hoja-cli") delete this.env.HOJA_TOKEN;
      this.source = "none";
      return;
    }
    this.source = "hoja-cli";
    this.env.HOJA_TOKEN = credential.access_token;
    this.workspace = credential.workspace?.name || credential.workspace?.origin;
    const expires = typeof credential.expires_at === "number" ? credential.expires_at * 1e3 : Date.parse(credential.expires_at ?? "");
    this.expiresAt = Number.isFinite(expires) ? expires : 0;
    for (const [name, value] of [["HOJA_API_URL", credential.api_url], ["HOJA_MCP_URL", credential.mcp_url]]) {
      if (this.env[name]?.trim() || !value) continue;
      const { url } = normalizeEndpoint(value);
      if (url) this.env[name] = url;
    }
  }
};
function authFetch(credentials2, base = fetch) {
  const withToken = (init) => {
    const headers = { ...init?.headers ?? {} };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
    const token = credentials2.token();
    if (token) headers.authorization = `Bearer ${token}`;
    return { ...init, headers };
  };
  return async (url, init) => {
    const response = await base(url, withToken(init));
    if (response?.status !== 401 || !credentials2.refresh()) return response;
    return base(url, withToken(init));
  };
}
var SIGN_IN_HINT = "Run `hoja auth login <your-workspace>` in a terminal (recommended), or set HOJA_TOKEN and HOJA_API_URL.";

// src/env.ts
var OPTION_ENV = [
  ["HOJA_API_URL", "HOJA_PLUGIN_API_URL"],
  ["HOJA_MCP_URL", "HOJA_PLUGIN_MCP_URL"],
  ["HOJA_TOKEN", "HOJA_PLUGIN_TOKEN"],
  ["HOJA_PROJECT", "HOJA_PLUGIN_PROJECT"],
  ["TASK_ENFORCEMENT", "HOJA_PLUGIN_ENFORCEMENT"],
  ["TRACE_UPLOAD", "HOJA_PLUGIN_TRACE_UPLOAD"],
  ["TRACE_DETAIL", "HOJA_PLUGIN_TRACE_DETAIL"]
];
function applyUserConfig(env = process.env) {
  for (const [option, name] of OPTION_ENV) {
    const v = env[`CLAUDE_PLUGIN_OPTION_${option}`]?.trim();
    if (v && !env[name]?.trim()) env[name] = v;
  }
  const set = (from, to) => {
    const v = env[from]?.trim();
    if (v) env[to] = v;
  };
  set("HOJA_PLUGIN_API_URL", "HOJA_API_URL");
  set("HOJA_PLUGIN_TOKEN", "HOJA_TOKEN");
  set("HOJA_PLUGIN_PROJECT", "HOJA_PROJECT");
  set("HOJA_PLUGIN_MCP_URL", "HOJA_MCP_URL");
}
var credentials = new Credentials(process.env);
function applyCredentials() {
  applyUserConfig();
  return credentials.apply();
}

// src/api-proxy.ts
function resolveMcpUrl(env = process.env) {
  const direct = env.HOJA_MCP_URL?.trim();
  if (direct) return normalizeEndpoint(direct).url;
  const graphql = resolveHojaUrl(env);
  if (!graphql) return "";
  try {
    const u = new URL(graphql);
    u.pathname = "/mcp";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}
var UpstreamMcp = class {
  constructor(url, token, fetchImpl = fetch) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  url;
  token;
  fetchImpl;
  session;
  seq = 0;
  protocolVersion = "2025-06-18";
  async send(method, params, notification = false, signal) {
    const id = notification ? void 0 : `up-${++this.seq}`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "mcp-protocol-version": this.protocolVersion
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const response = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...id ? { id } : {}, method, ...params ? { params } : {} }), signal });
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    const text = await response.text();
    if (notification) return void 0;
    if (response.status === 401 || response.status === 403) throw new Error(`Hoja MCP rejected the token (${response.status}). ${SIGN_IN_HINT}`);
    if (response.status >= 400) throw new Error(`Hoja MCP ${this.url} answered HTTP ${response.status}`);
    const message = parseMessages(text, response.headers.get("content-type") ?? "").find((m) => m.id === id);
    if (!message) throw new Error(`Hoja MCP returned no response for ${method}`);
    if (message.error) throw new Error(message.error.message ?? `Hoja MCP ${method} failed`);
    return message.result;
  }
};
function parseMessages(body, contentType) {
  if (!contentType.includes("text/event-stream")) {
    try {
      const v = JSON.parse(body);
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  }
  const out = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) try {
      out.push(JSON.parse(data));
    } catch {
    }
  }
  return out;
}
function createProxy(env = process.env, fetchImpl, credentials2) {
  const url = resolveMcpUrl(env);
  const token = credentials2 ? credentials2.token() : resolveHojaToken(env);
  const configProblem = credentials2?.problems.join(" ") ?? "";
  const problem = configProblem || (!url ? HOJA_ENDPOINT_HINT : !token ? `${MISSING_HOJA_TOKEN}. ${SIGN_IN_HINT}` : "");
  const transport = credentials2 ? authFetch(credentials2, fetchImpl ?? fetch) : fetchImpl;
  const upstream = problem ? void 0 : new UpstreamMcp(url, token, transport);
  let ready;
  let failure = problem;
  const connect = (protocolVersion) => ready ??= (async () => {
    upstream.protocolVersion = protocolVersion;
    const result = await upstream.send("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "hoja-claude-plugin", version: "0.2.0" } });
    if (typeof result?.protocolVersion === "string") upstream.protocolVersion = result.protocolVersion;
    await upstream.send("notifications/initialized", void 0, true);
    return result;
  })().catch((error) => {
    failure = error.message;
    ready = void 0;
    throw error;
  });
  async function handle(method, params, signal) {
    if (method === "initialize") {
      const protocolVersion = params?.protocolVersion ?? "2025-06-18";
      let instructions = "";
      if (upstream) {
        try {
          instructions = (await connect(protocolVersion))?.instructions ?? "";
        } catch {
        }
      }
      if (failure) instructions = `Hoja API unavailable: ${failure}`;
      return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "hoja-api", version: "0.2.0" }, ...instructions ? { instructions } : {} };
    }
    if (method === "tools/list") {
      if (!upstream) return { tools: [] };
      try {
        await connect(upstream.protocolVersion);
        const tools = [];
        let cursor;
        do {
          const page = await upstream.send("tools/list", cursor ? { cursor } : {}, false, signal);
          tools.push(...page?.tools ?? []);
          cursor = page?.nextCursor;
        } while (cursor);
        return { tools };
      } catch {
        return { tools: [] };
      }
    }
    if (method === "tools/call") {
      if (!upstream) return { content: [{ type: "text", text: `Hoja API unavailable: ${failure}` }], isError: true };
      try {
        await connect(upstream.protocolVersion);
        return await upstream.send("tools/call", params, false, signal);
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    }
    if (method === "ping") return {};
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
  return { handle, url, problem: () => failure };
}
function main() {
  const credentials2 = applyCredentials();
  const proxy = createProxy(process.env, void 0, credentials2);
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  const inflight = /* @__PURE__ */ new Map();
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (method === "notifications/cancelled") {
      inflight.get(params?.requestId)?.abort();
      return;
    }
    if (id === void 0 || typeof method !== "string") return;
    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      send({ jsonrpc: "2.0", id, result: await proxy.handle(method, params ?? {}, controller.signal) });
    } catch (error) {
      send({ jsonrpc: "2.0", id, error: { code: error.code ?? -32603, message: error.message } });
    } finally {
      inflight.delete(id);
    }
  }).on("close", () => process.exit(0));
}
if (process.argv[1] && /api-proxy\.(m?js|ts)$/.test(process.argv[1])) main();
export {
  UpstreamMcp,
  createProxy,
  parseMessages,
  resolveMcpUrl
};
