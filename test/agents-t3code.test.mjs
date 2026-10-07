import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-t3code-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  delete process.env.T3CODE_HOME;
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { t3codeAdapter } = await import("../dist/agents/t3code/adapter.js");
const { CliError } = await import("../dist/cli/errors.js");
const { parseJsonc } = await import("../dist/agents/managed-file.js");

const MAIN = "zai-org/glm-5.3";
const FAST = "deepseek-ai/deepseek-v4-flash";
const OTHER = "moonshotai/kimi-k3";
const CATALOG = [
  catalogModel(MAIN, { context_window: 1048576 }),
  catalogModel(OTHER, { context_window: 1048576, capabilities: ["tool_calling", "vision"] }),
  catalogModel(FAST, { context_window: 262144 }),
];
const MAIN_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/** t3code's config root: $T3CODE_HOME, else ~/.t3 under the agent home. */
const t3Root = () => process.env.T3CODE_HOME || join(process.env.AIAND_HOME, ".t3");
const settingsPath = () => join(t3Root(), "userdata", "settings.json");
/** The session key rides in t3code's own secret store: one .bin per env var. */
const secretPath = (name) =>
  join(
    t3Root(),
    "userdata",
    "secrets",
    `provider-env-${Buffer.from("aiand").toString("base64url")}-${Buffer.from(name).toString("base64url")}.bin`,
  );
const addedJsonPath = () => join(process.env.AIAND_CONFIG_DIR, "snapshots", "t3code", "added.json");
const readSettings = () => parseJsonc(readFileSync(settingsPath(), "utf8"));
const seed = (value) => {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
/** One providerInstances.aiand.environment entry, by var name. */
const envEntry = (settings, name) =>
  settings.providerInstances.aiand.environment.find((row) => row.name === name);
const envValue = (settings, name) => envEntry(settings, name)?.value;

const enableInput = (overrides = {}) =>
  baseEnableInput({
    model: MAIN,
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

beforeEach(() => {
  rmSync(join(process.env.AIAND_HOME, ".t3"), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "t3code"), {
    recursive: true,
    force: true,
  });
});

describe("t3code on", () => {
  test("an absent config probes inactive; on writes the claudeAgent instance, every slot and the secret", async () => {
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });
    const result = await t3codeAdapter.enable(enableInput());
    const settings = readSettings();
    const instance = settings.providerInstances.aiand;
    assert.equal(instance.driver, "claudeAgent");
    assert.equal(instance.displayName, "ai&");
    assert.equal(envValue(settings, "ANTHROPIC_BASE_URL"), "https://api.aiand.com");
    const token = envEntry(settings, "ANTHROPIC_AUTH_TOKEN");
    assert.equal(token.value, "", "the key rides in the secret store, not the settings");
    assert.equal(token.sensitive, true);
    assert.equal(token.valueRedacted, true);
    assert.equal(envValue(settings, "ANTHROPIC_API_KEY"), "");
    assert.equal(envValue(settings, "AIAND_MANAGED"), "1");
    assert.equal(envValue(settings, "CLAUDE_CODE_ATTRIBUTION_HEADER"), "0");
    assert.equal(envValue(settings, "CLAUDE_CODE_DISABLE_1M_CONTEXT"), "1");
    assert.equal(envValue(settings, "CLAUDE_CODE_USE_BEDROCK"), "0");
    assert.equal(envValue(settings, "CLAUDE_CODE_USE_VERTEX"), "0");
    assert.equal(envValue(settings, "CLAUDE_CODE_USE_FOUNDRY"), "0");
    for (const slot of MAIN_SLOTS) assert.equal(envValue(settings, slot), MAIN, slot);
    assert.equal(envValue(settings, "ANTHROPIC_DEFAULT_HAIKU_MODEL"), FAST);
    assert.deepEqual(settings.defaultModelSelection, { instanceId: "aiand", model: MAIN });
    // The session key: raw UTF-8, owner-only, in t3code's own secret store.
    const secret = secretPath("ANTHROPIC_AUTH_TOKEN");
    assert.equal(existsSync(secret), true);
    assert.equal(statSync(secret).mode & 0o777, 0o600);
    assert.equal(readFileSync(secret, "utf8"), "sk-test-key");
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o644, "no key rides in the settings");
    assert.equal(result.model, MAIN);
    assert.ok(result.filesWritten.includes(settingsPath()));
    assert.ok(result.filesWritten.includes(secret));
    // Raw-text invariants: the marker appears exactly once, and the base
    // URL is an origin — the claudeAgent driver appends /v1/messages itself.
    const raw = readFileSync(settingsPath(), "utf8");
    assert.equal(raw.split("AIAND_MANAGED").length - 1, 1, "the marker is written once");
    assert.doesNotMatch(raw, /api\.aiand\.com\/v1/);
  });

  test("unrelated keys and comments survive on's edits, with no duplicated entries", async () => {
    const original = `{
  // the user's own comment
  "theme": "dark"
}
`;
    seed(original);
    await t3codeAdapter.enable(enableInput());
    const wired = readFileSync(settingsPath(), "utf8");
    assert.match(wired, /"theme": "dark"/);
    assert.match(wired, /\/\/ the user's own comment/);
    assert.equal(readSettings().theme, "dark");
    assert.equal(wired.split("AIAND_MANAGED").length - 1, 1, "the marker is written once");
    // A re-on edits in place: still one marker, still one entry per var.
    await t3codeAdapter.enable(enableInput());
    const rewired = readSettings();
    assert.equal(
      readFileSync(settingsPath(), "utf8").split("AIAND_MANAGED").length - 1,
      1,
      "a re-on does not append a second marker",
    );
    const names = rewired.providerInstances.aiand.environment.map((row) => row.name);
    assert.equal(new Set(names).size, names.length, "no duplicated env entries");
    assert.match(readFileSync(settingsPath(), "utf8"), /"theme": "dark"/);
  });

  test("--model pins defaultModelSelection and every slot; the fast slot stays fast", async () => {
    const result = await t3codeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const settings = readSettings();
    assert.deepEqual(settings.defaultModelSelection, { instanceId: "aiand", model: OTHER });
    for (const slot of MAIN_SLOTS) assert.equal(envValue(settings, slot), OTHER, slot);
    assert.equal(envValue(settings, "ANTHROPIC_DEFAULT_HAIKU_MODEL"), FAST);
    assert.equal(result.model, OTHER);
    assert.deepEqual(await t3codeAdapter.probe(), { active: true, model: OTHER });
  });

  test("the fast slot falls back to the main model when no fast model is catalogued", async () => {
    const catalog = [catalogModel(MAIN), catalogModel(OTHER)];
    await t3codeAdapter.enable(enableInput({ catalog }));
    assert.equal(envValue(readSettings(), "ANTHROPIC_DEFAULT_HAIKU_MODEL"), MAIN);
  });

  test("native is refused with a --model hint, leaving the file untouched", async () => {
    seed({ theme: "dark" });
    const before = readFileSync(settingsPath());
    await assert.rejects(
      t3codeAdapter.enable(enableInput({ model: "native" })),
      (error) => error instanceof CliError && /--model/.test(error.message),
    );
    assert.deepEqual(readFileSync(settingsPath()), before);
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
  });

  test("a foreign aiand instance without our marker is refused, file untouched", async () => {
    seed({
      theme: "dark",
      providerInstances: {
        aiand: {
          driver: "claudeAgent",
          displayName: "ai&",
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "https://foreign.example.com" },
            { name: "ANTHROPIC_AUTH_TOKEN", value: "their-token" },
          ],
        },
      },
    });
    const before = readFileSync(settingsPath());
    await assert.rejects(t3codeAdapter.enable(enableInput()), CliError);
    assert.deepEqual(readFileSync(settingsPath()), before);
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
  });

  test("a defaultModelSelection naming another instance is left, with a warning", async () => {
    seed({ defaultModelSelection: { instanceId: "codex", model: "gpt-5.1" } });
    const result = await t3codeAdapter.enable(enableInput());
    assert.deepEqual(readSettings().defaultModelSelection, {
      instanceId: "codex",
      model: "gpt-5.1",
    });
    assert.ok(result.warnings.length > 0, "the left selection is reported");
    // Our instance and slots are still written; only the selection is theirs.
    assert.equal(envValue(readSettings(), "ANTHROPIC_DEFAULT_SONNET_MODEL"), MAIN);
  });

  test("settings.json is written 0644, or keeps the mode it already had", async () => {
    await t3codeAdapter.enable(enableInput());
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o644);
    await t3codeAdapter.disable();

    seed({ theme: "dark" });
    chmodSync(settingsPath(), 0o600);
    await t3codeAdapter.enable(enableInput());
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600, "a pre-existing mode is preserved");
    await t3codeAdapter.disable();
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600, "off hands back the user's mode");
  });

  test("T3CODE_HOME relocates the root, and off follows the file on wrote", async () => {
    const relocated = join(process.env.AIAND_HOME, "t3-relocated");
    process.env.T3CODE_HOME = relocated;
    try {
      const result = await t3codeAdapter.enable(enableInput());
      const writtenSettings = settingsPath();
      const writtenSecret = secretPath("ANTHROPIC_AUTH_TOKEN");
      assert.equal(existsSync(writtenSettings), true);
      assert.equal(existsSync(writtenSecret), true);
      assert.ok(result.filesWritten.includes(writtenSettings));
      assert.ok(result.filesWritten.includes(writtenSecret));
      // off strips the file on wrote, whatever T3CODE_HOME says now.
      process.env.T3CODE_HOME = join(process.env.AIAND_HOME, "t3-elsewhere");
      try {
        const off = await t3codeAdapter.disable();
        assert.equal(off.stripped, true);
      } finally {
        delete process.env.T3CODE_HOME;
      }
      assert.equal(existsSync(writtenSettings), false);
      assert.equal(existsSync(writtenSecret), false);
      assert.equal(existsSync(join(process.env.AIAND_HOME, "t3-elsewhere")), false);
    } finally {
      delete process.env.T3CODE_HOME;
      rmSync(relocated, { recursive: true, force: true });
    }
  });

  test("a second wired T3CODE_HOME is refused while the first is still marked", async () => {
    const first = join(process.env.AIAND_HOME, "t3-first");
    const second = join(process.env.AIAND_HOME, "t3-second");
    process.env.T3CODE_HOME = first;
    try {
      await t3codeAdapter.enable(enableInput());
      const wiredSettings = settingsPath();
      process.env.T3CODE_HOME = second;
      await assert.rejects(
        t3codeAdapter.enable(enableInput()),
        (error) =>
          error instanceof CliError &&
          /already wired through/.test(error.message) &&
          error.message.includes(wiredSettings),
      );
      assert.equal(
        existsSync(settingsPath()),
        false,
        "the second home's settings.json is never created",
      );
      assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
    } finally {
      delete process.env.T3CODE_HOME;
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("managedFiles lists the current and wired config dirs", async () => {
    // With no record, only the current settings and its secret.
    assert.deepEqual(t3codeAdapter.managedFiles(), [
      settingsPath(),
      secretPath("ANTHROPIC_AUTH_TOKEN"),
    ]);
    const first = join(process.env.AIAND_HOME, "t3-first");
    const elsewhere = join(process.env.AIAND_HOME, "t3-elsewhere");
    process.env.T3CODE_HOME = first;
    try {
      await t3codeAdapter.enable(enableInput());
      const wiredSettings = settingsPath();
      const wiredSecret = secretPath("ANTHROPIC_AUTH_TOKEN");
      // A shell with a different T3CODE_HOME still manages the wired file.
      process.env.T3CODE_HOME = elsewhere;
      assert.deepEqual(t3codeAdapter.managedFiles(), [
        settingsPath(),
        secretPath("ANTHROPIC_AUTH_TOKEN"),
        wiredSettings,
        wiredSecret,
      ]);
    } finally {
      delete process.env.T3CODE_HOME;
      rmSync(first, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a defaultModelSelection naming aiand with an unservable model is set aside", async () => {
    seed({
      defaultModelSelection: {
        instanceId: "aiand",
        model: "nonexistent/model",
      },
    });
    const result = await t3codeAdapter.enable(enableInput({ pinModel: false }));
    assert.ok(
      result.warnings.some((warning) => /Set aside/.test(warning)),
      "the unservable standing selection is reported",
    );
    // The selection is overwritten with the resolved catalog default.
    assert.deepEqual(readSettings().defaultModelSelection, {
      instanceId: "aiand",
      model: MAIN,
    });
    // off puts the original selection back.
    await t3codeAdapter.disable();
    assert.deepEqual(readSettings().defaultModelSelection, {
      instanceId: "aiand",
      model: "nonexistent/model",
    });
  });

  test("T3CODE_HOME pointing at a regular file fails with a readable error", async () => {
    const notADir = join(process.env.AIAND_CONFIG_DIR, "t3-home-file");
    writeFileSync(notADir, "not a directory");
    await withEnv({ T3CODE_HOME: notADir }, async () => {
      await assert.rejects(t3codeAdapter.enable(enableInput()), (error) => {
        assert.ok(error instanceof CliError, `expected a CliError, got ${error}`);
        assert.equal(error.exitCode, 1, "a CliError exits 1, never a stack");
        assert.match(error.message, /Cannot read/);
        assert.match(error.message, /settings\.json/);
        assert.match(error.hint ?? "", /T3CODE_HOME/);
        assert.doesNotMatch(error.message, /Unexpected error/);
        return true;
      });
    });
  });
});

describe("t3code off", () => {
  test("a settings.json on created is removed again", async () => {
    await t3codeAdapter.enable(enableInput());
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(existsSync(settingsPath()), false);
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });
  });

  test("an untouched user file comes back byte-identical; the secret and record go", async () => {
    const original = `{
  // the user's own comment
  "theme": "dark",
  "custom": { "kept": true }
}
`;
    seed(original);
    await t3codeAdapter.enable(enableInput());
    await t3codeAdapter.disable();
    assert.deepEqual(readFileSync(settingsPath()), Buffer.from(original, "utf8"));
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
    assert.equal(existsSync(addedJsonPath()), false, "the added-state record is cleared");
    // A second off has nothing left to strip.
    assert.equal((await t3codeAdapter.disable()).stripped, false);
  });

  test("an instance edited after on is left, with our marker and token gone", async () => {
    seed({ theme: "dark" });
    await t3codeAdapter.enable(enableInput());
    const settings = readSettings();
    settings.providerInstances.aiand.displayName = "Mine";
    seed(settings);
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, true);
    assert.match((off.notes ?? []).join(" "), /left the aiand instance because you edited it/);
    const after = readSettings();
    assert.equal(after.theme, "dark");
    const instance = after.providerInstances.aiand;
    assert.equal(instance.displayName, "Mine", "the user's edit stays");
    const names = instance.environment.map((row) => row.name);
    assert.ok(!names.includes("AIAND_MANAGED"), "our marker goes");
    assert.ok(!names.includes("ANTHROPIC_AUTH_TOKEN"), "our token entry goes");
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
  });

  test("a re-on over our own instance unwinds both ons in one off", async () => {
    const original = `{
  // the user's own comment
  "theme": "dark"
}
`;
    seed(original);
    await t3codeAdapter.enable(enableInput());
    await t3codeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    // off unwinds to the pre-on state: the record chains the
    // first on's values, so the user's file comes back
    // byte-identical — not the first on's wiring, and not
    // our second on's.
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, true);
    assert.deepEqual(readFileSync(settingsPath()), Buffer.from(original, "utf8"));
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false, "the session key is gone");
    assert.equal(
      existsSync(addedJsonPath()),
      false,
      "the record is cleared, so a second off has no previous instance",
    );
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });
    // A second off has nothing left to strip.
    assert.equal((await t3codeAdapter.disable()).stripped, false);
  });

  test("a re-on then a hand edit keeps the edited instance minus our marker and token", async () => {
    await t3codeAdapter.enable(enableInput());
    await t3codeAdapter.enable(enableInput({ model: OTHER, pinModel: true }));
    const settings = readSettings();
    settings.providerInstances.aiand.environment.push({
      name: "T3CODE_CUSTOM",
      value: "mine",
      sensitive: false,
    });
    seed(settings);
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, true);
    assert.match((off.notes ?? []).join(" "), /left the aiand instance because you edited it/);
    const after = readSettings();
    const instance = after.providerInstances.aiand;
    assert.equal(instance.displayName, "ai&", "the edited instance stays");
    const names = instance.environment.map((row) => row.name);
    assert.ok(names.includes("T3CODE_CUSTOM"), "the user's extra entry stays");
    assert.ok(!names.includes("AIAND_MANAGED"), "our marker goes");
    assert.ok(!names.includes("ANTHROPIC_AUTH_TOKEN"), "our token entry goes");
    assert.equal(
      after.defaultModelSelection,
      undefined,
      "the first on created the selection, so off removes it",
    );
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
  });

  test("a defaultModelSelection on wrote is deleted again when none pre-existed", async () => {
    seed({ theme: "dark" });
    await t3codeAdapter.enable(enableInput());
    assert.equal(readSettings().defaultModelSelection.instanceId, "aiand");
    await t3codeAdapter.disable();
    const after = readSettings();
    assert.equal(after.defaultModelSelection, undefined);
    assert.equal(after.theme, "dark");
  });

  test("a null defaultModelSelection comes back null, not absent", async () => {
    seed({ theme: "dark", defaultModelSelection: null });
    await t3codeAdapter.enable(enableInput());
    assert.equal(readSettings().defaultModelSelection.instanceId, "aiand");
    await t3codeAdapter.disable();
    const after = readSettings();
    assert.equal(after.defaultModelSelection, null);
    assert.equal(after.theme, "dark");
  });

  test("a defaultModelSelection naming another instance is left alone", async () => {
    seed({ theme: "dark", defaultModelSelection: { instanceId: "codex", model: "gpt-5.1" } });
    await t3codeAdapter.enable(enableInput());
    await t3codeAdapter.disable();
    assert.deepEqual(readSettings().defaultModelSelection, {
      instanceId: "codex",
      model: "gpt-5.1",
    });
  });

  test("an unmarked aiand instance is left in place", async () => {
    seed({
      theme: "dark",
      providerInstances: {
        aiand: {
          driver: "claudeAgent",
          displayName: "ai&",
          environment: [{ name: "ANTHROPIC_BASE_URL", value: "https://foreign.example.com" }],
        },
      },
    });
    const before = readFileSync(settingsPath());
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, false);
    assert.deepEqual(readFileSync(settingsPath()), before);
  });

  test("a lost record still removes the secret and strips our instance", async () => {
    await t3codeAdapter.enable(enableInput());
    // The record is gone (snapshots/t3code deleted): the
    // secret .bin's name is deterministic for our instance
    // and var, so off finds and removes it anyway.
    rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "t3code"), {
      recursive: true,
      force: true,
    });
    const off = await t3codeAdapter.disable();
    assert.equal(off.stripped, true);
    assert.equal(
      existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")),
      false,
      "the secret .bin goes even without the record",
    );
    assert.equal(readSettings().providerInstances, undefined, "our instance is stripped");
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });
  });

  test("a pre-existing empty settings.json comes back empty, mode intact", async () => {
    seed("");
    chmodSync(settingsPath(), 0o640);
    await t3codeAdapter.enable(enableInput());
    await t3codeAdapter.disable();
    assert.equal(existsSync(settingsPath()), true, "the user's empty file is never unlinked");
    assert.equal(readFileSync(settingsPath(), "utf8"), "", "the user's empty bytes come back");
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o640, "the user's mode is handed back");
  });
});

describe("t3code refreshKey", () => {
  test("rewrites only the secret .bin; a same key is an idempotent true", async () => {
    await t3codeAdapter.enable(enableInput());
    const before = readFileSync(settingsPath(), "utf8");
    assert.equal(
      await t3codeAdapter.refreshKey({ apiKey: "sk-test-key" }),
      true,
      "the same key is a no-op that still reports true",
    );
    assert.equal(readFileSync(settingsPath(), "utf8"), before, "settings.json is never touched");
    assert.equal(readFileSync(secretPath("ANTHROPIC_AUTH_TOKEN"), "utf8"), "sk-test-key");

    assert.equal(await t3codeAdapter.refreshKey({ apiKey: "sk-rotated" }), true);
    assert.equal(readFileSync(secretPath("ANTHROPIC_AUTH_TOKEN"), "utf8"), "sk-rotated");
    assert.equal(readFileSync(settingsPath(), "utf8"), before);
    assert.equal(statSync(secretPath("ANTHROPIC_AUTH_TOKEN")).mode & 0o777, 0o600);
  });

  test("a rotation from another key is refused", async () => {
    await t3codeAdapter.enable(enableInput());
    assert.equal(
      await t3codeAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-someone-else" }),
      false,
    );
    assert.equal(readFileSync(secretPath("ANTHROPIC_AUTH_TOKEN"), "utf8"), "sk-test-key");
  });

  test("an unmarked config is not touched", async () => {
    seed({
      theme: "dark",
      providerInstances: {
        aiand: {
          driver: "claudeAgent",
          displayName: "ai&",
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "https://foreign.example.com" },
            { name: "ANTHROPIC_AUTH_TOKEN", value: "their-token" },
          ],
        },
      },
    });
    const before = readFileSync(settingsPath());
    assert.equal(await t3codeAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.deepEqual(readFileSync(settingsPath()), before);
    assert.equal(existsSync(secretPath("ANTHROPIC_AUTH_TOKEN")), false);
  });
});

describe("t3code probe", () => {
  test("active only with our marker; the model comes from defaultModelSelection", async () => {
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });

    // A foreign aiand instance (no marker) is not ours, whatever the selection says.
    seed({
      providerInstances: {
        aiand: {
          driver: "claudeAgent",
          displayName: "ai&",
          environment: [{ name: "ANTHROPIC_BASE_URL", value: "https://api.aiand.com" }],
        },
      },
      defaultModelSelection: { instanceId: "aiand", model: MAIN },
    });
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });

    // A hand-removed marker makes a previously wired instance foreign to
    // enable; re-seed a clean file for the enable path.
    seed({});
    assert.deepEqual(await t3codeAdapter.probe(), { active: false, model: null });

    await t3codeAdapter.enable(enableInput());
    assert.deepEqual(await t3codeAdapter.probe(), { active: true, model: MAIN });

    // Active routing with another instance selected reads no model.
    const settings = readSettings();
    settings.defaultModelSelection = { instanceId: "codex", model: "gpt-5.1" };
    seed(settings);
    assert.deepEqual(await t3codeAdapter.probe(), { active: true, model: null });
  });

  test("a corrupt added.json record falls back to the current file", async () => {
    await t3codeAdapter.enable(enableInput());
    writeFileSync(addedJsonPath(), "{oops");
    // wiredSettingsPath falls back to the current file when the record
    // cannot be read, so status still reports the wired config.
    assert.deepEqual(await t3codeAdapter.probe(), { active: true, model: MAIN });
  });
});
