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
import { join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import {
  enableInput as baseEnableInput,
  catalogModel,
  hermeticPath,
  plantStub,
  withEnv,
  withFetch,
  withTestEnv,
} from "./helpers.mjs";

withTestEnv("aiand-opencode-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.AIAND_API_KEY = "sk-test-123";
  mkdirSync(join(process.env.AIAND_HOME, ".config", "opencode"), { recursive: true });
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
});

const { opencodeAdapter, buildOpencodeConfig } = await import("../dist/agents/opencode/adapter.js");
const { opencodeLaunch, opencodeMajorVersion } = await import("../dist/agents/opencode/version.js");
const { CliError } = await import("../dist/cli/errors.js");
const { snapshotFiles, restoreSnapshot, hasSnapshot } = await import("../dist/agents/snapshot.js");
const { parseJsonc } = await import("../dist/agents/managed-file.js");

beforeEach(() => {
  rmSync(join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode"), {
    recursive: true,
    force: true,
  });
});

const home = () => process.env.AIAND_HOME;
const addedJsonPath = () =>
  join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode", "added.json");
const latestJsonPath = () =>
  join(process.env.AIAND_CONFIG_DIR, "snapshots", "opencode", "latest.json");

const configPath = () => join(home(), ".config", "opencode", "opencode.json");

/** A minimal opencode api.json response the enable() fetch must receive. */
function apiJsonFixture() {
  return {
    opencode: {
      id: "opencode",
      name: "ai&",
      env: ["OPENCODE_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.aiand.com/v1",
      models: {
        "zai-org/glm-5.3": {
          id: "zai-org/glm-5.3",
          name: "GLM 5.3",
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 1, output: 4, cache_read: 0.3 },
          limit: { context: 1048576, output: 32000 },
          modalities: { input: ["text"], output: ["text"] },
        },
        "qwen/qwen3.8-27b": {
          id: "qwen/qwen3.8-27b",
          name: "Qwen3.8-27B",
          attachment: true,
          reasoning: true,
          temperature: true,
          tool_call: true,
          cost: { input: 0.4, output: 3, cache_read: 0.2 },
          limit: { context: 262144, output: 32000 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
  };
}
function okApiJson() {
  const body = apiJsonFixture();
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

const enableInput = (overrides = {}) =>
  baseEnableInput({ apiKey: "sk-enable-1", baseUrl: "https://api.aiand.com", ...overrides });

function readConfigJson() {
  return parseJsonc(readFileSync(configPath(), "utf8"));
}

function ownershipStamp(config) {
  return config?.provider?.aiand?.options?.["x-aiand"];
}

describe("opencode adapter", () => {
  test("id/label/bin/install/managedFiles", () => {
    assert.equal(opencodeAdapter.id, "opencode");
    assert.equal(opencodeAdapter.label, "OpenCode");
    assert.equal(opencodeAdapter.bin, "opencode");
    assert.equal(typeof opencodeAdapter.install.command, "string");
    assert.ok(opencodeAdapter.install.url.length > 0);
    assert.deepEqual(opencodeAdapter.managedFiles(), [configPath()]);
  });

  test("probe(): absent config is inactive with no model", async () => {
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): garbage text is inactive, no throw", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), "not json {{{");
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): active when marked + aiand baseURL matches; model extracted", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
  });

  test("probe(): nested options marker is active without a root key", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
  });

  test("probe(): active with user-owned model ref returns full id", async () => {
    // active routing with a non-aiand model ref still reports it
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "other-provider/some-model",
      }),
    );
    const foreign = await opencodeAdapter.probe();
    assert.equal(foreign.active, true);
    assert.equal(foreign.model, "other-provider/some-model");
  });

  test("probe(): foreign aiand-named provider without our key reads inactive", async () => {
    // Same provider name but no sk- literal: not ours, so `on` snapshots
    // before overwriting it.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1" } },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): staging https baseURL with our key + marker is active", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://staging.example.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
  });

  test("probe(): loopback http baseURL with our key + marker is active", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "http://127.0.0.1:8080/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
  });

  test("enable(): writes aiand provider with literal key + baseURL, roots, no lockdown", async () => {
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );

    const config = readConfigJson();
    const provider = config.provider.aiand;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(provider.name, "ai&");
    assert.equal(provider.options.apiKey, "sk-enable-1");
    assert.equal(provider.options.baseURL, "https://api.aiand.com/v1");
    assert.deepEqual(Object.keys(provider.models).sort(), ["qwen/qwen3.8-27b", "zai-org/glm-5.3"]);
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    assert.equal(config.enabled_providers, undefined);
    assert.equal(config.disabled_providers, undefined);
    assert.equal(config["x-aiand"], undefined);
    assert.equal(ownershipStamp(config), true);
  });

  test("enable(): unreachable api.json falls back to the cached map", async () => {
    // Seed the last-good cache, then fail every fetch: enable must still
    // wire from cache instead of throwing.
    const cachePath = join(process.env.AIAND_CONFIG_DIR, "opencode-api.json");
    const cachedModels = {
      "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" },
    };
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://api.aiand.com",
        models: cachedModels,
      }),
    );
    await withFetch(
      async () => {
        throw new Error("offline");
      },
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    const config = readConfigJson();
    assert.deepEqual(Object.keys(config.provider.aiand.models), ["zai-org/glm-5.3"]);
  });

  test("enable(): api.json without a model map keeps the cached map", async () => {
    // A 200 that carries no opencode.models must not overwrite the last-good
    // cache with {} (nor wire an empty picker).
    const cachePath = join(process.env.AIAND_CONFIG_DIR, "opencode-api.json");
    const cachedModels = { "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" } };
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://api.aiand.com",
        models: cachedModels,
      }),
    );
    await withFetch(
      async () => new Response(JSON.stringify({ opencode: {} }), { status: 200 }),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    assert.deepEqual(Object.keys(readConfigJson().provider.aiand.models), ["zai-org/glm-5.3"]);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).models, cachedModels);
  });

  test("enable(): api.json with an empty model map keeps the cached map", async () => {
    const cachePath = join(process.env.AIAND_CONFIG_DIR, "opencode-api.json");
    const cachedModels = { "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" } };
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://api.aiand.com",
        models: cachedModels,
      }),
    );
    await withFetch(
      async () => new Response(JSON.stringify({ opencode: { models: {} } }), { status: 200 }),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    assert.deepEqual(Object.keys(readConfigJson().provider.aiand.models), ["zai-org/glm-5.3"]);
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).models, cachedModels);
  });

  test("enable(): unreachable api.json with no cache still throws", async () => {
    await withFetch(
      async () => {
        throw new Error("offline");
      },
      async () => {
        await assert.rejects(
          () => opencodeAdapter.enable(enableInput({ baseUrl: "https://no-cache.test" })),
          /Could not reach https:\/\/no-cache\.test: offline/,
        );
      },
    );
  });

  test("enable(): preserves unrelated top-level keys", async () => {
    writeFileSync(configPath(), JSON.stringify({ theme: "system", keybinds: { quit: "q" } }));
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    const config = readConfigJson();
    assert.equal(config.theme, "system");
    assert.deepEqual(config.keybinds, { quit: "q" });
  });

  test("enable(): invalid planted JSON → CliError with delete hint", async () => {
    writeFileSync(configPath(), "{broken");
    await withFetch(
      async () => okApiJson(),
      async () => {
        await assert.rejects(
          opencodeAdapter.enable(enableInput()),
          (error) =>
            error instanceof CliError &&
            /is not valid JSON\./.test(error.message) &&
            /delete it and run aiand opencode on again/.test(error.hint ?? ""),
        );
      },
    );
  });

  test("enable(): repeat on is byte-identical (idempotent)", async () => {
    rmSync(configPath(), { force: true });
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        const first = readFileSync(configPath(), "utf8");
        await opencodeAdapter.enable(enableInput());
        const second = readFileSync(configPath(), "utf8");
        assert.equal(first, second);
      },
    );
  });

  test("disable() strips only our writes, preserves the rest, idempotent, missing no-op", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        theme: "system",
        provider: {
          other: { options: { baseURL: "https://other.example.com" } },
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.equal(config.provider.aiand, undefined);
    assert.deepEqual(config.provider.other, { options: { baseURL: "https://other.example.com" } });
    // No added.json record of a model write: an `aiand/…` root value is the
    // user's (models.dev pick or a previous manual edit), not a prefix we own.
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    assert.equal(config.theme, "system");
    // probe agrees: no key, no routing
    assert.equal((await opencodeAdapter.probe()).active, false);
    // second run changes nothing
    const first = readFileSync(configPath(), "utf8");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), first);
    // missing file is a no-op, never a throw
    rmSync(configPath(), { force: true });
    await opencodeAdapter.disable();
    assert.throws(() => readFileSync(configPath(), "utf8"));
    // garbage file is a no-op, never a throw, bytes untouched
    writeFileSync(configPath(), "{broken");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), "{broken");
  });
  test("probe(): foreign aiand-named provider with sk- key at foreign URL, no marker → inactive", async () => {
    // Finding-2 repro: the old sk- prefix + https check read this active and
    // logout/off deleted the foreign block. The marker gate keeps it inactive.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
        },
        model: "aiand/some-model",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): prod URL without marker reads inactive (marker-only ownership)", async () => {
    // First PR: no shipped users, so ownership is marker-only — a prod URL
    // alone is not enough. Prevents dual-path upgrade debt.
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-test-123" } },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("probe(): marked config with garbage baseURL reads inactive, no throw", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: ":::not-a-url", apiKey: "sk-test-123", "x-aiand": true } },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, false);
    assert.equal(result.model, null);
  });

  test("disable() leaves a foreign aiand-named provider untouched", async () => {
    const foreign = {
      provider: {
        aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
      },
      model: "aiand/some-model",
    };
    writeFileSync(configPath(), JSON.stringify(foreign));
    const before = readFileSync(configPath(), "utf8");
    await opencodeAdapter.disable();
    assert.equal(readFileSync(configPath(), "utf8"), before);
    assert.deepEqual(readConfigJson().provider.aiand.options.apiKey, "sk-foreign-1");
  });

  test("probe(): reads JSONC with comments + trailing commas; enable() preserves keys", async () => {
    writeFileSync(
      configPath(),
      '{\n  // aiand-owned staging config\n  "provider": {\n    "aiand": {\n      "options": {\n        "baseURL": "https://staging.example.com/v1",\n        "apiKey": "sk-test-123",\n        "x-aiand": true,\n      },\n    },\n  },\n  "model": "aiand/zai-org/glm-5.3",\n}\n',
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
    // enable() on a JSONC config succeeds and preserves unrelated keys
    // and comments (surgical insert).
    writeFileSync(
      configPath(),
      '{\n  // user comment\n  "theme": "system",\n  "provider": {},\n}\n',
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    const config = readConfigJson();
    assert.equal(config.theme, "system");
    assert.equal(config.provider.aiand.options.apiKey, "sk-enable-1");
    assert.equal(config["x-aiand"], undefined);
    assert.equal(ownershipStamp(config), true);
    assert.match(readFileSync(configPath(), "utf8"), /user comment/);
  });

  test("refreshKey() leaves a foreign aiand-named provider untouched", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" } },
        },
        model: "aiand/some-model",
      }),
    );
    const before = readFileSync(configPath(), "utf8");
    await opencodeAdapter.refreshKey({ apiKey: "sk-new-1", home: home() });
    assert.equal(readFileSync(configPath(), "utf8"), before);
  });

  test("refreshKey() swaps the key on an owned marked config", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://staging.example.com/v1",
              apiKey: "sk-old-1",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    await opencodeAdapter.refreshKey({ apiKey: "sk-new-1", home: home() });
    const config = readConfigJson();
    assert.equal(config.provider.aiand.options.apiKey, "sk-new-1");
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
  });

  test("enable() throws on a foreign provider.aiand block and leaves the file unchanged", async () => {
    const foreignBlock = {
      options: { baseURL: "https://foreign.example.com/v1", apiKey: "sk-foreign-1" },
    };
    const before = JSON.stringify({
      provider: { aiand: foreignBlock },
      theme: "system",
    });
    writeFileSync(configPath(), before);
    await withFetch(
      async () => okApiJson(),
      async () => {
        await assert.rejects(
          () => opencodeAdapter.enable(enableInput()),
          (error) => error instanceof CliError && /does not manage/.test(error.message),
        );
      },
    );
    assert.equal(readFileSync(configPath(), "utf8"), before);
    assert.equal((await opencodeAdapter.probe()).active, false);
  });

  test("refreshKey() then disable() strips provider (rebake is not a user edit)", async () => {
    rmSync(configPath(), { force: true });
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput({ apiKey: "sk-enable-1" }));
        await opencodeAdapter.refreshKey({ apiKey: "sk-rebaked-2", home: home() });
        const off = await opencodeAdapter.disable();
        assert.equal(off.stripped, true);
        assert.equal(
          off.notes.some((n) => /left provider\.aiand because you edited it/.test(n)),
          false,
        );
        assert.equal(existsSync(configPath()), false);
      },
    );
  });

  test("enable() does not persist apiKey in added.json or latest.json", async () => {
    const apiKey = "sk-enable-1";
    await withFetch(
      async () => okApiJson(),
      async () => {
        await snapshotFiles("opencode", opencodeAdapter.managedFiles());
        await opencodeAdapter.enable(enableInput({ apiKey }));
        const addedRaw = readFileSync(addedJsonPath(), "utf8");
        const latestRaw = readFileSync(latestJsonPath(), "utf8");
        assert.equal(addedRaw.includes(apiKey), false);
        assert.equal(latestRaw.includes(apiKey), false);
        const added = JSON.parse(addedRaw);
        assert.equal(added.providerAiand?.options?.apiKey, undefined);
        assert.equal(JSON.parse(latestRaw).added?.providerAiand?.options?.apiKey, undefined);
      },
    );
  });

  test("refreshKey() does not write apiKey into added.json", async () => {
    const apiKey = "sk-enable-1";
    const rebaked = "sk-rebaked-2";
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput({ apiKey }));
        await opencodeAdapter.refreshKey({ apiKey: rebaked, home: home() });
        const addedRaw = readFileSync(addedJsonPath(), "utf8");
        assert.equal(addedRaw.includes(apiKey), false);
        assert.equal(addedRaw.includes(rebaked), false);
        assert.equal(JSON.parse(addedRaw).providerAiand?.options?.apiKey, undefined);
        assert.equal(readConfigJson().provider.aiand.options.apiKey, rebaked);
      },
    );
  });

  test("disable() leaves provider.aiand when baseURL was hand-edited", async () => {
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        const config = readConfigJson();
        config.provider.aiand.options.baseURL = "https://custom.example.com/v1";
        writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
        const result = await opencodeAdapter.disable();
        const after = readConfigJson();
        assert.equal(after.provider.aiand.options.baseURL, "https://custom.example.com/v1");
        assert.equal(after.provider.aiand.options.apiKey, undefined);
        assert.equal(after["x-aiand"], undefined);
        assert.equal(ownershipStamp(after), undefined);
        assert.ok(
          result.notes.some((note) => /left provider\.aiand because you edited it/.test(note)),
        );
      },
    );
  });

  test("buildOpencodeConfig: persistent shape has no lockdown; session shape opts in", () => {
    const persistent = buildOpencodeConfig({
      apiKey: "sk-x",
      model: "m-1",
      models: { "m-1": { name: "M1" } },
      options: {
        npm: "@ai-sdk/openai-compatible",
        name: "ai&",
        baseURL: "https://api.aiand.com/v1",
      },
    });
    assert.equal(persistent.provider.aiand.options.apiKey, "sk-x");
    assert.equal(persistent.provider.aiand.options.baseURL, "https://api.aiand.com/v1");
    assert.equal(persistent.model, "aiand/m-1");
    assert.equal(persistent.enabled_providers, undefined);
    assert.equal(persistent.disabled_providers, undefined);
    assert.equal(persistent["x-aiand"], undefined);
    assert.equal(ownershipStamp(persistent), true);

    const session = buildOpencodeConfig({
      apiKey: "sk-x",
      model: "m-1",
      models: { "m-1": { name: "M1" } },
      options: {
        npm: "@ai-sdk/openai-compatible",
        name: "ai&",
        baseURL: "https://api.aiand.com/v1",
      },
      lockdown: true,
    });
    assert.deepEqual(session.enabled_providers, ["aiand"]);
    assert.deepEqual(session.disabled_providers, ["opencode"]);
    assert.equal(session["x-aiand"], undefined);
    assert.equal(ownershipStamp(session), true);
  });

  test("enable(): leaves an existing model unpinned; disable() keeps it", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: "system", model: "anthropic/claude-sonnet-4-5" }),
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    const wired = readConfigJson();
    assert.equal(wired.model, "anthropic/claude-sonnet-4-5");
    assert.equal(wired["x-aiand"], undefined);
    assert.equal(ownershipStamp(wired), true);

    await opencodeAdapter.disable();
    const afterOff = readConfigJson();
    assert.equal(afterOff.model, "anthropic/claude-sonnet-4-5");
    assert.equal(afterOff.provider, undefined);
    assert.equal(afterOff.theme, "system");
  });

  test("enable/disable write then remove a Catalog default on an empty model slot", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ theme: "system" }));
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    assert.equal(readConfigJson().model, "aiand/zai-org/glm-5.3");
    await opencodeAdapter.disable();
    const afterOff = readConfigJson();
    assert.equal(afterOff.model, undefined);
    assert.equal(afterOff.theme, "system");
    assert.equal(afterOff.provider, undefined);
  });

  test("enable/disable leave a pre-existing aiand/ model unpinned", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: "system", model: "aiand/some-user-picked" }),
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    const wired = readConfigJson();
    assert.equal(wired.model, "aiand/some-user-picked");
    await opencodeAdapter.disable();
    const afterOff = readConfigJson();
    assert.equal(afterOff.model, "aiand/some-user-picked");
    assert.equal(afterOff.provider, undefined);
    assert.equal(afterOff.theme, "system");
    assert.equal(existsSync(addedJsonPath()), false, "off clears added-state");
  });

  test("enable(): --model overwrites an existing model", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: "system", model: "anthropic/claude-sonnet-4-5" }),
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput({ pinModel: true }));
      },
    );
    const wired = readConfigJson();
    assert.equal(wired.model, "aiand/zai-org/glm-5.3");
    const off = await opencodeAdapter.disable();
    assert.equal(off.stripped, true);
    const afterOff = readConfigJson();
    assert.equal(afterOff.model, "anthropic/claude-sonnet-4-5");
    assert.equal(afterOff.theme, "system");
  });

  test("disable(): leaves a model the user switched away from aiand/", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "openai/gpt-4.1",
      }),
    );
    await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.equal(config.model, "openai/gpt-4.1");
    assert.equal(config.provider, undefined);
  });

  test("disable(): deletes a file we created from nothing", async () => {
    rmSync(configPath(), { force: true });
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    assert.equal(existsSync(configPath()), true);
    await opencodeAdapter.disable();
    assert.equal(existsSync(configPath()), false);
  });

  test("disable(): leaves the user's own provider lists untouched", async () => {
    // `on` never writes enabled_providers (only run-agent's throwaway overlay
    // does), so any list in the persistent file is the user's.
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        theme: "system",
        provider: {
          aiand: {
            options: {
              baseURL: "https://api.aiand.com/v1",
              apiKey: "sk-test-123",
              "x-aiand": true,
            },
          },
        },
        model: "aiand/zai-org/glm-5.3",
        enabled_providers: ["aiand", "anthropic"],
      }),
    );
    await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.deepEqual(config.enabled_providers, ["aiand", "anthropic"]);
    assert.equal(config.provider, undefined);
  });

  test("off restores the user's model after a re-on without --model", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ model: "anthropic/claude-sonnet-4-5", theme: "system" }),
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput({ pinModel: true }));
        // re-on without --model keeps our model; off must still restore
        // the user's original, not drop the model entirely.
        await opencodeAdapter.enable(enableInput());
      },
    );
    await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.equal(config.model, "anthropic/claude-sonnet-4-5");
    assert.equal(config.theme, "system");
  });

  test("disable(): never unlinks a pre-existing empty config file", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), "");
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
      },
    );
    await opencodeAdapter.disable();
    assert.equal(existsSync(configPath()), true, "user-created empty file must survive off");
  });

  test("enable(): --model native leaves their model unpinned", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ model: "anthropic/claude-sonnet-4-5", theme: "system" }),
    );
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput({ model: "native" }));
      },
    );
    const config = readConfigJson();
    assert.equal(config.model, "anthropic/claude-sonnet-4-5");
    assert.equal(config.provider.aiand.options.apiKey, "sk-enable-1");
    await opencodeAdapter.disable();
    const afterOff = readConfigJson();
    assert.equal(afterOff.model, "anthropic/claude-sonnet-4-5");
    assert.equal(afterOff.provider, undefined);
  });

  test("enable(): provider null throws notValidJsonError before jsoncSet", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ provider: null }));
    await withFetch(
      async () => okApiJson(),
      async () => {
        await assert.rejects(
          () => opencodeAdapter.enable(enableInput()),
          (error) =>
            error instanceof CliError &&
            /is not valid JSON\./.test(error.message) &&
            !/SyntaxError/.test(error.message) &&
            error.stack !== error.message,
        );
      },
    );
  });

  test("enable(): top-level array throws notValidJsonError before jsoncSet", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), "[]");
    await withFetch(
      async () => okApiJson(),
      async () => {
        await assert.rejects(
          () => opencodeAdapter.enable(enableInput()),
          (error) =>
            error instanceof CliError &&
            /is not valid JSON\./.test(error.message) &&
            !/SyntaxError/.test(error.message) &&
            error.stack !== error.message,
        );
      },
    );
  });

  test("enable(): locks the file to 0600 while the key is baked; disable() restores the user's mode", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), '{"theme":"system"}\n');
    chmodSync(configPath(), 0o644);
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        assert.equal(statSync(configPath()).mode & 0o777, 0o600);
        // Re-on must not record 0600 as the user's original mode.
        await opencodeAdapter.enable(enableInput());
        assert.equal(statSync(configPath()).mode & 0o777, 0o600);
        await opencodeAdapter.disable();
      },
    );
    assert.equal(statSync(configPath()).mode & 0o777, 0o644);
  });

  test("after off, a chmod then on→off restores the post-off mode", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), '{"theme":"system"}\n');
    chmodSync(configPath(), 0o644);
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        await opencodeAdapter.disable();
        assert.equal(statSync(configPath()).mode & 0o777, 0o644);
        assert.equal(existsSync(addedJsonPath()), false);
        chmodSync(configPath(), 0o755);
        await opencodeAdapter.enable(enableInput());
        assert.equal(statSync(configPath()).mode & 0o777, 0o600);
        await opencodeAdapter.disable();
      },
    );
    assert.equal(statSync(configPath()).mode & 0o777, 0o755);
  });

  test("enable(): re-on with unchanged bytes re-tightens a loosened file to 0600", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    rmSync(configPath(), { force: true });
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        assert.equal(statSync(configPath()).mode & 0o777, 0o600);
        const first = readFileSync(configPath(), "utf8");
        // Loosen the file behind our back; the re-on writes identical bytes
        // but must still re-tighten while the Session key is baked.
        chmodSync(configPath(), 0o644);
        const result = await opencodeAdapter.enable(enableInput());
        assert.equal(result.model, "aiand/zai-org/glm-5.3");
        assert.equal(readFileSync(configPath(), "utf8"), first);
        assert.equal(statSync(configPath()).mode & 0o777, 0o600);
        // AddedState still recorded on the repeat on.
        const added = JSON.parse(readFileSync(addedJsonPath(), "utf8"));
        assert.equal(added.model, "aiand/zai-org/glm-5.3");
      },
    );
  });

  test("enable() then disable() on a BOM'd config: no crash, key stripped", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), '\uFEFF{"theme":"system"}\n');
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        assert.equal(readConfigJson()["x-aiand"], undefined);
        assert.equal(ownershipStamp(readConfigJson()), true);
        assert.equal(readConfigJson().provider.aiand.options.apiKey, "sk-enable-1");
        const result = await opencodeAdapter.disable();
        assert.equal(result.stripped, true);
      },
    );
    assert.equal(readConfigJson()["x-aiand"], undefined);
    assert.equal(readConfigJson().provider, undefined);
    assert.equal(readConfigJson().theme, "system");
  });

  test("getApiModels uses trimmed base URL (no double slash)", async () => {
    let fetchedUrl;
    await withFetch(
      async (url) => {
        fetchedUrl = String(url);
        return okApiJson();
      },
      async () => {
        await opencodeAdapter.enable(enableInput({ baseUrl: "https://x/" }));
      },
    );
    assert.equal(fetchedUrl, "https://x/v1/api.json");
  });

  test("enable(): stale api.json cache is not used when fetch fails", async () => {
    const cachePath = join(process.env.AIAND_CONFIG_DIR, "opencode-api.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
        baseUrl: "https://api.aiand.com",
        models: { "stale/model": { id: "stale/model" } },
      }),
    );
    await withFetch(
      async () => {
        throw new Error("offline");
      },
      async () => {
        await assert.rejects(
          () => opencodeAdapter.enable(enableInput()),
          /Could not reach .*: offline/,
        );
      },
    );
  });

  test("enable(): reports full model id for existing user model", async () => {
    writeFileSync(configPath(), JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }));
    await withFetch(
      async () => okApiJson(),
      async () => {
        const result = await opencodeAdapter.enable(enableInput());
        assert.equal(result.model, "anthropic/claude-sonnet-4-5");
        assert.ok(result.warnings.some((w) => /Left your existing model/.test(w)));

        writeFileSync(
          configPath(),
          JSON.stringify({
            model: "aiand/zai-org/glm-5.3",
            provider: {
              aiand: {
                options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-x", "x-aiand": true },
              },
            },
          }),
        );
        const again = await opencodeAdapter.enable(enableInput());
        assert.equal(
          again.warnings.some((w) => /Left your existing model/.test(w)),
          false,
        );
      },
    );
  });

  test("enable() then disable() is byte-identical and keeps comments", async () => {
    const original = `{
  // keep me
  "theme": "dark"
}
`;
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), original);
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        const off = await opencodeAdapter.disable();
        assert.equal(off.stripped, true);
      },
    );
    assert.equal(readFileSync(configPath(), "utf8"), original);
  });

  test("enable() then disable() is byte-identical without a trailing newline", async () => {
    const original = `{\n  "theme": "dark"\n}`;
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), original);
    await withFetch(
      async () => okApiJson(),
      async () => {
        await opencodeAdapter.enable(enableInput());
        const off = await opencodeAdapter.disable();
        assert.equal(off.stripped, true);
      },
    );
    assert.equal(readFileSync(configPath(), "utf8"), original);
  });

  test("probe(): marked config with non-sk- session key is active", async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: { baseURL: "https://api.aiand.com/v1", apiKey: "not-sk", "x-aiand": true },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.probe();
    assert.equal(result.active, true);
    assert.equal(result.model, "aiand/zai-org/glm-5.3");
  });

  test("disable() strips a marked provider.aiand block even when the key is not sk-", async () => {
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        provider: {
          aiand: {
            options: { baseURL: "https://api.aiand.com/v1", apiKey: "not-sk", "x-aiand": true },
          },
        },
        model: "aiand/zai-org/glm-5.3",
      }),
    );
    const result = await opencodeAdapter.disable();
    const config = readConfigJson();
    assert.equal(config.provider, undefined);
    assert.equal(config["x-aiand"], undefined);
    assert.equal(result.stripped, true);
  });
});

describe("opencode sessionLaunch", () => {
  const catalogModels = () => [
    catalogModel("zai-org/glm-5.3", {
      name: "GLM 5.3",
      owned_by: "ai&",
      provider: "zai",
      context_window: 1048576,
      capabilities: ["reasoning", "tool_calling"],
      reasoning_efforts: ["low", "high", "max"],
      reasoning_effort_default: "max",
      input: "1",
      output: "4",
      cached_input_per_1m: "0.3",
    }),
    catalogModel("vision-model", {
      name: "Vision",
      owned_by: "ai&",
      provider: "x",
      context_window: 50000,
      capabilities: ["text", "vision"],
      input: "1",
      output: "1",
    }),
  ];

  test("OPENCODE_CONFIG_CONTENT parses; key via {file:} substitution; default model resolved", async () => {
    // default model: run-agent passes undefined → resolveDefault(catalog)
    const launch = await opencodeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      model: undefined,
      catalog: catalogModels(),
    });
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    // The key must NOT ride in the child env: it goes to a throwaway 0600
    // file referenced by OpenCode's {file:} substitution, unlinked on cleanup.
    assert.match(config.provider.aiand.options.apiKey, /^\{file:.+\}$/);
    const keyFile = config.provider.aiand.options.apiKey.slice("{file:".length, -1);
    assert.equal(readFileSync(keyFile, "utf8"), "sk-launch-1");
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    await launch.cleanup();
    assert.equal(existsSync(keyFile), false);
    assert.equal(config.provider.aiand.options.baseURL, "https://api.aiand.com/v1");
    // model resolved from catalog (first tool-capable / default order)
    assert.match(config.model, /^aiand\//);
    assert.ok(config.model.startsWith("aiand/"));
    assert.deepEqual(config.enabled_providers, ["aiand"]);
    assert.deepEqual(config.disabled_providers, ["opencode"]);
    assert.equal(config["x-aiand"], undefined);
    assert.equal(ownershipStamp(config), true);
  });

  /** Launch with `input`, hand the parsed overlay to `fn`, then clean up the key file. */
  async function withLaunch(input, fn) {
    const launch = await opencodeAdapter.sessionLaunch({
      apiKey: "sk-launch-1",
      catalog: catalogModels(),
      ...input,
    });
    try {
      return await fn(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT));
    } finally {
      await launch.cleanup();
    }
  }

  test("explicit model used when present", async () => {
    await withLaunch({ model: "zai-org/glm-5.3" }, (config) => {
      assert.equal(config.model, "aiand/zai-org/glm-5.3");
    });
  });

  test("entries built from Model[]: cost + limit fields derived", async () => {
    await withLaunch({ model: "zai-org/glm-5.3" }, (config) => {
      const glm = config.provider.aiand.models["zai-org/glm-5.3"];
      assert.equal(glm.reasoning, true);
      assert.deepEqual(glm.reasoning_options, [{ type: "effort", values: ["low", "high", "max"] }]);
      assert.equal(glm.tool_call, true);
      assert.equal(glm.limit.context, 1048576);
      // cost = per-million price from the catalog
      assert.equal(glm.cost.input, 1);
      assert.equal(glm.cost.output, 4);
      assert.equal(glm.cost.cache_read, 0.3);
      // vision model gets attachment + image modality
      const vision = config.provider.aiand.models["vision-model"];
      assert.equal(vision.attachment, true);
      assert.deepEqual(vision.modalities.input, ["text", "image"]);
      assert.equal(vision.reasoning, false);
      assert.equal(vision.reasoning_options, undefined);
    });
  });
});

describe("opencode snapshot round-trip", () => {
  test("snapshot → enable → restore is byte-identical", async () => {
    const original =
      '{\n  "theme": "system",\n  "keybinds": { "quit": "q" },\n  "unrelated": [1, 2, 3]\n}\n';
    mkdirSync(join(home(), ".config", "opencode"), { recursive: true });
    writeFileSync(configPath(), original);

    const snapshot = await snapshotFiles("opencode", opencodeAdapter.managedFiles());
    assert.ok(snapshot);

    let result;
    await withFetch(
      async () => okApiJson(),
      async () => {
        result = await opencodeAdapter.enable(enableInput());
      },
    );
    assert.equal(result.filesWritten.length, 1);
    assert.notEqual(readFileSync(configPath(), "utf8"), original);

    const restored = await restoreSnapshot("opencode", opencodeAdapter.managedFiles());
    assert.equal(restored, true);
    assert.equal(readFileSync(configPath(), "utf8"), original);
    assert.equal(await hasSnapshot("opencode"), false);
  });
});

describe("opencode 2 support", () => {
  // A stub `opencode` that answers --version like the given release.
  const withOpencode = async (versionLine, fn, exitCode = 0) => {
    const dir = join(process.env.AIAND_HOME, "..", `oc-bin-${Math.random().toString(36).slice(2)}`);
    plantStub(dir, "opencode", `echo "${versionLine}"\nexit ${exitCode}`);
    try {
      return await withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, fn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // The flag rule measured on @opencode/cli 2.0.29: where `--standalone`
  // parses, and which commands start the background service with the launch
  // env when none is running.
  test("opencodeLaunch places --standalone only for OpenCode 2", () => {
    const project = join(process.env.AIAND_HOME, "..", "oc-project");
    mkdirSync(project, { recursive: true });
    const env = true;
    const noEnv = false;
    const cases = [
      // OpenCode 1, or a version that cannot be read: argv and env as before.
      [null, ["run", "hi"], ["run", "hi"], env],
      [1, ["run", "hi"], ["run", "hi"], env],
      [1, [], [], env],
      [1, ["mcp", "list"], ["mcp", "list"], env],
      // No command: the TUI, flag first.
      [2, [], ["--standalone"], env],
      [2, ["--continue"], ["--standalone", "--continue"], env],
      [2, ["--print-logs"], ["--standalone", "--print-logs"], env],
      [2, ["--prompt", "fix it"], ["--standalone", "--prompt", "fix it"], env],
      [2, ["-s", "ses_1"], ["--standalone", "-s", "ses_1"], env],
      // A directory to open the TUI in.
      [2, [project], ["--standalone", project], env],
      [2, ["."], ["--standalone", "."], env],
      [2, ["--print-logs", "."], ["--standalone", "--print-logs", "."], env],
      // The flag after the command word.
      [2, ["run", "hi"], ["run", "--standalone", "hi"], env],
      [2, ["mini"], ["mini", "--standalone"], env],
      [2, ["stats", "--days", "7"], ["stats", "--standalone", "--days", "7"], env],
      [2, ["api", "GET", "/x"], ["api", "--standalone", "GET", "/x"], env],
      [2, ["models"], ["models", "--standalone"], env],
      [2, ["models", "aiand"], ["models", "--standalone", "aiand"], env],
      [2, ["reload"], ["reload", "--standalone"], env],
      // Leading global flags, with and without a value, before the command.
      [2, ["--print-logs", "run", "hi"], ["--print-logs", "run", "--standalone", "hi"], env],
      [
        2,
        ["--log-level", "debug", "run", "hi"],
        ["--log-level", "debug", "run", "--standalone", "hi"],
        env,
      ],
      [2, ["--log-level=debug", "models"], ["--log-level=debug", "models", "--standalone"], env],
      // auth and session take it only after their own subcommand; with none
      // they print help, so they get no flag and no config.
      [2, ["auth", "list"], ["auth", "list", "--standalone"], env],
      [2, ["session", "list", "-n", "5"], ["session", "list", "--standalone", "-n", "5"], env],
      [
        2,
        ["--print-logs", "session", "list"],
        ["--print-logs", "session", "list", "--standalone"],
        env,
      ],
      [2, ["auth"], ["auth"], noEnv],
      [2, ["session", "--help"], ["session", "--help"], noEnv],
      // Commands that reject the flag run without the config, so they cannot
      // start the background service with it.
      [2, ["mcp", "list"], ["mcp", "list"], noEnv],
      [2, ["plugin", "list"], ["plugin", "list"], noEnv],
      [2, ["debug", "config"], ["debug", "config"], noEnv],
      [2, ["pair"], ["pair"], noEnv],
      [2, ["acp"], ["acp"], noEnv],
      [2, ["service", "status"], ["service", "status"], noEnv],
      [2, ["upgrade", "--major"], ["upgrade", "--major"], noEnv],
      [2, ["update"], ["update"], noEnv],
      [2, ["uninstall"], ["uninstall"], noEnv],
      [2, ["--print-logs", "mcp", "list"], ["--print-logs", "mcp", "list"], noEnv],
      // serve is the server itself, in the foreground: config, no flag.
      [2, ["serve"], ["serve"], env],
      // A word that is neither a known command nor a directory: no config.
      [2, ["frobnicate"], ["frobnicate"], noEnv],
      // The user's own server choice wins.
      [2, ["run", "--standalone", "hi"], ["run", "--standalone", "hi"], env],
      [2, ["run", "--server", "http://x", "hi"], ["run", "--server", "http://x", "hi"], env],
      [2, ["--server=http://x"], ["--server=http://x"], env],
      [3, ["run", "hi"], ["run", "--standalone", "hi"], env],
    ];
    for (const [major, input, args, keepEnv] of cases) {
      assert.deepEqual(
        opencodeLaunch(major, input),
        { args, keepEnv },
        `${major} ${JSON.stringify(input)}`,
      );
    }
  });

  test("opencodeMajorVersion reads OpenCode 2 and 1 version lines", async () => {
    assert.equal(await withOpencode("opencode v2.0.29", () => opencodeMajorVersion()), 2);
    assert.equal(await withOpencode("1.18.32", () => opencodeMajorVersion()), 1);
  });

  test("opencodeMajorVersion is null for a failing, odd or missing binary", async () => {
    assert.equal(await withOpencode("opencode v2.0.29", () => opencodeMajorVersion(), 3), null);
    assert.equal(await withOpencode("not a version", () => opencodeMajorVersion()), null);
    const empty = join(process.env.AIAND_HOME, "..", "oc-empty");
    mkdirSync(empty, { recursive: true });
    assert.equal(
      await withEnv({ PATH: hermeticPath(empty, "/usr/bin", "/bin") }, () =>
        opencodeMajorVersion(),
      ),
      null,
    );
  });

  test("enable(): warns on OpenCode 1, not on OpenCode 2", async () => {
    const warn = /OpenCode 1 is installed\. .*opencode upgrade --major/;
    const v1 = await withOpencode("1.18.32", () => opencodeAdapter.enable(enableInput()));
    assert.ok(
      v1.warnings.some((w) => warn.test(w)),
      JSON.stringify(v1.warnings),
    );
    const v2 = await withOpencode("opencode v2.0.29", () => opencodeAdapter.enable(enableInput()));
    assert.ok(!v2.warnings.some((w) => warn.test(w)), JSON.stringify(v2.warnings));
  });

  test("sessionLaunch(): buildLaunch adds --standalone on OpenCode 2 only", async () => {
    const input = {
      apiKey: "sk-test-123",
      model: "zai-org/glm-5.3",
      profileName: "default",
      catalog: [catalogModel("zai-org/glm-5.3")],
    };
    const v2 = await withOpencode("opencode v2.0.29", () => opencodeAdapter.sessionLaunch(input));
    try {
      assert.deepEqual(v2.buildLaunch(["run", "hi"]), {
        args: ["run", "--standalone", "hi"],
        keepEnv: true,
      });
      assert.deepEqual(v2.buildLaunch(["mcp", "list"]), { args: ["mcp", "list"], keepEnv: false });
    } finally {
      await v2.cleanup();
    }
    const v1 = await withOpencode("1.18.32", () => opencodeAdapter.sessionLaunch(input));
    try {
      assert.deepEqual(v1.buildLaunch(["mcp", "list"]), { args: ["mcp", "list"], keepEnv: true });
    } finally {
      await v1.cleanup();
    }
  });
});
