#!/usr/bin/env node
/**
 * Full-matrix sandbox E2E for the ai& CLI against the live gateway.
 *
 * Purpose
 *   Production-credit test phase: exercises every CLI surface (plumbing,
 *   auth, run, models, logs, usage, orgs, config, login, agent wiring,
 *   init, launcher) against https://api.aiand.com with a real key and
 *   reports what actually breaks. Runs on any disposable Linux box with
 *   Node >= 22.5 (node:sqlite) — Docker, ConTree, Daytona, or bare metal.
 *   Zero npm dependencies — node: builtins only. Provider drivers live in
 *   scripts/*-e2e.sh; the contract is: copy dist + package.json +
 *   scripts/sbx-test.mjs in, run `node scripts/sbx-test.mjs <cli.js>` with
 *   AIAND_API_KEY set, throw the box away.
 *
 * Usage
 *   node scripts/sbx-test.mjs <cli.js>   full live matrix (spends credit)
 *   node scripts/sbx-test.mjs --plan     print every check id, exit 0
 *   node scripts/sbx-test.mjs --smoke    offline subset, no key, no network
 *
 * Env contract
 *   AIAND_API_KEY  required for the full matrix; the real session key.
 *   All CLI state stays under /tmp/aiand-sbx (AIAND_HOME / AIAND_CONFIG_DIR
 *   point there); the real home is never touched.
 *
 * WARNING: the full matrix makes a handful of tiny real inference calls and
 * one live key validation — it spends production credit. Run it deliberately.
 *
 * Deliberate gaps (test manually):
 *   - interactive `chat` (needs a TTY; the non-TTY refusal IS covered)
 *   - device/browser login (mints a real machine key) — pasted-key sign-in
 *     is covered instead; the mint path creates server-side credentials a
 *     shared test run must not leave behind.
 */

import { spawnSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/* -------------------------------------------------------------------------- */
/* Scenario layout                                                            */
/* -------------------------------------------------------------------------- */

const S = "/tmp/aiand-sbx";
const BIN = join(S, "bin");
const LAUNCHED = join(S, "launched");
const STUB_JS = join(S, "stub.js");
const MAIN_HOME = join(S, "home");
const MAIN_CFG = join(S, "cfg");
const AUTH_HOME = join(S, "auth-home");
const AUTH_CFG = join(S, "auth-cfg");
const CLEAN_HOME = join(S, "clean-home");
const CLEAN_CFG = join(S, "clean-cfg");
const NOCFG = join(S, "nocfg");

const argv = process.argv.slice(2);
const MODE = argv.includes("--plan") ? "plan" : argv.includes("--smoke") ? "smoke" : "full";
const positional = argv.find((a) => !a.startsWith("--"));
const CLI = positional ?? join(process.cwd(), "dist", "index.js");
const KEY = process.env.AIAND_API_KEY ?? "";
// A placeholder session for offline paths that demand one; never sent anywhere.
const SMOKE_KEY = "sk-smoke-local-offline";
const KEY_EFFECTIVE = MODE === "smoke" ? SMOKE_KEY : KEY;

// /usr/bin:/bin keeps the "clean" scenario agent-free even on machines whose
// real PATH carries coding-agent binaries (WSL mounts, nvm dirs).
const PATH_BARE = "/usr/local/bin:/usr/bin:/bin";
const PATH_REAL = process.env.PATH ?? PATH_BARE;
const NODE = process.execPath;

// Env vars scrubbed from every scenario so parent-machine state can never
// leak into the CLI's resolution or the recorded stub environments.
const SCRUB = [
  "XDG_CONFIG_HOME",
  "AIAND_PROFILE",
  "AIAND_BASE_URL",
  "AIAND_AUTH_URL",
  "AIAND_CONFIG_DIR",
  "AIAND_HOME",
  "AIAND_KEY_STORAGE",
  "AIAND_IDE_SECRET_PLAINTEXT",
  "AIAND_CODEX_AUTH_TOKEN",
  "AIAND_HERMES_API_KEY",
  "DSH_HOME",
  "HERMES_HOME",
  "GROK_HOME",
  "GROK_AUTH",
  "GROK_MODELS_LIST_URL",
  "GROK_MODELS_BASE_URL",
  "GROK_IMAGE_GEN",
  "XAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "DEEPSEEK_API_KEY",
  "OPENCODE_CONFIG_CONTENT",
  "PRIME_AGENT_CODING_AGENT_DIR",
  "STUB_EXIT",
];

function baseEnv(home, cfg, { stubs = true, key = KEY_EFFECTIVE, extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: "1", CI: "1" };
  for (const name of SCRUB) delete env[name];
  env.AIAND_HOME = home;
  env.AIAND_CONFIG_DIR = cfg;
  if (key === null) delete env.AIAND_API_KEY;
  else env.AIAND_API_KEY = key;
  env.PATH = stubs ? `${BIN}:${PATH_REAL}` : PATH_BARE;
  Object.assign(env, extra);
  return env;
}
const mainEnv = (extra = {}) => baseEnv(MAIN_HOME, MAIN_CFG, { extra });
const authEnv = (extra = {}) => baseEnv(AUTH_HOME, AUTH_CFG, { stubs: false, key: null, extra });
const cleanEnv = (extra = {}) => baseEnv(CLEAN_HOME, CLEAN_CFG, { stubs: false, extra });
const noKeyEnv = () => baseEnv(NOCFG, NOCFG, { stubs: false, key: null });

/* -------------------------------------------------------------------------- */
/* CLI helper + small utilities                                               */
/* -------------------------------------------------------------------------- */

function cli(args, { env, timeout = 30000, input } = {}) {
  const r = spawnSync(NODE, [CLI, ...args], { env, encoding: "utf8", timeout, input: input ?? "" });
  return {
    status: r.error && r.status === null ? -1 : r.status,
    stdout: r.stdout ?? "",
    // Node prints runtime warnings (e.g. node:sqlite ExperimentalWarning plus
    // its "(Use `node --trace-warnings ...`)" continuation line) to stderr on
    // every invocation; strip them so assertions see CLI output.
    stderr: String(r.stderr ?? "")
      .split("\n")
      .filter((line) => !/^\((node:\d+|Use `node)/.test(line))
      .join("\n"),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Inference responses stream reasoning before content on reasoning models, so
// the tiny prompts get a budget that survives a reasoning preamble (50 would
// read as an empty answer and mask real failures).
const MAX_TOKENS = "512";

const CURSOR_DB = join(MAIN_HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
const VSCODE_JSON = join(MAIN_HOME, ".config", "Code", "User", "chatLanguageModels.json");
const VSCODE_DB = join(MAIN_HOME, ".config", "Code", "User", "globalStorage", "state.vscdb");
const CLAUDE_SETTINGS = join(MAIN_HOME, ".claude", "settings.json");
const CLAUDE_JSON = join(MAIN_HOME, ".claude.json");
const CODEX_TOML = join(MAIN_HOME, ".codex", "config.toml");
const CODEX_CACHE = join(MAIN_HOME, ".codex", "models_cache.json");
const CODEX_CATALOG = join(MAIN_HOME, ".codex", "aiand-models.json");
const OPENCODE_CFG = join(MAIN_HOME, ".config", "opencode", "opencode.json");
const PI_SETTINGS = join(MAIN_HOME, ".pi", "agent", "settings.json");
const PI_AUTH = join(MAIN_HOME, ".pi", "agent", "auth.json");
const PI_MODELS = join(MAIN_HOME, ".pi", "agent", "models.json");
const DSH_SETTINGS = join(MAIN_HOME, ".dsh", "settings.yaml");
const DSH_CREDS = join(MAIN_HOME, ".dsh", ".credentials.yaml");
const PRIME_DIR = join(MAIN_CFG, "agents", "prime");
const PRIME_MODELS = join(PRIME_DIR, "models.json");
const VSCODE_SIDECAR = join(MAIN_CFG, "agents", "vscode", "secrets.json");

let cursorSecretModule = null;
async function loadDecryptSecret() {
  if (!cursorSecretModule) {
    cursorSecretModule = await import(
      pathToFileURL(join(dirname(CLI), "agents", "cursor-secret.js"))
    );
  }
  return cursorSecretModule.decryptSecret;
}

function seedFile(state, path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  state.seeds.set(path, readFileSync(path));
  return path;
}

function sameBytes(path, expected) {
  try {
    return readFileSync(path).equals(expected);
  } catch {
    return false;
  }
}

function dbAll(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function seedVscdb(dbPath, rows) {
  mkdirSync(dirname(dbPath), { recursive: true });
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);");
    const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of rows) insert.run(key, value);
  } finally {
    db.close();
  }
}

const cellText = (value) => (typeof value === "string" ? value : Buffer.from(value).toString("utf8"));

/* -------------------------------------------------------------------------- */
/* Sandbox setup                                                              */
/* -------------------------------------------------------------------------- */

const STUB_NAMES = ["claude", "codex", "cursor", "opencode", "pi", "code", "dsh", "prime-agent", "hermes", "grok"];

function writeStubs() {
  mkdirSync(BIN, { recursive: true });
  mkdirSync(LAUNCHED, { recursive: true });
  writeFileSync(
    STUB_JS,
    `const fs = require("node:fs");
const name = process.argv[2];
const record = { name, args: process.argv.slice(3), env: { ...process.env } };
(async () => {
  if (process.env.GROK_MODELS_LIST_URL) {
    try {
      const res = await fetch(process.env.GROK_MODELS_LIST_URL);
      record.fetched = await res.text();
    } catch (error) {
      record.fetched = "FETCH_ERROR: " + error.message;
    }
  }
  fs.writeFileSync(${JSON.stringify(LAUNCHED)} + "/" + name + ".json", JSON.stringify(record, null, 2));
  process.exit(Number(process.env.STUB_EXIT ?? 0));
})();
`
  );
  chmodSync(STUB_JS, 0o755);
  for (const name of STUB_NAMES) {
    const path = join(BIN, name);
    writeFileSync(path, `#!/bin/sh\nexec "${NODE}" ${STUB_JS} ${name} "$@"\n`);
    chmodSync(path, 0o755);
  }
}

// Offline catalog so --smoke never needs the live gateway: the launcher
// bad-model check validates --model against the CLI's 6h catalog cache.
function seedSmokeCatalogCache() {
  const models = [
    ["zai-org/glm-5.3", "GLM 5.3", "zai-org", ["text", "tool_calling"], "0.60", "2.40"],
    ["google/gemma-4-31b-it", "Gemma 4 31B", "google", ["text", "vision"], "0.20", "0.50"],
  ].map(([id, name, provider, capabilities, input, output]) => ({
    id,
    name,
    object: "model",
    created: 1,
    owned_by: provider,
    provider,
    context_window: 200000,
    capabilities,
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: input,
    output_per_1m: output,
    cached_input_per_1m: "0.10",
  }));
  writeFileSync(
    join(MAIN_CFG, "model-catalog.json"),
    JSON.stringify({ fetchedAt: Date.now(), baseUrl: "https://api.aiand.com", models }, null, 2)
  );
}

function setup() {
  rmSync(S, { recursive: true, force: true });
  for (const dir of [MAIN_CFG, AUTH_CFG, CLEAN_CFG, NOCFG, BIN, LAUNCHED]) {
    mkdirSync(dir, { recursive: true });
  }
  writeStubs();
  if (MODE === "smoke") seedSmokeCatalogCache();
}

/* -------------------------------------------------------------------------- */
/* Shared state                                                               */
/* -------------------------------------------------------------------------- */

let catalog = null;

function loadCatalog() {
  if (catalog) return catalog;
  if (MODE === "smoke") return null;
  const r = cli(["models", "--json"], { env: mainEnv(), timeout: 60000 });
  catalog = parseJson(r.stdout);
  return catalog;
}

function modelId() {
  const models = loadCatalog();
  if (Array.isArray(models) && models.length > 0) {
    for (const preferred of [
      "zai-org/glm-5.3",
      "moonshotai/kimi-k3",
      "qwen/qwen3.8-27b",
      "google/gemma-4-31b-it",
    ]) {
      if (models.some((m) => m.id === preferred)) return preferred;
    }
    return models[0].id;
  }
  return "zai-org/glm-5.3";
}

/* -------------------------------------------------------------------------- */
/* Check plumbing                                                             */
/* -------------------------------------------------------------------------- */

const results = [];

function makeT() {
  return {
    fails: [],
    verdict: null,
    detail: null,
    ok(cond, label, detail = "") {
      if (!cond) this.fails.push(detail ? `${label} (${detail})` : label);
    },
  };
}

function report(check, verdict, detail) {
  results.push({ id: check.id, section: check.section, verdict, detail });
  console.log(`${verdict} ${check.id} — ${detail}`);
}

async function execute(check) {
  const t = makeT();
  try {
    await check.run(t);
  } catch (error) {
    t.fails.push(`threw: ${error?.message ?? error}`);
  }
  const verdict = t.verdict ?? (t.fails.length > 0 ? "FAIL" : "PASS");
  const detail = t.detail ?? (t.fails.length > 0 ? t.fails.join("; ") : "ok");
  report(check, verdict, detail);
}

/* -------------------------------------------------------------------------- */
/* Adapter seeds                                                              */
/* -------------------------------------------------------------------------- */

const agentStates = {};
const agentState = (id) => (agentStates[id] ??= { seeds: new Map(), created: [] });

const AGENT_DEFS = {
  claude: {
    bin: "claude",
    seed(state) {
      state.created = [];
      state.settings = seedFile(
        state,
        CLAUDE_SETTINGS,
        `{"other":"keep-me","env":{"ANTHROPIC_API_KEY":"sk-stray","CUSTOM":"x"}}`
      );
      state.claudeJson = seedFile(state, CLAUDE_JSON, `{"keep":1}`);
    },
    contents(t) {
      const settings = parseJson(readFileSync(CLAUDE_SETTINGS, "utf8")) ?? {};
      const env = settings.env ?? {};
      t.ok(env.ANTHROPIC_BASE_URL === "https://api.aiand.com", "env.ANTHROPIC_BASE_URL is the gateway origin (no /v1)", JSON.stringify(env));
      t.ok(env.ANTHROPIC_AUTH_TOKEN === KEY, "env.ANTHROPIC_AUTH_TOKEN carries the session key");
      t.ok(typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.length > 0, "env.ANTHROPIC_MODEL non-empty");
      t.ok(settings.other === "keep-me", "unrelated key 'other' survives");
      t.ok(env.CUSTOM === "x", "unrelated env.CUSTOM survives");
      t.ok(!("ANTHROPIC_API_KEY" in env), "stray env.ANTHROPIC_API_KEY swept");
      const claudeJson = parseJson(readFileSync(CLAUDE_JSON, "utf8")) ?? {};
      t.ok(claudeJson.keep === 1, ".claude.json keep survives");
    },
  },

  codex: {
    bin: "codex",
    seed(state) {
      state.created = [CODEX_CATALOG];
      state.toml = seedFile(
        state,
        CODEX_TOML,
        `# my config\nmodel = "gpt-5"\n[other]\nkey = "value"\n`
      );
      state.cache = seedFile(state, CODEX_CACHE, `{"cached":true}`);
    },
    contents(t) {
      const text = readFileSync(CODEX_TOML, "utf8");
      t.ok(text.includes("[model_providers.aiand]"), "[model_providers.aiand] table written");
      t.ok(text.includes('base_url = "https://api.aiand.com/v1"'), "base_url is gateway /v1");
      let rootModel = null;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) break;
        const m = /^model\s*=\s*"(.+)"\s*$/.exec(trimmed);
        if (m) {
          rootModel = m[1];
          break;
        }
      }
      t.ok(rootModel === modelId(), `root model pinned to ${modelId()}`, `got ${rootModel}`);
      t.ok(text.includes('key = "value"'), "unrelated [other] table survives");
      const parsed = parseJson(readFileSync(CODEX_CATALOG, "utf8"));
      t.ok(parsed !== null && typeof parsed === "object", "aiand-models.json written and parses");
    },
  },

  cursor: {
    bin: "cursor",
    seed(state) {
      state.created = [];
      seedVscdb(CURSOR_DB, [
        [
          "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser",
          JSON.stringify({
            someOtherField: 42,
            aiSettings: { modelConfig: { chat: { modelName: "claude-sonnet-4-6" } } },
          }),
        ],
        ["unrelated/row", "precious"],
        ["cursorAuth/otherKey", "user-secret"],
      ]);
      state.db = CURSOR_DB;
      state.seeds.set(CURSOR_DB, readFileSync(CURSOR_DB));
    },
    async contents(t) {
      const rows = dbAll(CURSOR_DB, "SELECT key, value FROM ItemTable");
      const blobRow = rows.find((r) =>
        r.key ===
        "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
      );
      t.ok(blobRow !== undefined, "applicationUser blob still present");
      if (!blobRow) return;
      const blob = parseJson(cellText(blobRow.value)) ?? {};
      t.ok(blob.openAIBaseUrl === "https://api.aiand.com/v1", "blob openAIBaseUrl is gateway /v1", String(blob.openAIBaseUrl));
      t.ok(blob.useOpenAIKey === true, "blob useOpenAIKey enabled");
      t.ok(blob.someOtherField === 42, "unrelated blob field survives");
      const secretRow = rows.find((r) => r.key === "secret://cursorAuth/openAIKey");
      if (secretRow) {
        const decrypt = await loadDecryptSecret();
        const decrypted = decrypt(cellText(secretRow.value), {});
        t.ok(decrypted === KEY, "encrypted cursorAuth secret decrypts to the key", `got ${decrypted.length} chars`);
      } else {
        const plain = rows.find((r) => r.key === "cursorAuth/openAIKey");
        t.ok(plain !== undefined && cellText(plain.value) === KEY, "plaintext cursorAuth/openAIKey is the key");
      }
      t.ok(rows.some((r) => r.key === "unrelated/row" && cellText(r.value) === "precious"), "unrelated rows survive on");
      t.ok(rows.some((r) => r.key === "cursorAuth/otherKey"), "cursorAuth/otherKey survives on");
    },
  },

  opencode: {
    bin: "opencode",
    seed(state) {
      state.created = [];
      state.cfg = seedFile(
        state,
        OPENCODE_CFG,
        JSON.stringify({ theme: "dark", provider: { anthropic: { name: "Anthropic" } }, keep: true })
      );
    },
    contents(t) {
      const cfg = parseJson(readFileSync(OPENCODE_CFG, "utf8")) ?? {};
      const aiand = cfg.provider?.aiand ?? {};
      t.ok(aiand.options?.apiKey === KEY, "provider.aiand.options.apiKey is the session key");
      t.ok(aiand.options?.baseURL === "https://api.aiand.com/v1", "provider.aiand baseURL is gateway /v1", String(aiand.options?.baseURL));
      t.ok(cfg.model === `aiand/${modelId()}`, `root model ref is aiand/${modelId()}`, String(cfg.model));
      t.ok(Array.isArray(cfg.enabled_providers) && cfg.enabled_providers.includes("aiand"), "enabled_providers locks to aiand");
      t.ok(cfg.theme === "dark" && cfg.keep === true, "unrelated keys survive");
      t.ok(cfg.provider?.anthropic?.name === "Anthropic", "foreign provider survives");
    },
  },

  pi: {
    bin: "pi",
    seed(state) {
      state.created = [];
      state.settings = seedFile(state, PI_SETTINGS, JSON.stringify({ keep: "yes" }));
      state.auth = seedFile(state, PI_AUTH, JSON.stringify({ otherprov: { key: "k" } }));
      state.models = seedFile(state, PI_MODELS, JSON.stringify({ x: 1 }));
    },
    contents(t) {
      const settings = parseJson(readFileSync(PI_SETTINGS, "utf8")) ?? {};
      t.ok(settings.defaultProvider === "aiand" && settings.defaultModel === modelId(), "settings pin the aiand provider + catalog model", JSON.stringify(settings));
      t.ok(settings.keep === "yes", "unrelated settings key survives");
      const auth = parseJson(readFileSync(PI_AUTH, "utf8")) ?? {};
      t.ok(auth.aiand?.key === KEY, "auth.aiand.key is the session key");
      t.ok(auth.otherprov?.key === "k", "unrelated auth provider survives");
      const models = parseJson(readFileSync(PI_MODELS, "utf8")) ?? {};
      t.ok(models.providers?.aiand?.baseUrl === "https://api.aiand.com/v1", "models provider baseUrl is gateway /v1");
      t.ok(Array.isArray(models.providers?.aiand?.models) && models.providers.aiand.models.length > 0, "models gains aiand entries");
      t.ok(models.x === 1, "unrelated models key survives");
    },
  },

  deepseek: {
    bin: "dsh",
    seed(state) {
      state.created = [];
      state.settings = seedFile(
        state,
        DSH_SETTINGS,
        `keep: 1\nllm-pi-ai:\n  providers:\n    other: {}\n`
      );
      state.creds = seedFile(state, DSH_CREDS, `OTHER: k\n`);
    },
    contents(t) {
      const settings = readFileSync(DSH_SETTINGS, "utf8");
      t.ok(settings.includes("agent-default-model"), "settings gains agent-default-model");
      t.ok(settings.includes("baseURL: https://api.aiand.com/v1"), "providers.aiand baseURL is gateway /v1");
      t.ok(settings.includes("other:"), "unrelated provider entry survives");
      t.ok(settings.includes("keep: 1"), "unrelated keep key survives");
      const creds = readFileSync(DSH_CREDS, "utf8");
      t.ok(creds.includes(`AIAND_API_KEY: ${KEY}`), "credentials carry the session key");
      t.ok(creds.includes("OTHER:"), "unrelated credential survives");
    },
  },

  prime: {
    bin: "prime-agent",
    seed(state) {
      state.created = [PRIME_DIR];
      rmSync(PRIME_DIR, { recursive: true, force: true });
    },
    contents(t) {
      const parsed = parseJson(readFileSync(PRIME_MODELS, "utf8"));
      t.ok(parsed !== null, "sidecar models.json parses");
      if (!parsed) return;
      const aiand = parsed.providers?.aiand;
      t.ok(aiand?.baseUrl === "https://api.aiand.com/v1", "sidecar provider baseUrl is gateway /v1", String(aiand?.baseUrl));
      t.ok(Array.isArray(aiand?.models) && aiand.models.length > 0, "sidecar carries catalog models");
    },
  },

  vscode: {
    bin: "code",
    seed(state) {
      state.created = [VSCODE_SIDECAR];
      state.json = seedFile(state, VSCODE_JSON, `[{"id":"other","apiKey":"their-key"}]`);
      seedVscdb(VSCODE_DB, [["unrelated/vscode", "keep-me"]]);
      // NOTE: the vscdb is NOT a vscode managed file (only chatLanguageModels.json
      // is snapshotted), so off deletes aiand's secret rows instead of restoring
      // the DB bytes. verifyOffExtra below asserts exactly that contract.
      state.vscdb = VSCODE_DB;
    },
    async contents(t) {
      const arr = parseJson(readFileSync(VSCODE_JSON, "utf8"));
      t.ok(Array.isArray(arr), "chatLanguageModels.json is an array");
      if (!Array.isArray(arr)) return;
      const aiand = arr.find(
        (p) => typeof p.apiKey === "string" && p.apiKey.startsWith("${input:chat.lm.secret.aiand-")
      );
      t.ok(aiand !== undefined, "aiand-owned provider added");
      if (!aiand) return;
      const secretId = aiand.apiKey.slice("${input:".length, -1);
      t.ok(/^chat\.lm\.secret\.aiand-[0-9a-f]+$/.test(secretId), "secret id uses the aiand prefix", secretId);
      t.ok(
        typeof aiand.models?.[0]?.url === "string" && aiand.models[0].url.startsWith("https://api.aiand.com/v1"),
        "first model url is gateway /v1",
        String(aiand.models?.[0]?.url)
      );
      t.ok(arr.some((p) => p.id === "other" && p.apiKey === "their-key"), "foreign provider entry survives");
      const rows = dbAll(VSCODE_DB, "SELECT value FROM ItemTable WHERE key = ?", [`secret://${secretId}`]);
      const decrypt = rows[0] ? await loadDecryptSecret() : null;
      const decrypted = rows[0] && decrypt ? decrypt(cellText(rows[0].value), {}) : "";
      t.ok(decrypted === KEY, "state.vscdb secret decrypts to the session key", `got ${decrypted.length} chars`);
      t.ok(existsSync(VSCODE_SIDECAR), "sidecar secrets.json recorded");
      t.ok(dbAll(VSCODE_DB, "SELECT key FROM ItemTable WHERE key = ?", ["unrelated/vscode"]).length === 1, "unrelated state.vscdb row survives on");
    },
    verifyOffExtra(t) {
      const leaked = dbAll(VSCODE_DB, "SELECT key FROM ItemTable WHERE key LIKE 'secret://chat.lm.secret.aiand-%'");
      t.ok(leaked.length === 0, "aiand-owned secret rows stripped from state.vscdb on off");
      t.ok(dbAll(VSCODE_DB, "SELECT key FROM ItemTable WHERE key = ?", ["unrelated/vscode"]).length === 1, "unrelated state.vscdb row survives off");
    },
  },
};

const WIRING_EIGHT = ["claude", "codex", "cursor", "opencode", "pi", "vscode", "deepseek", "prime"];

function verifyOffRestore(t, id) {
  const state = agentStates[id];
  for (const [path, bytes] of state.seeds) {
    t.ok(sameBytes(path, bytes), `seed restored byte-for-byte: ${path}`);
  }
  for (const created of state.created) {
    t.ok(!existsSync(created), `aiand-created path removed: ${created}`);
  }
  const extra = AGENT_DEFS[id].verifyOffExtra;
  if (extra) extra(t, state);
}

function stubRecord(name) {
  return parseJson(readFileSync(join(LAUNCHED, `${name}.json`), "utf8"));
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

const checks = [];
const define = (section, id, run, { smoke = false } = {}) => checks.push({ section, id, run, smoke });

function okStatus(t, r, label, expect = 0) {
  t.ok(r.status === expect, `${label} exits ${expect}`, `exit ${r.status}: ${(r.stderr || r.stdout).split("\n")[0]}`);
}

/* == plumbing == */

define("plumbing", "plumbing-version", (t) => {
  const pkg = parseJson(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8"));
  t.ok(pkg?.version !== undefined, "package.json next to the dist tree reads");
  const r = cli(["--version"], { env: mainEnv() });
  okStatus(t, r, "--version");
  t.ok(r.stdout.trim() === pkg?.version, `--version equals package version ${pkg?.version}`, r.stdout.trim());
}, { smoke: true });

define("plumbing", "plumbing-help", (t) => {
  const r = cli(["--help"], { env: mainEnv() });
  okStatus(t, r, "--help");
  for (const name of ["login", "logout", "whoami", "run", "chat", "models", "logs", "usage", "orgs", "config", "init", "status", "run-agent", "key"]) {
    t.ok(r.stdout.includes(name), `help lists ${name}`);
  }
}, { smoke: true });

define("plumbing", "plumbing-unknown", (t) => {
  const unknown = cli(["definitely-not-a-command"], { env: mainEnv() });
  t.ok(unknown.status === 127, "unknown command exits 127", `exit ${unknown.status}`);
  t.ok(unknown.stderr.includes("Unknown command"), "stderr names the unknown command", unknown.stderr.split("\n")[0]);
  // The suggestion machinery: a near-miss gets the "Did you mean" hint.
  const nearMiss = cli(["mdels"], { env: mainEnv() });
  t.ok(nearMiss.status === 127, "near-miss exits 127");
  t.ok(nearMiss.stderr.includes("Did you mean"), "near-miss suggests a command", nearMiss.stderr.split("\n").join(" "));
}, { smoke: true });

define("plumbing", "plumbing-chat-refusal", (t) => {
  const r = cli(["chat"], { env: mainEnv() });
  t.ok(r.status === 1, "chat with non-TTY stdin exits 1", `exit ${r.status}`);
  t.ok(r.stderr.includes("needs an interactive terminal"), "refusal names the interactive terminal requirement", r.stderr.split("\n")[0]);
}, { smoke: true });

/* == auth == */

define("auth", "auth-whoami", (t) => {
  const r = cli(["whoami", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "whoami --json");
  const who = parseJson(r.stdout) ?? {};
  t.ok(typeof who.user?.email === "string" && who.user.email.length > 0, "user.email non-empty", JSON.stringify(who.user));
  t.ok(who.source === "AIAND_API_KEY", "source is AIAND_API_KEY", String(who.source));
  t.ok(who.api_url === "https://api.aiand.com", "api_url is the gateway", String(who.api_url));
  t.ok(typeof who.key === "string" && who.key.startsWith("sk-") && who.key !== KEY, "key is masked, never raw", String(who.key));
});

define("auth", "auth-key-export", (t) => {
  const r = cli(["key", "export"], { env: mainEnv() });
  okStatus(t, r, "key export");
  t.ok(r.stdout.trim() === KEY, "key export prints the env key", r.stdout.trim().slice(0, 6));
});

define("auth", "auth-whoami-local", (t) => {
  const r = cli(["whoami", "--local", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "whoami --local --json");
  const who = parseJson(r.stdout) ?? {};
  t.ok(who.profile === "default", "profile is default", String(who.profile));
});

define("auth", "auth-missing-key", (t) => {
  const r = cli(["whoami"], { env: noKeyEnv() });
  t.ok(r.status === 2, "whoami without any key exits 2", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("Not logged in"), "refusal says Not logged in", r.stderr.split("\n")[0]);
});

define("auth", "auth-public-models", (t) => {
  const r = cli(["models", "--json"], { env: noKeyEnv(), timeout: 60000 });
  okStatus(t, r, "models --json without a key");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "public catalog lists models", String(models.length));
  t.ok(models.every((m) => m.currency === "usd"), "public catalog priced in usd");
});

define("auth", "auth-status-env", (t) => {
  const r = cli(["status"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "status");
  const out = r.stdout + r.stderr;
  t.ok(out.includes("AIAND_API_KEY"), "status names the env key source", out.split("\n").slice(0, 4).join(" | "));
  t.ok(out.includes("claude"), "status lists the claude agent");
});
define("run", "run-no-stream-json", (t) => {
  // Explicit -m: the "auto" alias is account-gated (covered by the run-stream
  // WARN path), so shape assertions pin a real catalog id.
  const r = cli(
    ["run", "-m", modelId(), "--no-stream", "--json", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000 }
  );
  okStatus(t, r, "run --no-stream --json");
  const body = parseJson(r.stdout) ?? {};
  const content = body.choices?.[0]?.message?.content;
  t.ok(typeof content === "string" && content.length > 0, "choices[0].message.content non-empty", r.stdout.slice(0, 200));
  t.ok(body.usage !== null && typeof body.usage === "object", "usage object present");
});
define("run", "run-stdin", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000, input: "context-line" }
  );
  okStatus(t, r, "run with piped stdin");
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-stream", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-m", id, "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000 }
  );
  okStatus(t, r, `run -m ${id} (stream)`);
  t.ok(r.stdout.trim().length > 0, "streamed stdout non-empty");
  t.ok(r.stderr.includes("·"), "stderr footer present", r.stderr.split("\n").slice(-3).join(" | "));
});

define("run", "run-model", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000 }
  );
  okStatus(t, r, `run -m ${id}`);
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-system", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "--system", "be terse", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000 }
  );
  okStatus(t, r, "run --system");
  t.ok(r.stdout.trim().length > 0, "non-empty answer", (r.stderr || r.stdout).split("\n")[0]);
});


define("run", "run-quiet", (t) => {
  const id = modelId();
  const r = cli(
    ["run", "-q", "-m", id, "--no-stream", "--max-tokens", MAX_TOKENS, "Reply with the single word: ok"],
    { env: mainEnv(), timeout: 180000 }
  );
  okStatus(t, r, "run -q");
  t.ok(r.stderr === "", "stderr empty (no stats footer)", r.stderr.split("\n")[0]);
});

define("run", "run-bad-model", (t) => {
  const r = cli(["run", "-m", "definitely-bogus", "--no-stream", "hi"], { env: mainEnv(), timeout: 180000 });
  t.ok(r.status === 1, "unknown model exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).trim().length > 0, "error surfaced", (r.stderr || r.stdout).split("\n")[0]);
});

define("run", "run-no-prompt", (t) => {
  const r = cli(["run"], { env: mainEnv(), timeout: 60000, input: "" });
  t.ok(r.status === 1, "run with no prompt exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("No prompt given"), "refusal names the missing prompt", r.stderr.split("\n")[0]);
});

/* == models == */

define("models", "models-json", (t) => {
  const r = cli(["models", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "models --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "catalog non-empty", String(models.length));
  t.ok(models.every((m) => typeof m.id === "string" && Array.isArray(m.capabilities)), "every model has id + capabilities");
});

define("models", "models-vision", (t) => {
  const r = cli(["models", "--capability", "vision", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "models --capability vision --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "vision-capable models exist", String(models.length));
  t.ok(models.every((m) => m.capabilities.includes("vision")), "every returned model has vision");
});

define("models", "models-sort", (t) => {
  const r = cli(["models", "--sort", "input", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "models --sort input --json");
  const models = parseJson(r.stdout) ?? [];
  t.ok(models.length > 0, "catalog non-empty");
  const sorted = models.every(
    (m, i, arr) => i === 0 || Number(arr[i - 1].input_per_1m) <= Number(m.input_per_1m)
  );
  t.ok(sorted, "input_per_1m values non-decreasing");
});

define("models", "models-search", (t) => {
  const models = loadCatalog() ?? [];
  const first = models[0];
  t.ok(first !== undefined, "catalog loaded for search");
  if (!first) return;
  const query = first.provider.toLowerCase();
  const r = cli(["models", "--search", query, "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, `models --search ${query}`);
  const results2 = parseJson(r.stdout) ?? [];
  t.ok(results2.length > 0, "search matched", String(results2.length));
  t.ok(
    results2.every((m) =>
      [m.id, m.name, m.provider].some((field) => String(field).toLowerCase().includes(query))
    ),
    `every result matches "${query}"`
  );
});

/* == logs == */

function retry(times, fn) {
  let last = null;
  for (let attempt = 0; attempt < times; attempt++) {
    last = fn();
    if (last) return last;
    if (attempt < times - 1) sleepSync(5000);
  }
  return last;
}

define("logs", "logs-recent", (t) => {
  const attempt = () => {
    const r = cli(["logs", "--range", "15m", "--json"], { env: mainEnv(), timeout: 60000 });
    const entries = parseJson(r.stdout);
    if (r.status === 0 && Array.isArray(entries) && entries.length > 0) return { r, entries };
    return null;
  };
  const found = retry(3, attempt);
  t.ok(found !== null, "logs --range 15m returns entries (3 attempts, 5s apart)", found ? "" : "no entries after retries");
  if (!found) return;
  t.ok(
    found.entries.every(
      (e) => typeof e.status_code === "number" && typeof e.model === "string" && typeof e.created_at === "string"
    ),
    "every entry has numeric status_code, string model and created_at"
  );
});

define("logs", "logs-errors", (t) => {
  const r = cli(["logs", "--errors", "--range", "15m", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "logs --errors --json");
  const entries = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(entries), "errors output is an array", String(entries.length));
  t.ok(entries.every((e) => e.status_code >= 400), "every error entry has status_code >= 400");
});

define("logs", "logs-follow", async (t) => {
  // NOTE: waits here must be promise-based. A sleepSync busy loop blocks the
  // event loop, so the child process's data/exit events would never fire
  // while waiting — every observation below would come back empty.
  const child = spawn(NODE, [CLI, "logs", "--follow", "--interval", "1"], {
    env: mainEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const announced = await new Promise((resolve) => {
    if (/Following/.test(stderr)) return resolve(true);
    const timer = setTimeout(() => resolve(false), 15000);
    child.stderr.on("data", () => {
      if (/Following/.test(stderr)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
  t.ok(announced, "follow announces itself on stderr within 15s", stderr.split("\n")[0]);
  try {
    child.kill("SIGINT");
  } catch {
    /* already gone */
  }
  const exited = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  t.ok(exited, "follow terminates on SIGINT", `exit ${child.exitCode} signal ${child.signalCode}`);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/* == usage == */

define("usage", "usage-summary", (t) => {
  const r = cli(["usage", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "usage --json");
  const summary = parseJson(r.stdout) ?? {};
  const current = summary.current ?? {};
  t.ok(
    typeof current.requests === "number" &&
      typeof current.input_tokens === "number" &&
      typeof current.output_tokens === "number",
    "current totals numeric",
    JSON.stringify(summary.current)
  );
  t.ok(
    typeof summary.previous?.requests === "number" &&
      typeof summary.previous?.input_tokens === "number" &&
      typeof summary.previous?.output_tokens === "number",
    "previous totals numeric"
  );
  t.ok(Array.isArray(summary.timeseries), "timeseries array present");
  t.ok(current.requests >= 1, "current.requests reflects this run's calls", String(current.requests));
});

define("usage", "usage-range", (t) => {
  const r = cli(["usage", "--range", "1h", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "usage --range 1h --json");
});

define("usage", "usage-metrics", (t) => {
  const r = cli(["usage", "--metrics", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "usage --metrics --json");
  const metrics = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(metrics), "metrics output is an array", String(metrics.length));
  t.ok(metrics.every((m) => typeof m.metric_name === "string"), "every metric has metric_name");
});

/* == orgs == */

define("orgs", "orgs-list", (t) => {
  const r = cli(["orgs", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, r, "orgs --json");
  const orgs = parseJson(r.stdout) ?? [];
  t.ok(Array.isArray(orgs) && orgs.length >= 1, "at least one org", String(orgs.length));
  t.ok(typeof orgs[0]?.id === "string" && typeof orgs[0]?.name === "string", "first org has id + name");
});

/* == config (pristine main cfg — runs before any login test) == */

define("config", "config-show", (t) => {
  const r = cli(["config", "--json"], { env: mainEnv() });
  okStatus(t, r, "config --json");
  const cfg = parseJson(r.stdout) ?? {};
  t.ok(cfg.name === "default", "profile default", String(cfg.name));
  t.ok(cfg.apiUrl === "https://api.aiand.com", "api_url is the gateway", String(cfg.apiUrl));
  t.ok(cfg.signed_in === false, "signed_in false (env key only)", String(cfg.signed_in));
}, { smoke: true });

define("config", "config-path", (t) => {
  const r = cli(["config", "path", "--json"], { env: mainEnv() });
  okStatus(t, r, "config path --json");
  const paths = parseJson(r.stdout) ?? {};
  t.ok(typeof paths.config === "string" && paths.config.endsWith("config.json"), "config path reported", String(paths.config));
  t.ok(typeof paths.credentials === "string" && paths.credentials.endsWith("credentials.json"), "credentials path reported", String(paths.credentials));
  t.ok(paths.config.startsWith(MAIN_CFG), "paths live under the isolated config dir", String(paths.config));
}, { smoke: true });

define("login", "login-with-token", (t) => {
  const r = cli(["login", "--with-token", "--json"], { env: authEnv(), timeout: 60000, input: KEY });
  okStatus(t, r, "login --with-token --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(out.profile === "default" && out.source === "pasted-key" && out.storage === "file", "pasted key stored in the file tier", JSON.stringify(out));
});

define("config", "config-set-model", (t) => {
  const id = modelId();
  let r = cli(["config", "set", "model", id], { env: mainEnv() });
  okStatus(t, r, `config set model ${id}`);
  r = cli(["config", "--json"], { env: mainEnv() });
  const cfg = parseJson(r.stdout) ?? {};
  t.ok(cfg.model === id, `config shows model ${id}`, String(cfg.model));
  r = cli(["config", "set", "model", "auto"], { env: mainEnv() });
  okStatus(t, r, "config set model auto");
  r = cli(["config", "--json"], { env: mainEnv() });
  t.ok((parseJson(r.stdout) ?? {}).model === "auto", "model restored to auto");
}, { smoke: true });

define("config", "config-set-bad", (t) => {
  const r = cli(["config", "set", "bogus", "x"], { env: mainEnv() });
  t.ok(r.status === 1, "unknown settable key exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("not a settable key"), "refusal names the bad key", r.stderr.split("\n")[0]);
}, { smoke: true });

define("config", "config-profiles", (t) => {
  const r = cli(["config", "profiles", "--json"], { env: mainEnv() });
  okStatus(t, r, "config profiles --json");
  const rows = parseJson(r.stdout) ?? [];
  const def = rows.find((row) => row.name === "default");
  t.ok(def?.active === true && def?.signed_in === false, "default profile active, signed out", JSON.stringify(def));
}, { smoke: true });

define("config", "config-use", (t) => {
  let r = cli(["config", "use", "work"], { env: mainEnv() });
  okStatus(t, r, "config use work");
  r = cli(["config", "profiles", "--json"], { env: mainEnv() });
  const rows = parseJson(r.stdout) ?? [];
  t.ok(rows.some((row) => row.name === "work" && row.active === true), "work profile active");
  r = cli(["key", "export"], { env: mainEnv() });
  okStatus(t, r, "key export under work profile");
  t.ok(r.stdout.trim() === KEY_EFFECTIVE, "env key still wins for key export");
  r = cli(["config", "use", "default"], { env: mainEnv() });
  okStatus(t, r, "config use default restores");
}, { smoke: true });

/* == login (pristine auth scenario, no env key) == */

define("login", "login-whoami", (t) => {
  const r = cli(["whoami", "--json"], { env: authEnv(), timeout: 60000 });
  okStatus(t, r, "whoami --json (stored credential)");
  const who = parseJson(r.stdout) ?? {};
  t.ok(typeof who.user?.email === "string" && who.user.email.length > 0, "user.email non-empty");
  t.ok(who.source === "pasted-key", "source is pasted-key", String(who.source));
  t.ok(who.storage === "file", "storage is file", String(who.storage));
});

define("login", "login-status", (t) => {
  const r = cli(["status", "--json"], { env: authEnv(), timeout: 120000 });
  okStatus(t, r, "status --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(out.auth?.signed_in === true, "auth.signed_in true");
  t.ok(Array.isArray(out.agents) && out.agents.length === 10, "agents array length 10", String(out.agents?.length));
});

define("login", "login-key-export", (t) => {
  const r = cli(["key", "export"], { env: authEnv() });
  okStatus(t, r, "key export (stored credential)");
  t.ok(r.stdout.trim() === KEY, "exported key equals the stored key");
});

define("login", "login-rejects-bad-key", (t) => {
  // --force skips the already-signed-in gate so the key itself gets validated.
  const r = cli(["login", "--force", "--with-token"], {
    env: authEnv(),
    timeout: 60000,
    input: "sk-this-key-is-definitely-invalid-000\n",
  });
  t.ok(r.status === 1, "invalid key exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("rejected"), "server rejection surfaced", r.stderr.split("\n")[0]);
});

define("login", "login-logout", (t) => {
  const r = cli(["logout", "--json"], { env: authEnv() });
  okStatus(t, r, "logout --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(
    out.profile === "default" && out.revoked === false && out.source === "pasted-key",
    "pasted key cleared locally, never revoked server-side",
    JSON.stringify(out)
  );
  const who = cli(["whoami", "--json"], { env: authEnv() });
  t.ok(who.status === 2, "whoami after logout exits 2", `exit ${who.status}`);
});

define("login", "login-logout-when-out", (t) => {
  const r = cli(["logout"], { env: authEnv() });
  t.ok(r.status === 0, "logout while signed out exits 0", `exit ${r.status}`);
  t.ok((r.stdout + r.stderr).includes("not signed in"), "friendly not-signed-in note", r.stdout.split("\n")[0]);
}, { smoke: true });

/* == agents (wiring eight, stubs on PATH) == */

for (const id of WIRING_EIGHT) {
  const def = AGENT_DEFS[id];
  define("agents", `agents-${id}-on`, (t) => {
    def.seed(agentState(id));
    const r = cli([id, "on", "--json"], { env: mainEnv(), timeout: 120000 });
    okStatus(t, r, `${id} on`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "on", "state on", JSON.stringify(out));
    const ids = (loadCatalog() ?? []).map((m) => m.id);
    t.ok(typeof out.model === "string" && (ids.length === 0 || ids.includes(out.model)), "model is a catalog id", String(out.model));
    t.ok(Array.isArray(out.files) && out.files.length > 0, "files list non-empty", JSON.stringify(out.files));
  });

  define("agents", `agents-${id}-contents`, (t) => {
    const run = { ok: (cond, label, detail) => t.ok(cond, label, detail) };
    // contents checks may be async (cursor/vscode secret decryption)
    return Promise.resolve(def.contents(run)).then(() => {});
  });

  define("agents", `agents-${id}-status`, (t) => {
    const r = cli([id, "status", "--json"], { env: mainEnv(), timeout: 60000 });
    okStatus(t, r, `${id} status`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "on", "status reports on", JSON.stringify(out));
  });

  define("agents", `agents-${id}-off-restore`, (t) => {
    const r = cli([id, "off", "--json"], { env: mainEnv(), timeout: 60000 });
    okStatus(t, r, `${id} off`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "off", "state off", JSON.stringify(out));
    verifyOffRestore(t, id);
  });

  define("agents", `agents-${id}-status-off`, (t) => {
    const r = cli([id, "status", "--json"], { env: mainEnv(), timeout: 60000 });
    okStatus(t, r, `${id} status after off`);
    const out = parseJson(r.stdout) ?? {};
    t.ok(out.state === "off", "status reports off", JSON.stringify(out));
  });
}

/* Claude stray-key approval (approveStrayAnthropicApiKey) */
define("agents", "agents-claude-stray", async (t) => {
  const state = agentStates.claude;
  const stray = "sk-stray-parent-key-000000000000";
  const r = cli(["claude", "on", "--json"], { env: mainEnv({ ANTHROPIC_API_KEY: stray }), timeout: 120000 });
  okStatus(t, r, "claude on with stray ANTHROPIC_API_KEY");
  const claudeJson = parseJson(readFileSync(CLAUDE_JSON, "utf8")) ?? {};
  const approved = claudeJson.customApiKeyResponses?.approved ?? [];
  t.ok(approved.includes(stray.slice(-20)), "stray key pre-approved by its last 20 chars", JSON.stringify(approved));
  t.ok(claudeJson.keep === 1, ".claude.json keep still survives");
  const off = cli(["claude", "off", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, off, "claude off");
  for (const [path, bytes] of state.seeds) {
    t.ok(sameBytes(path, bytes), `seed restored byte-for-byte: ${path}`);
  }
});

/* == agent edge cases == */

for (const id of ["claude", "codex", "cursor"]) {
  define("edge", `agents-reon-idempotent-${id}`, (t) => {
    const env = { env: mainEnv(), timeout: 120000 };
    const on1 = cli([id, "on", "--json"], env);
    okStatus(t, on1, `${id} on (first)`);
    const on2 = cli([id, "on", "--json"], env);
    okStatus(t, on2, `${id} on (again)`);
    const off = cli([id, "off", "--json"], { env: mainEnv(), timeout: 60000 });
    okStatus(t, off, `${id} off`);
    const status = cli([id, "status", "--json"], { env: mainEnv(), timeout: 60000 });
    const out = parseJson(status.stdout) ?? {};
    t.ok(out.state === "off", "re-on kept the first snapshot (off lands back on the seed)", JSON.stringify(out));
    verifyOffRestore(t, id);
  });
}

define("edge", "agents-launcher-only", (t) => {
  for (const id of ["hermes", "grok"]) {
    const r = cli([id, "on"], { env: mainEnv() });
    t.ok(r.status === 1, `${id} on exits 1`, `exit ${r.status}`);
    const out = r.stderr + r.stdout;
    t.ok(out.includes("per session only"), `${id} refusal names per-session-only`, out.split("\n")[0]);
    t.ok(out.includes(`run-agent ${id}`), `${id} refusal hints at the launcher`);
  }
}, { smoke: true });

define("edge", "agents-not-installed", (t) => {
  const claude = cli(["claude", "on"], { env: cleanEnv(), timeout: 60000 });
  t.ok(claude.status === 127, "claude on without a binary exits 127", `exit ${claude.status}`);
  t.ok(
    (claude.stderr + claude.stdout).includes("npm install -g @anthropic-ai/claude-code"),
    "install hint names the official command",
    claude.stderr.split("\n")[0]
  );
  const init = cli(["init"], { env: cleanEnv(), timeout: 60000 });
  t.ok(init.status === 1, "bare non-interactive init exits 1", `exit ${init.status}`);
  t.ok(
    (init.stderr + init.stdout).includes("Non-interactive init needs explicit agents"),
    "init refusal names the explicit-agents requirement",
    init.stderr.split("\n")[0]
  );
}, { smoke: true });

define("edge", "agents-quit-guard", (t) => {
  const probe = spawnSync("which", ["pgrep"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.verdict = "WARN";
    t.detail = "pgrep not available — quit-guard untestable here";
    return;
  }
  const decoyScript = join(S, "cursor-decoy.sh");
  writeFileSync(decoyScript, "#!/bin/bash\nexec -a /cursor sleep 60\n");
  chmodSync(decoyScript, 0o755);
  const decoy = spawn(decoyScript, [], { detached: true, stdio: "ignore" });
  decoy.unref();
  try {
    sleepSync(500);
    const refused = cli(["cursor", "on", "--json"], { env: mainEnv(), timeout: 60000 });
    t.ok(refused.status === 1, "on refuses while a Cursor-like process runs", `exit ${refused.status}`);
    t.ok(/will overwrite this config/.test(refused.stderr), "refusal explains the clobber risk", refused.stderr.split("\n")[0]);
    t.ok(/--force/.test(refused.stderr), "refusal hints at --force");
    const forced = cli(["cursor", "on", "--force", "--json"], { env: mainEnv(), timeout: 120000 });
    okStatus(t, forced, "cursor on --force");
    t.ok((parseJson(forced.stdout) ?? {}).state === "on", "forced on proceeds past the guard");
  } finally {
    try {
      process.kill(-decoy.pid, "SIGKILL");
    } catch {
      try {
        decoy.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    sleepSync(300);
  }
  const off = cli(["cursor", "off", "--json"], { env: mainEnv(), timeout: 60000 });
  okStatus(t, off, "cursor off after guard");
  t.ok(sameBytes(CURSOR_DB, agentStates.cursor.seeds.get(CURSOR_DB)), "off restores the DB byte-for-byte after a forced on");
});

/* == init == */

define("init", "init-named", (t) => {
  AGENT_DEFS.claude.seed(agentStates.claude);
  AGENT_DEFS.codex.seed(agentStates.codex);
  const r = cli(["init", "claude", "codex", "--json"], { env: mainEnv(), timeout: 120000 });
  okStatus(t, r, "init claude codex --json");
  const out = parseJson(r.stdout) ?? {};
  t.ok(out.agents?.[0]?.agent === "claude" && out.agents?.[0]?.state === "on", "claude wired on", JSON.stringify(out.agents?.[0]));
  t.ok(out.agents?.[1]?.agent === "codex" && out.agents?.[1]?.state === "on", "codex wired on", JSON.stringify(out.agents?.[1]));
  const off = cli(["init", "--off", "--json"], { env: mainEnv(), timeout: 120000 });
  okStatus(t, off, "init --off --json");
  const offOut = parseJson(off.stdout) ?? {};
  t.ok(
    offOut.agents?.length === 2 && offOut.agents.every((a) => a.state === "off"),
    "both agents unwired",
    JSON.stringify(offOut.agents)
  );
  t.ok(sameBytes(CLAUDE_SETTINGS, agentStates.claude.seeds.get(CLAUDE_SETTINGS)), "claude settings byte-identical to the seed");
});

define("init", "init-all", (t) => {
  const r = cli(["init", "--all", "--json"], { env: mainEnv(), timeout: 300000 });
  okStatus(t, r, "init --all --json");
  const out = parseJson(r.stdout) ?? {};
  const rows = out.agents ?? [];
  for (const id of WIRING_EIGHT) {
    const row = rows.find((a) => a.agent === id);
    t.ok(row?.state === "on", `${id} wired on by --all`, JSON.stringify(row));
  }
  for (const id of ["hermes", "grok"]) {
    const row = rows.find((a) => a.agent === id);
    t.ok(
      row?.state === "off" && typeof row?.note === "string" && row.note.includes("launcher-only"),
      `${id} reported launcher-only, not wired`,
      JSON.stringify(row)
    );
  }
  const off = cli(["init", "--off", "--json"], { env: mainEnv(), timeout: 300000 });
  okStatus(t, off, "init --off --json after --all");
  const offOut = parseJson(off.stdout) ?? {};
  t.ok(
    (offOut.agents ?? []).length === WIRING_EIGHT.length &&
      (offOut.agents ?? []).every((a) => a.state === "off"),
    "every wired agent off again",
    JSON.stringify(offOut.agents)
  );
});

define("init", "init-none", (t) => {
  const r = cli(["init", "--json"], { env: cleanEnv(), timeout: 60000 });
  t.ok(r.status === 0, "init --json with nothing installed exits 0", `exit ${r.status}`);
  const out = parseJson(r.stdout) ?? {};
  t.ok(Array.isArray(out.agents) && out.agents.length === 0, "agents list empty", JSON.stringify(out.agents));
  t.ok(
    typeof out.message === "string" && out.message.includes("No coding agents detected"),
    "message says no coding agents detected",
    String(out.message)
  );
}, { smoke: true });

/* == launcher (run-agent, stubs on PATH) == */

function launchCheck(name, args, { extra = {}, timeout = 60000 } = {}) {
  rmSync(join(LAUNCHED, `${name}.json`), { force: true });
  return cli(["run-agent", ...args], { env: mainEnv(extra), timeout });
}

define("launcher", "launcher-claude", (t) => {
  const r = launchCheck("claude", ["claude", "--", "--dump"]);
  okStatus(t, r, "run-agent claude");
  const rec = stubRecord("claude");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(rec.env.ANTHROPIC_BASE_URL === "https://api.aiand.com", "ANTHROPIC_BASE_URL is the gateway origin", String(rec.env.ANTHROPIC_BASE_URL));
  t.ok(rec.env.ANTHROPIC_AUTH_TOKEN === KEY, "ANTHROPIC_AUTH_TOKEN is the session key");
  t.ok(typeof rec.env.ANTHROPIC_MODEL === "string" && rec.env.ANTHROPIC_MODEL.length > 0, "ANTHROPIC_MODEL non-empty");
  t.ok(rec.args.includes("--dump"), "passthrough args forwarded", JSON.stringify(rec.args));
});

define("launcher", "launcher-claude-stray", (t) => {
  const stray = "sk-stray-parent-key-000000000000";
  const r = launchCheck("claude", ["claude", "--", "--dump"], { extra: { ANTHROPIC_API_KEY: stray } });
  okStatus(t, r, "run-agent claude with stray key");
  const rec = stubRecord("claude");
  t.ok(rec !== null && !("ANTHROPIC_API_KEY" in rec.env), "stray ANTHROPIC_API_KEY cleared from the child env", JSON.stringify(rec?.env?.ANTHROPIC_API_KEY));
});

define("launcher", "launcher-codex", (t) => {
  const r = launchCheck("codex", ["codex", "--", "--dump"]);
  okStatus(t, r, "run-agent codex");
  const rec = stubRecord("codex");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(rec.env.AIAND_CODEX_AUTH_TOKEN === KEY, "AIAND_CODEX_AUTH_TOKEN is the session key");
  t.ok(rec.args.includes("-c"), "codex -c overrides present", JSON.stringify(rec.args));
  t.ok(rec.args.includes('model_provider="aiand"'), 'model_provider="aiand" override present');
});

define("launcher", "launcher-opencode", (t) => {
  const r = launchCheck("opencode", ["opencode", "--", "--dump"]);
  okStatus(t, r, "run-agent opencode");
  const rec = stubRecord("opencode");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  const cfg = parseJson(rec.env.OPENCODE_CONFIG_CONTENT ?? "");
  t.ok(cfg !== null, "OPENCODE_CONFIG_CONTENT parses as JSON");
  if (!cfg) return;
  t.ok(cfg.provider?.aiand?.options?.apiKey === KEY, "inline provider apiKey is the session key");
  t.ok(cfg.provider?.aiand?.options?.baseURL === "https://api.aiand.com/v1", "inline baseURL is gateway /v1");
  t.ok(cfg.model === `aiand/${modelId()}`, `inline model ref is aiand/${modelId()}`, String(cfg.model));
});

define("launcher", "launcher-pi", (t) => {
  const r = launchCheck("pi", ["pi", "--", "--dump"]);
  okStatus(t, r, "run-agent pi");
  const rec = stubRecord("pi");
  t.ok(rec !== null, "pi stub ran (rides persistent wiring — empty env by design)");
});

define("launcher", "launcher-deepseek", (t) => {
  const r = launchCheck("dsh", ["deepseek", "--", "--dump"], { extra: { DEEPSEEK_API_KEY: "sk-stray-parent-key-000000000000" } });
  okStatus(t, r, "run-agent deepseek");
  const rec = stubRecord("dsh");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(rec.env.AIAND_API_KEY === KEY, "child env AIAND_API_KEY is the session key");
  t.ok(
    typeof rec.env.DSH_HOME === "string" && rec.env.DSH_HOME.startsWith("/tmp") && rec.env.DSH_HOME !== join(MAIN_HOME, ".dsh"),
    "DSH_HOME is a /tmp overlay, not the real ~/.dsh",
    String(rec.env.DSH_HOME)
  );
  t.ok(!("DEEPSEEK_API_KEY" in rec.env), "stray DEEPSEEK_API_KEY cleared from the child env");
});

define("launcher", "launcher-prime", (t) => {
  rmSync(PRIME_DIR, { recursive: true, force: true });
  const r = launchCheck("prime-agent", ["prime", "--", "--dump"]);
  okStatus(t, r, "run-agent prime");
  const rec = stubRecord("prime-agent");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(typeof rec.env.PRIME_AGENT_CODING_AGENT_DIR === "string" && rec.env.PRIME_AGENT_CODING_AGENT_DIR.length > 0, "PRIME_AGENT_CODING_AGENT_DIR set", String(rec.env.PRIME_AGENT_CODING_AGENT_DIR));
  t.ok(existsSync(PRIME_MODELS), "session launch rewrote the sidecar models.json (left in place by design)");
});

define("launcher", "launcher-hermes", (t) => {
  const r = launchCheck("hermes", ["hermes", "--", "--dump"]);
  okStatus(t, r, "run-agent hermes");
  const rec = stubRecord("hermes");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(typeof rec.env.HERMES_MODEL === "string" && rec.env.HERMES_MODEL.length > 0, "HERMES_MODEL non-empty");
  t.ok(rec.env.AIAND_HERMES_API_KEY === KEY, "AIAND_HERMES_API_KEY is the session key");
  t.ok(typeof rec.env.HERMES_HOME === "string" && rec.env.HERMES_HOME.startsWith("/tmp"), "HERMES_HOME is a /tmp overlay", String(rec.env.HERMES_HOME));
  t.ok(rec.args.includes("--provider") && rec.args.includes("aiand"), "args include --provider aiand", JSON.stringify(rec.args));
});

define("launcher", "launcher-grok", (t) => {
  const r = launchCheck("grok", ["grok", "--", "--dump"]);
  okStatus(t, r, "run-agent grok");
  const rec = stubRecord("grok");
  t.ok(rec !== null, "stub recorded its launch");
  if (!rec) return;
  t.ok(rec.env.XAI_API_KEY === KEY, "XAI_API_KEY is the session key");
  t.ok(rec.env.GROK_MODELS_BASE_URL === "https://api.aiand.com/v1", "GROK_MODELS_BASE_URL is gateway /v1", String(rec.env.GROK_MODELS_BASE_URL));
  t.ok(rec.env.GROK_IMAGE_GEN === "0", "GROK_IMAGE_GEN disabled");
  t.ok(/^http:\/\/127\.0\.0\.1:\d+\/v1\/models$/.test(rec.env.GROK_MODELS_LIST_URL ?? ""), "GROK_MODELS_LIST_URL is the ephemeral local catalog", String(rec.env.GROK_MODELS_LIST_URL));
  const body = parseJson(rec.fetched ?? "");
  t.ok(
    body !== null && Array.isArray(body.data) && body.data.length > 0 && typeof body.data[0].id === "string" && body.data[0].id.length > 0,
    "ephemeral catalog server actually served during the session",
    String(rec.fetched ?? "").slice(0, 120)
  );
});

define("launcher", "launcher-exit-code", (t) => {
  const r = launchCheck("claude", ["claude", "--", "x"], { extra: { STUB_EXIT: "42" } });
  t.ok(r.status === 42, "child exit code propagates", `exit ${r.status}`);
});

define("launcher", "launcher-wiring-only", (t) => {
  for (const [id, stub] of [["cursor", "cursor"], ["vscode", "code"]]) {
    const r = launchCheck(stub, [id]);
    t.ok(r.status === 1, `run-agent ${id} exits 1`, `exit ${r.status}`);
    t.ok(
      (r.stderr + r.stdout).includes("does not support session launches"),
      `${id} refusal names the wiring-only limitation`,
      r.stderr.split("\n")[0]
    );
  }
}, { smoke: true });

define("launcher", "launcher-unknown", (t) => {
  const r = cli(["run-agent", "nope"], { env: mainEnv() });
  t.ok(r.status === 1, "unknown agent exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("Unknown agent"), "refusal names the unknown agent", r.stderr.split("\n")[0]);
}, { smoke: true });

define("launcher", "launcher-bad-model", (t) => {
  const r = launchCheck("claude", ["claude", "--model", "definitely-bogus", "--", "x"]);
  t.ok(r.status === 1, "off-catalog --model exits 1", `exit ${r.status}`);
  t.ok((r.stderr + r.stdout).includes("not in the catalog"), "refusal names the catalog membership rule", r.stderr.split("\n")[0]);
}, { smoke: true });

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  if (MODE === "full" && !KEY) {
    console.error("AIAND_API_KEY is required");
    return 2;
  }
  if (MODE !== "plan") setup();

  let lastSection = null;
  for (const check of checks) {
    if (check.section !== lastSection) {
      console.log(`=== ${check.section} ===`);
      lastSection = check.section;
    }
    if (MODE === "plan") {
      console.log(check.id);
      continue;
    }
    if (MODE === "smoke" && !check.smoke) {
      report(check, "WARN", "skipped: needs the live gateway (offline smoke mode)");
      continue;
    }
    // Sequential by design: sections build on each other's scenario state.
    await execute(check);
  }

  if (MODE === "plan") {
    console.log(`SBX: ${checks.length} checks planned`);
    return 0;
  }

  const passed = results.filter((r) => r.verdict === "PASS").length;
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const warned = results.filter((r) => r.verdict === "WARN").length;
  console.log(`SBX: ${passed} passed, ${failed} failed, ${warned} warned`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error(error?.stack ?? error);
    process.exit(70);
  }
);
