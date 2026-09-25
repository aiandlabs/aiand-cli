import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-claude-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { claudeAdapter, buildClaudeSettings } = await import("../dist/agents/claude.js");
const { CliError } = await import("../dist/cli/errors.js");

const MAIN = "moonshotai/kimi-k3";
const FAST = "deepseek-ai/deepseek-v4-flash";
const OTHER = "zai-org/glm-5.3";
const CATALOG = [
  catalogModel(OTHER, { context_window: 1048576 }),
  catalogModel(MAIN, { context_window: 1048576, capabilities: ["tool_calling", "vision"] }),
  catalogModel(FAST, { context_window: 262144 }),
];
const MAIN_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

const settingsPath = () => join(process.env.AIAND_HOME, ".claude", "settings.json");
const addedJsonPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "claude", "added.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const seed = (value) => {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
// The global default the setup layer resolves; Claude's own order must win over it.
const enableInput = (overrides = {}) =>
  baseEnableInput({
    model: OTHER,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "claude"), {
    recursive: true,
    force: true,
  });
});

describe("claude on", () => {
  test("a fresh settings.json routes every slot, blanks the API key, denies WebSearch, 0600", async () => {
    const result = await claudeAdapter.enable(enableInput());
    const { env, permissions } = readSettings();
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.aiand.com");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-test-key");
    assert.equal(env.ANTHROPIC_API_KEY, "");
    assert.equal(env.AIAND_MANAGED, "1");
    // No profile model: the vision model beats the global default.
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], MAIN, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    // The smaller of the two windows.
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
    assert.deepEqual(permissions.deny, ["WebSearch"]);
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
    assert.equal(result.model, MAIN);
    assert.equal(result.catalogModel, MAIN);
    // The key never lands in added-state.
    assert.doesNotMatch(readFileSync(addedJsonPath(), "utf8"), /sk-test-key/);

    assert.deepEqual(await claudeAdapter.probe(), { active: true, model: MAIN });
  });

  test("the profile's model wins over the Claude order", async () => {
    await claudeAdapter.enable(enableInput({ profileModel: OTHER }));
    assert.equal(readSettings().env.ANTHROPIC_DEFAULT_SONNET_MODEL, OTHER);
  });

  test("--model sets the main slots only; haiku stays fast", async () => {
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const { env } = readSettings();
    for (const slot of MAIN_SLOTS) assert.equal(env[slot], OTHER, slot);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
  });

  test("a re-on without --model keeps a slot already on a catalog model", async () => {
    seed({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: OTHER } });
    await claudeAdapter.enable(enableInput());
    const { env } = readSettings();
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, OTHER, "the user's catalog choice stays");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN);
  });

  test("native writes no model keys and says so", async () => {
    const result = await claudeAdapter.enable(enableInput({ model: "native" }));
    const { env } = readSettings();
    for (const slot of [...MAIN_SLOTS, "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) {
      assert.equal(env[slot], undefined, slot);
    }
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
    assert.match(result.warnings.join(" "), /pass --model/);
  });

  test("a concrete model ai& cannot serve is set aside; an alias stays", async () => {
    seed({ model: "claude-opus-5-5[1m]" });
    const result = await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().model, undefined);
    assert.match(result.warnings.join(" "), /Set aside your model \(claude-opus-5-5\[1m\]\)/);
    await claudeAdapter.disable();
    assert.equal(readSettings().model, "claude-opus-5-5[1m]");

    seed({ model: "opus" });
    await claudeAdapter.enable(enableInput());
    assert.equal(readSettings().model, "opus");
  });

  for (const [what, settings] of [
    ["ANTHROPIC_BASE_URL", { env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } }],
    ["ANTHROPIC_AUTH_TOKEN", { env: { ANTHROPIC_AUTH_TOKEN: "their-token" } }],
    ["apiKeyHelper", { apiKeyHelper: "~/bin/key.sh" }],
    ["Bedrock", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }],
  ]) {
    test(`refuses settings with a foreign ${what}, file untouched`, async () => {
      seed(settings);
      const before = readFileSync(settingsPath(), "utf8");
      await assert.rejects(claudeAdapter.enable(enableInput()), CliError);
      assert.equal(readFileSync(settingsPath(), "utf8"), before);
    });
  }

  test("invalid JSON is a CliError naming the file", async () => {
    seed("{ not json");
    await assert.rejects(claudeAdapter.enable(enableInput()), /settings\.json is not valid JSON/);
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("CLAUDE_CONFIG_DIR is honoured", async () => {
    const dir = join(process.env.AIAND_HOME, "custom-claude");
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const result = await claudeAdapter.enable(enableInput());
      assert.deepEqual(result.filesWritten, [join(dir, "settings.json")]);
      assert.equal(existsSync(settingsPath()), false);
      await claudeAdapter.disable();
      assert.equal(existsSync(join(dir, "settings.json")), false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claude off", () => {
  test("a file on created is removed again", async () => {
    await claudeAdapter.enable(enableInput());
    const result = await claudeAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(existsSync(settingsPath()), false);
    assert.deepEqual(await claudeAdapter.probe(), { active: false, model: null });
  });

  test("an untouched user file comes back byte-identical, with its mode", async () => {
    const original = `{
  // the user's own comment
  "theme": "dark",
  "env": {
    "FOO": "bar"
  }
}
`;
    seed(original);
    await claudeAdapter.enable(enableInput());
    await claudeAdapter.disable();
    assert.equal(readFileSync(settingsPath(), "utf8"), original);
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o644);
  });

  test("the user's own API key and deny entries come back; WebSearch goes", async () => {
    seed({
      env: { ANTHROPIC_API_KEY: "their-anthropic-key" },
      permissions: { deny: ["Bash(rm:*)"] },
    });
    await claudeAdapter.enable(enableInput());
    assert.deepEqual(readSettings().permissions.deny, ["Bash(rm:*)", "WebSearch"]);
    await claudeAdapter.disable();
    const after = readSettings();
    assert.deepEqual(after.env, { ANTHROPIC_API_KEY: "their-anthropic-key" });
    assert.deepEqual(after.permissions.deny, ["Bash(rm:*)"]);
  });

  test("a slot edited after on is left, with a note", async () => {
    await claudeAdapter.enable(enableInput());
    const settings = readSettings();
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "their-pick";
    seed(settings);
    const result = await claudeAdapter.disable();
    assert.match(result.notes.join(" "), /left env\.ANTHROPIC_DEFAULT_OPUS_MODEL/);
    const { env } = readSettings();
    assert.deepEqual(env, { ANTHROPIC_DEFAULT_OPUS_MODEL: "their-pick" });
  });

  test("an unmarked config is left alone", async () => {
    seed({ env: { ANTHROPIC_BASE_URL: "https://proxy.example.com" } });
    const before = readFileSync(settingsPath(), "utf8");
    assert.equal((await claudeAdapter.disable()).stripped, false);
    assert.equal(readFileSync(settingsPath(), "utf8"), before);
  });
});

describe("claude refreshKey", () => {
  test("swaps only the token; a rotation from another key is a no-op", async () => {
    await claudeAdapter.enable(enableInput());
    assert.equal(await claudeAdapter.refreshKey({ apiKey: "sk-new" }), true);
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "sk-new");
    assert.equal(
      await claudeAdapter.refreshKey({ apiKey: "sk-newer", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "sk-new");
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
  });

  test("an unmarked config is not touched", async () => {
    seed({ env: { ANTHROPIC_AUTH_TOKEN: "their-token" } });
    assert.equal(await claudeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readSettings().env.ANTHROPIC_AUTH_TOKEN, "their-token");
  });
});

describe("claude sessionLaunch", () => {
  test("passes a throwaway 0600 --settings file; the child env stays key-free", async () => {
    const launch = await claudeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      catalog: CATALOG,
    });
    assert.deepEqual(launch.env, {});
    assert.equal(launch.args[0], "--settings");
    const file = launch.args[1];
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const settings = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(settings.model, MAIN);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "sk-launch-1");
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://api.aiand.com");
    await launch.cleanup();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(settingsPath()), false, "user settings untouched");
  });

  test("buildClaudeSettings honours --model and a --base-url origin", () => {
    const settings = buildClaudeSettings({
      apiKey: "sk-x",
      baseUrl: "http://127.0.0.1:8787",
      main: OTHER,
      catalog: CATALOG,
    });
    assert.equal(settings.model, OTHER);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, FAST);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
    assert.deepEqual(settings.permissions.deny, ["WebSearch"]);
  });
});
