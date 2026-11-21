// Copilot desktop app adapter: the app's SQLite provider store
// (data.db model_providers / provider_models), plus the quit-guard process
// matcher. The schema is undocumented and reverse-engineered upstream, so
// every assertion here pins the exact columns ai& writes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  catalogModel,
  plantStub,
  plantWindowsTools,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-copilot-app-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  // Relocate the config tree: COPILOT_HOME gates detect()'s GUI-install
  // probe (src), so the absolute host paths (/Applications, LOCALAPPDATA)
  // are never read for this tree. LOCALAPPDATA stays sandboxed as belt and
  // braces for older dists.
  process.env.COPILOT_HOME = join(dir, "copilot-home");
  // Keep win32 detect()'s GUI-install probe inside the sandbox: it reads
  // $LOCALAPPDATA, which a developer's real value would point at a real app.
  process.env.LOCALAPPDATA = join(dir, "localappdata");
  mkdirSync(join(process.env.AIAND_HOME, ".copilot"), { recursive: true });
  mkdirSync(process.env.COPILOT_HOME, { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { copilotAppAdapter, copilotDataDbPath, copilotAppProcessSpec, copilotAppProcessMatches } =
  await import("../dist/agents/copilot-app/adapter.js");

const dbPath = () => join(process.env.COPILOT_HOME, "data.db");
// Windows asks `tasklist.exe` under SystemRoot, not a PATH stub: a fake root whose tasklist lists the app.
const runningAppSystemRoot = () =>
  plantWindowsTools(join(process.env.AIAND_HOME, "sysroot"), {
    "System32/tasklist.exe": 'process.stdout.write("github.exe\\r\\n");',
  });

// COPILOT_HOME is relocated (withTestEnv), so detect()'s GUI-install probe
// never reads the host's absolute paths (/Applications, LOCALAPPDATA) for
// this tree: installed reads false before the fixture db exists, on every
// platform, regardless of what the host has installed.

beforeEach(() => {
  rmSync(process.env.COPILOT_HOME, { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot-app"), {
    recursive: true,
    force: true,
  });
  mkdirSync(process.env.COPILOT_HOME, { recursive: true });
});

const CATALOG = [
  catalogModel("zai-org/glm-5.3", { capabilities: ["tools", "vision"] }),
  catalogModel("qwen/qwen3.8-27b", { reasoning_efforts: ["low", "high"] }),
];

const enableInput = (overrides = {}) =>
  baseEnableInput({
    apiKey: "sk-enable-1",
    model: "zai-org/glm-5.3",
    catalog: CATALOG,
    baseUrl: "https://api.aiand.com",
    ...overrides,
  });

/** Create the app's BYOK tables exactly as the live app (v1.1.x) has them. */
function createAppDb(path = dbPath()) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS "accounts" (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "model_providers" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      type TEXT NOT NULL DEFAULT 'openai',
      settings_json TEXT NOT NULL DEFAULT '{}',
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "provider_models" (
      id TEXT PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL REFERENCES "model_providers"(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      wire_model TEXT,
      display_name TEXT NOT NULL,
      max_prompt_tokens INTEGER,
      max_output_tokens INTEGER,
      wire_api_override TEXT CHECK (wire_api_override IS NULL OR wire_api_override IN ('completions','responses')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      supported_reasoning_efforts TEXT,
      UNIQUE (provider_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id);
  `);
  db.close();
  return path;
}

/** Plant a foreign provider row with two models, as the app's own GUI would. */
function seedForeignProvider(path = dbPath()) {
  const db = new DatabaseSync(path);
  db.exec(`
    INSERT INTO model_providers (id, name, type, settings_json) VALUES ('user-1', 'Fireworks', 'openai', '{"baseUrl":"https://api.fireworks.ai/inference/v1"}');
    INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-user-1', 'user-1', 'kimi-k2', 'kimi-k2', 'Kimi K2');
  `);
  db.close();
}

function rows(sql) {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const ourProviders = () => rows("SELECT * FROM model_providers WHERE id LIKE 'aiand-%'");
const ourModels = () =>
  rows("SELECT * FROM provider_models WHERE provider_id LIKE 'aiand-%' ORDER BY model_id");

describe("copilot-app adapter", () => {
  test("id/label/bin/managedFiles/detect", () => {
    assert.equal(copilotAppAdapter.id, "copilot-app");
    assert.equal(copilotAppAdapter.label, "GitHub Copilot app");
    assert.deepEqual(copilotAppAdapter.managedFiles(), []);
    assert.equal(copilotDataDbPath(), dbPath());
    // No db and no app dir in this tree: not installed, on every host
    // (COPILOT_HOME gates the absolute install-dir probes, above).
    assert.equal(copilotAppAdapter.detect().installed, false);
    createAppDb();
    const detected = copilotAppAdapter.detect();
    assert.equal(detected.installed, true);
    assert.equal(detected.path, dbPath());
  });

  test("COPILOT_HOME relocates data.db", () => {
    const original = process.env.COPILOT_HOME;
    const elsewhere = join(process.env.AIAND_HOME, "elsewhere");
    process.env.COPILOT_HOME = elsewhere;
    try {
      assert.equal(copilotDataDbPath(), join(elsewhere, "data.db"));
      assert.deepEqual(copilotAppAdapter.managedFiles(), []);
    } finally {
      process.env.COPILOT_HOME = original;
    }
  });

  test("enable(): refuses when the app never ran (no data.db)", async () => {
    await assert.rejects(
      copilotAppAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("has not created its config database") &&
        error.hint.includes("Open the GitHub Copilot app once"),
    );
    assert.equal(existsSync(dbPath()), false, "never create the app's db shell");
  });

  test("bakedBaseUrl(): reads back the URL `on` baked, and nothing once off", async () => {
    createAppDb();
    assert.equal(await copilotAppAdapter.bakedBaseUrl(), undefined, "nothing wired yet");
    await copilotAppAdapter.enable(enableInput());
    assert.equal(await copilotAppAdapter.bakedBaseUrl(), "https://api.aiand.com/v1");
    await copilotAppAdapter.disable();
    assert.equal(await copilotAppAdapter.bakedBaseUrl(), undefined, "off: nothing baked");
  });

  test("enable(): inserts the provider row and every catalog model", async () => {
    createAppDb();
    seedForeignProvider();
    const result = await copilotAppAdapter.enable(enableInput());
    assert.deepEqual(result.filesWritten, [dbPath()]);
    assert.equal(result.model, "zai-org/glm-5.3");

    const providers = ourProviders();
    assert.equal(providers.length, 1);
    const provider = providers[0];
    assert.match(provider.id, /^aiand-/);
    assert.equal(provider.name, "ai&");
    assert.equal(provider.type, "openai");
    assert.equal(provider.account_id, null);
    const settings = JSON.parse(provider.settings_json);
    assert.equal(settings.authKind, "none");
    assert.equal(settings.baseUrl, "https://api.aiand.com/v1");
    assert.equal(settings.wireApi, "completions");
    assert.deepEqual(JSON.parse(settings.headersJson), {
      Authorization: "Bearer sk-enable-1",
    });

    const models = ourModels();
    assert.deepEqual(
      models.map((row) => row.model_id),
      ["qwen/qwen3.8-27b", "zai-org/glm-5.3"],
    );
    const glm = models.find((row) => row.model_id === "zai-org/glm-5.3");
    assert.equal(glm.wire_model, "zai-org/glm-5.3");
    assert.equal(glm.display_name, "zai-org/glm-5.3");
    assert.equal(glm.max_prompt_tokens, 128000 - 32768);
    assert.equal(glm.max_output_tokens, 32768, "the published output cap, not the context window");
    assert.equal(glm.wire_api_override, "completions");
    assert.deepEqual(JSON.parse(glm.supported_reasoning_efforts), []);
    const qwen = models.find((row) => row.model_id === "qwen/qwen3.8-27b");
    assert.deepEqual(JSON.parse(qwen.supported_reasoning_efforts), ["low", "high"]);

    assert.equal(rows("SELECT * FROM model_providers").length, 2, "foreign provider survives");
  });

  test("enable(): splits each context window so prompt plus output fits", async () => {
    createAppDb();
    const catalog = [
      catalogModel("motif-technologies/motif-3", {
        context_window: 262144,
        max_output_tokens: 262144,
      }),
      catalogModel("deepseek-ai/deepseek-v4.1-flash-1017", {
        context_window: 1048576,
        max_output_tokens: 384000,
      }),
      catalogModel("zai-org/glm-5.3", { max_output_tokens: null }),
      catalogModel("tiny/model", { context_window: 1, max_output_tokens: 1 }),
      catalogModel("unset/cap", { max_output_tokens: undefined }),
      catalogModel("zero/cap", { max_output_tokens: 0 }),
      catalogModel("negative/cap", { max_output_tokens: -5 }),
    ];
    await copilotAppAdapter.enable(enableInput({ catalog }));
    const budget = Object.fromEntries(
      ourModels().map((row) => [row.model_id, [row.max_prompt_tokens, row.max_output_tokens]]),
    );
    assert.deepEqual(budget["motif-technologies/motif-3"], [131072, 131072]);
    assert.deepEqual(budget["deepseek-ai/deepseek-v4.1-flash-1017"], [664576, 384000]);
    assert.deepEqual(budget["zai-org/glm-5.3"], [128000, null]);
    assert.deepEqual(budget["tiny/model"], [1, null]);
    for (const id of ["unset/cap", "zero/cap", "negative/cap"]) {
      assert.deepEqual(budget[id], [128000, null], id);
    }
  });

  test("enable(): an app without app_state says to pick the model; native says nothing of it", async () => {
    createAppDb();
    const pinned = await copilotAppAdapter.enable(enableInput({ pinModel: true }));
    assert.ok(
      pinned.warnings.some((w) =>
        /New sessions start on Copilot Fusion.*pick zai-org\/glm-5\.3 from ai& in the model menu/.test(
          w,
        ),
      ),
      pinned.warnings.join("\n"),
    );
    assert.equal(pinned.warnings.length, 2, "the Copilot access warning always rides along");
    const native = await copilotAppAdapter.enable(enableInput({ model: "native" }));
    assert.equal(native.warnings.length, 1);
    assert.match(native.warnings[0], /needs Copilot access.*Copilot Free is enough/);
  });

  test("enable(): a re-on reuses the provider id and replaces model rows", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const firstId = ourProviders()[0].id;
    await copilotAppAdapter.enable(enableInput({ apiKey: "sk-enable-2" }));
    const providers = ourProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, firstId, "stored sessions keep resolving");
    assert.deepEqual(
      JSON.parse(providers[0].settings_json).headersJson &&
        JSON.parse(JSON.parse(providers[0].settings_json).headersJson),
      { Authorization: "Bearer sk-enable-2" },
    );
    assert.equal(ourModels().length, CATALOG.length, "no duplicate model rows");
  });

  test("probe(): our row reads active with no model; absent reads inactive", async () => {
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    assert.deepEqual(await copilotAppAdapter.probe(), { active: true, model: null });
  });

  test("probe(): a foreign or unroutable aiand- row never reads active", async () => {
    createAppDb();
    const db = new DatabaseSync(dbPath());
    db.exec(
      `INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-x', 'ai&', 'openai', '{"baseUrl":"ftp://elsewhere.invalid"}')`,
    );
    db.close();
    assert.equal((await copilotAppAdapter.probe()).active, false);
  });

  test("disable(): deletes exactly our rows and keeps the user's", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, true);
    assert.equal(ourProviders().length, 0);
    assert.equal(ourModels().length, 0);
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'user-1'").length, 1);
    assert.equal(rows("SELECT * FROM provider_models WHERE id = 'pm-user-1'").length, 1);
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
  });

  test("disable(): with no row of ours strips nothing", async () => {
    createAppDb();
    seedForeignProvider();
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(rows("SELECT * FROM model_providers").length, 1);
  });

  test("disable(): a missing db is a clean no-op", async () => {
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
  });

  // The `aiand-` prefix is a naming convention,
  // not an ownership proof. off deletes exactly the
  // row `on` created — the recorded row id — so a user-made
  // `aiand-` row and its models are never collateral damage.
  test("disable(): leaves a user-made aiand- row and deletes only ours", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const ourId = ourProviders()[0].id;
    const db = new DatabaseSync(dbPath());
    db.exec(`
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-custom', 'ai&', 'openai', '{"baseUrl":"https://api.user.example/v1"}');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-aiand-custom', 'aiand-custom', 'user-model', 'user-model', 'User Model');
    `);
    db.close();

    const result = await copilotAppAdapter.disable();

    assert.equal(result.stripped, true);
    assert.equal(rows(`SELECT * FROM model_providers WHERE id = '${ourId}'`).length, 0);
    assert.equal(rows(`SELECT * FROM provider_models WHERE provider_id = '${ourId}'`).length, 0);
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'aiand-custom'").length, 1);
    assert.equal(
      rows("SELECT * FROM provider_models WHERE provider_id = 'aiand-custom'").length,
      1,
    );
  });

  // No enable() ran, so no added-state record
  // names either row. Two unclaimed `aiand-` rows of our exact shape
  // are ambiguous, and the ambiguity resolves in the user's favour
  // across the whole verb set: off strips nothing, status reads off,
  // refreshKey writes nothing (a first-match win here would bake our
  // session key into whichever row sorts first — the user's own row).
  test("two unclaimed aiand- rows with no record: off, status, and refreshKey all stand down", async () => {
    createAppDb();
    const db = new DatabaseSync(dbPath());
    db.exec(`
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-one', 'ai&', 'openai', '{"authKind":"none","wireApi":"completions","baseUrl":"https://api.one.example/v1"}');
      INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-two', 'ai&', 'openai', '{"authKind":"none","wireApi":"completions","baseUrl":"https://api.two.example/v1"}');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-one', 'aiand-one', 'm1', 'm1', 'M1');
      INSERT INTO provider_models (id, provider_id, model_id, wire_model, display_name) VALUES ('pm-two', 'aiand-two', 'm2', 'm2', 'M2');
    `);
    db.close();

    const before = readFileSync(dbPath());
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
    assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), false);
    assert.equal(readFileSync(dbPath()).equals(before), true, "nothing written anywhere");
    assert.equal(ourProviders().length, 2);
    assert.equal(ourModels().length, 2);
  });

  // A row of our name and auth shape but a
  // `responses` wire (not what `on` writes) has no record naming
  // it. The old `rowLooksOurs` accepted it (name + authKind only)
  // while `off`'s shape check refused it: status read on forever
  // with nothing to turn off. Both now share one predicate, so the
  // row reads inactive and off leaves it alone.
  test("probe()/disable(): a responses-wire ai& row with no record is not ours", async () => {
    createAppDb();
    const db = new DatabaseSync(dbPath());
    db.exec(
      `INSERT INTO model_providers (id, name, type, settings_json) VALUES ('aiand-resp', 'ai&', 'openai', '{"authKind":"none","wireApi":"responses","baseUrl":"https://api.resp.example/v1"}')`,
    );
    db.close();

    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
    const result = await copilotAppAdapter.disable();
    assert.equal(result.stripped, false);
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'aiand-resp'").length, 1);
  });

  test("refreshKey(): rotates only the bearer inside settings_json", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const before = ourProviders()[0];

    assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-enable-1" }), true);
    assert.equal(
      await copilotAppAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }),
      false,
    );
    assert.equal(
      await copilotAppAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-enable-1" }),
      true,
    );

    const after = ourProviders()[0];
    assert.equal(after.id, before.id);
    assert.deepEqual(JSON.parse(JSON.parse(after.settings_json).headersJson), {
      Authorization: "Bearer sk-new",
    });
    assert.equal(JSON.parse(after.settings_json).baseUrl, "https://api.aiand.com/v1");
    assert.equal(rows("SELECT * FROM model_providers WHERE id = 'user-1'").length, 1);
  });

  // refreshKey writes data.db, so it
  // runs under the same quit-guard as on/off:
  // while the app is "running" (a
  // pgrep/tasklist stub that finds a process) the
  // rotation refuses and the db stays byte-identical.
  test("refreshKey(): refuses while the app is running", async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const stubBin = join(process.env.AIAND_HOME, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    plantStub(stubBin, "tasklist", `printf '%s\\n' "github.exe"\nexit 0`);
    const before = readFileSync(dbPath());
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = [stubBin, originalPath].join(delimiter);
      await withEnv({ SystemRoot: runningAppSystemRoot() }, () =>
        assert.rejects(copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), (error) =>
          error.message.includes("Quit the GitHub Copilot app first"),
        ),
      );
    } finally {
      process.env.PATH = originalPath;
    }
    assert.equal(readFileSync(dbPath()).equals(before), true);
  });

  // The quit-guard asks `pgrep` by bare name. A repo holding its own `pgrep`
  // must not answer for the real one through an empty or `.` PATH entry.
  test("refreshKey(): a pgrep planted in the current directory is not the one asked", {
    skip: process.platform === "win32",
  }, async () => {
    createAppDb();
    seedForeignProvider();
    await copilotAppAdapter.enable(enableInput());
    const stubBin = join(process.env.AIAND_HOME, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    const repo = join(process.env.AIAND_HOME, "planted-repo");
    const marker = join(repo, "planted-ran");
    plantStub(repo, "pgrep", `echo ran > "${marker}"\nexit 1`);
    const originalPath = process.env.PATH;
    const originalCwd = process.cwd();
    try {
      process.chdir(repo);
      for (const entry of ["", ".", "./"]) {
        process.env.PATH = [entry, stubBin, originalPath].join(delimiter);
        await assert.rejects(copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), (error) =>
          error.message.includes("Quit the GitHub Copilot app first"),
        );
        assert.equal(existsSync(marker), false, `planted pgrep ran with PATH entry "${entry}"`);
      }
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    }
  });

  // rebakeAgentKeys calls refreshKey on
  // every adapter, wired or not. With the app running
  // but no aiand- row, the lookup misses and returns
  // false before the quit-guard ever runs — login,
  // config use and token rotation must not demand a
  // quit from a user who never ran `copilot-app on`.
  test("refreshKey(): running app without our row is a silent false", async () => {
    createAppDb();
    seedForeignProvider();
    const stubBin = join(process.env.AIAND_HOME, "stub-bin");
    plantStub(stubBin, "pgrep", `printf '%s\\n' "/opt/GitHub Copilot/GitHub Copilot"\nexit 0`);
    plantStub(stubBin, "tasklist", `printf '%s\\n' "github.exe"\nexit 0`);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = [stubBin, originalPath].join(delimiter);
      await withEnv({ SystemRoot: runningAppSystemRoot() }, async () =>
        assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), false),
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  // A corrupt settings_json must fail
  // loud, not mint a second row beside it.
  test("enable(): a corrupt ai& provider row fails loud instead of adding a second", async () => {
    createAppDb();
    await copilotAppAdapter.enable(enableInput());
    const id = ourProviders()[0].id;
    const db = new DatabaseSync(dbPath());
    db.exec(`UPDATE model_providers SET settings_json = '{not json' WHERE id = '${id}'`);
    db.close();
    await assert.rejects(copilotAppAdapter.enable(enableInput()), (error) =>
      error.message.includes("provider row is corrupt"),
    );
    assert.equal(ourProviders().length, 1, "no second row was minted");
  });

  test("refreshKey(): no row is false", async () => {
    createAppDb();
    assert.equal(await copilotAppAdapter.refreshKey({ apiKey: "sk-new" }), false);
  });

  test("schema drift surfaces as a CliError pointing at the GUI", async () => {
    writeFileSync(dbPath(), "not a sqlite file at all");
    await assert.rejects(
      copilotAppAdapter.enable(enableInput()),
      (error) =>
        error.message.includes("provider database") && error.hint.includes("Model providers"),
    );
  });

  // The app's real process names, verified upstream. The guard must match
  // the desktop app only: its bundled CLI child copilot.exe is
  // image-name-identical to the standalone Copilot CLI binary and must
  // never be blocked for, and /usr/local/bin/copilot is the CLI itself.
  const APP_PROCESSES = {
    darwin: [
      "/Applications/GitHub Copilot.app/Contents/MacOS/GitHub Copilot",
      "/tmp/GitHub Copilot.app/Contents/MacOS/github-copilot-helper",
    ],
    linux: ["/opt/GitHub Copilot/GitHub Copilot --ozone", "/tmp/GitHub Copilot"],
    win32: ["github.exe"],
  };
  const NOT_APP_PROCESSES = {
    darwin: ["/usr/local/bin/copilot -p hi -s", "pgrep -fi GitHub Copilot"],
    linux: ["/usr/bin/copilot", "GitHub Copilot"],
    win32: [
      "C:\\Users\\someone\\.copilot\\sdk\\cli\\1.2.3\\copilot.exe --server --stdio",
      "copilot.exe",
      "github-desktop.exe",
    ],
  };

  test("process guard: matches the app, never the CLI", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const line of APP_PROCESSES[platform]) {
        assert.equal(
          copilotAppProcessMatches(copilotAppProcessSpec, platform, line),
          true,
          `${platform}: ${line}`,
        );
      }
      for (const line of NOT_APP_PROCESSES[platform]) {
        assert.equal(
          copilotAppProcessMatches(copilotAppProcessSpec, platform, line),
          false,
          `${platform}: ${line}`,
        );
      }
    }
  });
});

// New sessions start on the app's selected model, and the app
// needs Copilot access (Free is enough) even when every request goes to ai&.
describe("copilot-app default model and Copilot access", () => {
  const SELECTED = "copilot-selected-model";
  const selected = () => rows(`SELECT value FROM app_state WHERE key = '${SELECTED}'`)[0]?.value;

  /** The live app's (1.4.x) app_state and accounts columns, on top of createAppDb(). */
  function addLiveAppTables({ selection, account } = {}) {
    const db = new DatabaseSync(dbPath());
    db.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      ALTER TABLE accounts ADD COLUMN login TEXT NOT NULL DEFAULT '';
      ALTER TABLE accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'github';
      ALTER TABLE accounts ADD COLUMN access_token TEXT;
      ALTER TABLE accounts ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
    `);
    if (selection !== undefined) {
      db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(SELECTED, selection);
    }
    if (account) {
      db.prepare(
        "INSERT INTO accounts (id, login, is_default, kind, access_token, settings_json) VALUES ('acct-1', ?, 1, 'github', 'gho_secret', ?)",
      ).run(account.login, JSON.stringify(account.settings));
    }
    db.close();
  }
  const withAccess = { login: "octo", settings: { copilotAccess: true, copilotAppEnabled: true } };
  const noAccess = { login: "octo", settings: { copilotAccess: false, copilotAppEnabled: false } };

  test("on makes the ai& model the default for new sessions; off puts the old pick back", async () => {
    createAppDb();
    addLiveAppTables({ selection: "auto", account: withAccess });
    const result = await copilotAppAdapter.enable(enableInput());
    const id = ourProviders()[0].id;
    assert.equal(selected(), `${id}/zai-org/glm-5.3`);
    assert.deepEqual(result.warnings, [
      "New sessions in the app start on zai-org/glm-5.3; sessions you already have keep their model.",
    ]);
    assert.deepEqual(await copilotAppAdapter.probe(), { active: true, model: "zai-org/glm-5.3" });

    // A re-on with another model moves the default, and off still restores the first pick.
    await copilotAppAdapter.enable(enableInput({ model: "qwen/qwen3.8-27b", pinModel: true }));
    assert.equal(selected(), `${id}/qwen/qwen3.8-27b`);
    await copilotAppAdapter.disable();
    assert.equal(selected(), "auto");
  });

  test("off removes the selection when the app had none, and leaves one the user changed", async () => {
    createAppDb();
    addLiveAppTables({ account: withAccess });
    await copilotAppAdapter.enable(enableInput());
    await copilotAppAdapter.disable();
    assert.equal(selected(), undefined);

    await copilotAppAdapter.enable(enableInput());
    const db = new DatabaseSync(dbPath());
    db.prepare("UPDATE app_state SET value = 'auto' WHERE key = ?").run(SELECTED);
    db.close();
    assert.deepEqual(await copilotAppAdapter.probe(), { active: true, model: null });
    await copilotAppAdapter.disable();
    assert.equal(selected(), "auto", "the user's own pick stays");
  });

  test("off clears a stale selection of ours even with the record gone", async () => {
    createAppDb();
    addLiveAppTables({ selection: "auto", account: withAccess });
    await copilotAppAdapter.enable(enableInput());
    rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "copilot-app"), {
      recursive: true,
      force: true,
    });
    assert.equal((await copilotAppAdapter.disable()).stripped, true);
    assert.equal(selected(), undefined, "no record names the old pick; the app falls back itself");
  });

  test("native leaves the app's selection alone", async () => {
    createAppDb();
    addLiveAppTables({ selection: "auto", account: withAccess });
    await copilotAppAdapter.enable(enableInput({ model: "native" }));
    assert.equal(selected(), "auto");
  });

  test("an account with no Copilot access: on and status say so, and that Free is enough", async () => {
    createAppDb();
    addLiveAppTables({ account: noAccess });
    const result = await copilotAppAdapter.enable(enableInput());
    const warning =
      "The GitHub account signed in to the app (octo) has no Copilot access, so the app will not start a session, even on ai&. Turn on Copilot Free (https://github.com/settings/copilot) or get a Copilot seat, then reopen the app.";
    assert.ok(result.warnings.includes(warning), result.warnings.join("\n"));
    const probe = await copilotAppAdapter.probe();
    assert.equal(probe.active, true);
    assert.deepEqual(probe.warnings, [
      "When the app last checked, its GitHub account (octo) had no Copilot access, so it will not start a session, even on ai&. Turn on Copilot Free (https://github.com/settings/copilot) or get a Copilot seat, then reopen the app.",
    ]);
  });

  test("an app with no GitHub account signed in: on and status say to sign in", async () => {
    createAppDb();
    addLiveAppTables();
    const result = await copilotAppAdapter.enable(enableInput());
    assert.ok(
      result.warnings.some((w) =>
        /^Sign in to the app with a GitHub account that has Copilot access/.test(w),
      ),
    );
    assert.match(
      (await copilotAppAdapter.probe()).warnings[0],
      /No GitHub account is signed in to the app/,
    );
  });

  test("status stays quiet about access while off, and the token column is never read", async () => {
    createAppDb();
    addLiveAppTables({ account: noAccess });
    assert.deepEqual(await copilotAppAdapter.probe(), { active: false, model: null });
    await copilotAppAdapter.enable(enableInput());
    const out = JSON.stringify([
      await copilotAppAdapter.probe(),
      await copilotAppAdapter.disable(),
    ]);
    assert.doesNotMatch(out, /gho_secret/);
  });

  test("an unparsable account row reads as unknown access, never a failure", async () => {
    createAppDb();
    addLiveAppTables();
    const db = new DatabaseSync(dbPath());
    db.exec(
      "INSERT INTO accounts (id, login, is_default, kind, settings_json) VALUES ('a', 'octo', 1, 'github', '{not json')",
    );
    db.close();
    const result = await copilotAppAdapter.enable(enableInput());
    assert.ok(result.warnings.some((w) => /needs Copilot access.*Copilot Free is enough/.test(w)));
    assert.equal((await copilotAppAdapter.probe()).warnings, undefined);
  });
});

describe("copilot-app db hygiene", () => {
  test("enable/disable on an unreadable db fail as CliError, never a stack", {
    skip: process.platform === "win32" && "chmod 000 does not make a file unreadable on Windows",
  }, async () => {
    createAppDb();
    chmodSync(dbPath(), 0o000);
    try {
      await assert.rejects(copilotAppAdapter.enable(enableInput()), (error) =>
        error.message.includes("Could not open the Copilot app's provider database"),
      );
      await assert.rejects(copilotAppAdapter.disable(), (error) =>
        error.message.includes("Could not open the Copilot app's provider database"),
      );
    } finally {
      chmodSync(dbPath(), 0o644);
    }
  });

  test("off leaves the session key unrecoverable in the db file", async () => {
    createAppDb();
    seedForeignProvider();
    const input = enableInput();
    await copilotAppAdapter.enable(input);
    assert.equal(readFileSync(dbPath()).includes(input.apiKey), true, "key baked while on");
    await copilotAppAdapter.disable();
    // A DELETE alone leaves the old settings_json bytes readable in freed
    // pages; off must rewrite the file so the key is gone from the bytes.
    assert.equal(readFileSync(dbPath()).includes(input.apiKey), false);
  });
});
