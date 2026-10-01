import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { enableInput as baseEnableInput, catalogModel, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-copilot-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  delete process.env.COPILOT_HOME;
  delete process.env.COPILOT_PROVIDERS_CONFIG;
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { copilotAdapter } = await import("../dist/agents/copilot/adapter.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles } = await import("../dist/agents/snapshot.js");

const GLM = "zai-org/glm-5.3";
const KIMI = "moonshotai/kimi-k3";
const CATALOG = [catalogModel(GLM), catalogModel(KIMI)];

const dir = () => join(process.env.AIAND_HOME, ".copilot");
const providersPath = () => join(dir(), "providers.json");
const settingsPath = () => join(dir(), "settings.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const seed = (path, value) => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const ours = (doc) => doc.providers.find((p) => p.name === "aiand");
const enableInput = (overrides = {}) =>
  baseEnableInput({ catalog: CATALOG, baseUrl: "https://api.aiand.com", ...overrides });

// What agentOn does before enable: the snapshot is what lets off delete a file aiand created.
async function on(overrides) {
  await snapshotFiles("copilot", copilotAdapter.managedFiles());
  return copilotAdapter.enable(enableInput(overrides));
}

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true });
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots"), { recursive: true, force: true });
});

test("on writes a marked provider, every catalog model, and the startup model", async () => {
  const result = await on();
  const doc = readJson(providersPath());
  assert.deepEqual(ours(doc), {
    name: "aiand",
    type: "openai",
    baseUrl: "https://api.aiand.com/v1",
    wireApi: "completions",
    apiKey: "sk-test-key",
    "x-aiand": true,
  });
  assert.deepEqual(
    doc.models.map((m) => `${m.provider}/${m.id}`),
    [`aiand/${GLM}`, `aiand/${KIMI}`],
  );
  assert.equal(statSync(providersPath()).mode & 0o777, 0o600);
  assert.equal(readJson(settingsPath()).model, `aiand/${GLM}`);
  assert.equal(result.catalogModel, GLM);
  assert.deepEqual(await copilotAdapter.probe(), { active: true, model: `aiand/${GLM}` });
});

test("off deletes the files on created", async () => {
  await on();
  const result = await copilotAdapter.disable();
  assert.equal(result.stripped, true);
  assert.equal(existsSync(providersPath()), false);
  assert.equal(existsSync(settingsPath()), false);
  assert.deepEqual(await copilotAdapter.probe(), { active: false, model: null });
});

test("on keeps the user's providers, models, settings and model; off hands them back", async () => {
  const theirProviders = {
    providers: [{ name: "ollama", type: "openai", baseUrl: "http://localhost:11434/v1" }],
    models: [{ provider: "ollama", id: "qwen3" }],
  };
  seed(providersPath(), theirProviders);
  seed(settingsPath(), { model: "gpt-5.4", theme: "dark" });

  const result = await on();
  assert.match(result.warnings.join("\n"), /Left your existing model \(gpt-5\.4\)/);
  const doc = readJson(providersPath());
  assert.deepEqual(doc.providers[0], theirProviders.providers[0]);
  assert.deepEqual(doc.models[0], theirProviders.models[0]);
  assert.deepEqual(readJson(settingsPath()), { model: "gpt-5.4", theme: "dark" });

  await copilotAdapter.disable();
  assert.deepEqual(readJson(providersPath()), theirProviders);
  assert.equal(statSync(providersPath()).mode & 0o777, 0o644);
  assert.deepEqual(readJson(settingsPath()), { model: "gpt-5.4", theme: "dark" });
});

test("--model replaces the user's model and off restores it", async () => {
  seed(settingsPath(), { model: "gpt-5.4" });
  await on({ model: KIMI, pinModel: true });
  assert.equal(readJson(settingsPath()).model, `aiand/${KIMI}`);
  await copilotAdapter.disable();
  assert.deepEqual(readJson(settingsPath()), { model: "gpt-5.4" });
});

test("on replaces a retired ai& model it would otherwise leave", async () => {
  seed(settingsPath(), { model: "aiand/retired/model" });
  await on();
  assert.equal(readJson(settingsPath()).model, `aiand/${GLM}`);
});

test("off removes an ai& model picked in Copilot after on", async () => {
  await on();
  seed(settingsPath(), { model: `aiand/${KIMI}` });
  await copilotAdapter.disable();
  assert.equal(existsSync(settingsPath()), false);
});

test("on refuses an aiand provider it does not manage", async () => {
  seed(providersPath(), {
    providers: [{ name: "aiand", type: "openai", baseUrl: "https://x/v1" }],
  });
  await assert.rejects(copilotAdapter.enable(enableInput()), CliError);
  assert.equal((await copilotAdapter.disable()).stripped, false);
});

test("on refuses providers.json that is not valid JSON", async () => {
  seed(providersPath(), "{ nope");
  await assert.rejects(copilotAdapter.enable(enableInput()), CliError);
});

test("off leaves an edited provider but takes the key and marker", async () => {
  await on();
  const doc = readJson(providersPath());
  ours(doc).baseUrl = "https://my-proxy.example/v1";
  seed(providersPath(), doc);

  const result = await copilotAdapter.disable();
  assert.match(result.notes.join(" "), /because you edited it/);
  const left = ours(readJson(providersPath()));
  assert.equal(left.baseUrl, "https://my-proxy.example/v1");
  assert.equal(left.apiKey, undefined);
  assert.equal(left["x-aiand"], undefined);
});

test("refreshKey swaps the baked key, and only the one it replaced", async () => {
  await on();
  assert.equal(
    await copilotAdapter.refreshKey({ apiKey: "sk-new", previousKey: "sk-other" }),
    false,
  );
  assert.equal(ours(readJson(providersPath())).apiKey, "sk-test-key");
  assert.equal(await copilotAdapter.refreshKey({ apiKey: "sk-new" }), true);
  assert.equal(ours(readJson(providersPath())).apiKey, "sk-new");
  // A rotated key is not a user edit: off still removes everything.
  await copilotAdapter.disable();
  assert.equal(existsSync(providersPath()), false);
});

test("on follows COPILOT_HOME and COPILOT_PROVIDERS_CONFIG", async () => {
  const custom = join(process.env.AIAND_HOME, "elsewhere");
  process.env.COPILOT_HOME = custom;
  process.env.COPILOT_PROVIDERS_CONFIG = join(custom, "byok.json");
  try {
    await on();
    assert.equal(ours(readJson(join(custom, "byok.json"))).name, "aiand");
    assert.equal(readJson(join(custom, "settings.json")).model, `aiand/${GLM}`);
  } finally {
    delete process.env.COPILOT_HOME;
    delete process.env.COPILOT_PROVIDERS_CONFIG;
  }
});

test("sessionLaunch hands Copilot a throwaway providers.json and removes it", async () => {
  const launch = await copilotAdapter.sessionLaunch({
    apiKey: "sk-session",
    model: KIMI,
    profileName: "default",
    catalog: CATALOG,
  });
  const file = launch.env.COPILOT_PROVIDERS_CONFIG;
  assert.equal(launch.env.COPILOT_MODEL, `aiand/${KIMI}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(ours(readJson(file)).apiKey, "sk-session");
  assert.equal(JSON.stringify(launch.env).includes("sk-session"), false);
  await launch.cleanup();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(providersPath()), false);
});
