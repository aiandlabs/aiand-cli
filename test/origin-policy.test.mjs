// Model-origin exclusion: a profile's exclude-origin setting and
// the org's policy keep excluded models out of every slot, default and menu
// the CLI writes, and fail loudly rather than fall back.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import {
  CLOSED_URL,
  catalogModel,
  cliEnv,
  FAKE_API_KEY,
  harnessEnv,
  plantStub,
  runCli,
  seedCatalogCache,
  withMockGateway,
  withTestEnv,
} from "./helpers.mjs";

let home;
let cfg;
withTestEnv("aiand-origin-policy-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = FAKE_API_KEY;
  process.env.AIAND_BASE_URL = CLOSED_URL;
});

const origin = await import("../dist/agents/origin.js");
const catalog = await import("../dist/agents/catalog.js");
const setup = await import("../dist/agents/setup.js");
const config = await import("../dist/config.js");
const { claudeAdapter } = await import("../dist/agents/claude/adapter.js");
const { copilotAdapter } = await import("../dist/agents/copilot/adapter.js");
const { codexAdapter } = await import("../dist/agents/codex/adapter.js");

const KIMI = "moonshotai/kimi-k3";
const DEEPSEEK = "deepseek-ai/deepseek-v4.1-flash-1017";
const DERIVED = "acme/qwen-finetune";
const MUSE = "meta/muse-spark-open";
const GEMMA = "google/gemma-4-31b-it";
const CN_IDS = [KIMI, DEEPSEEK, DERIVED];

// What /v1/models will return with the origin fields: origins, and slot ranks.
const CATALOG = [
  catalogModel(KIMI, { origins: ["CN"], recommended: { main: 1 } }),
  catalogModel(DEEPSEEK, { origins: ["CN"], recommended: { fast: 1 } }),
  // A US fine-tune of a Chinese base model is Chinese-derived.
  catalogModel(DERIVED, { origins: ["US", "CN"] }),
  catalogModel(MUSE, { origins: ["US"], recommended: { main: 2 } }),
  catalogModel(GEMMA, { origins: ["US"], recommended: { fast: 2 } }),
];
// The same models from a gateway that predates the origin fields.
const OLD_CATALOG = CATALOG.map(({ origins: _o, recommended: _r, ...rest }) => rest);

const CN = origin.makePolicy(["CN"], null);
/** The real adapter, as if its binary were installed. */
const installed = (adapter) => ({
  ...adapter,
  detect: () => ({ installed: true, path: "/bin/x" }),
});
const read = (...parts) => readFileSync(join(home, ...parts), "utf8");
const assertNoExcluded = (text, where) => {
  for (const id of CN_IDS) assert.ok(!text.includes(id), `${where} names ${id}`);
};
const setProfileOrigins = (codes) =>
  config.updateProfile(config.resolveProfile().name, { excludeOrigins: codes });

beforeEach(async () => {
  for (const dir of [".claude", ".copilot", ".codex"]) {
    rmSync(join(home, dir), { recursive: true, force: true });
  }
  rmSync(cfg, { recursive: true, force: true });
  seedCatalogCache(cfg, { models: CATALOG });
  mkdirSync(join(home, ".copilot"), { recursive: true });
});
afterEach(() => {
  delete process.env.AIAND_BASE_URL_OVERRIDE;
});

describe("parseOriginList", () => {
  test("takes ISO codes in any case and separator, sorted and unique", () => {
    assert.deepEqual(origin.parseOriginList("cn"), ["CN"]);
    assert.deepEqual(origin.parseOriginList("ru, cn,CN"), ["CN", "RU"]);
  });

  test("none clears", () => {
    assert.deepEqual(origin.parseOriginList("none"), []);
  });

  test("refuses anything that is not a country code", () => {
    assert.throws(() => origin.parseOriginList("China"), /not a list of country codes/);
    assert.throws(() => origin.parseOriginList(","), /not a list of country codes/);
  });
});

describe("exclusionReason", () => {
  test("matches any country in the lineage, so a derived model is excluded", () => {
    assert.equal(origin.exclusionReason({ origins: ["US", "CN"] }, CN), "origin CN");
    assert.equal(origin.exclusionReason({ origins: ["US"] }, CN), null);
  });

  test("fails closed on a model with no origins, or one not in the catalog", () => {
    assert.equal(origin.exclusionReason({}, CN), "its origin is unknown");
    assert.equal(origin.exclusionReason(undefined, CN), "its origin is unknown");
  });

  test("no policy excludes nothing, origins or not", () => {
    assert.equal(origin.exclusionReason({}, origin.NO_POLICY), null);
  });
});

describe("allowedCatalog", () => {
  test("keeps only models whose whole lineage is allowed", () => {
    assert.deepEqual(
      origin.allowedCatalog(CATALOG, CN).map((model) => model.id),
      [MUSE, GEMMA],
    );
  });

  test("an older gateway with no origin fields fails closed, saying why", () => {
    assert.throws(
      () => origin.allowedCatalog(OLD_CATALOG, CN),
      (error) =>
        /No ai& model is allowed under exclude-origin CN \(profile\)/.test(error.message) &&
        /does not publish model origins/.test(error.hint),
    );
  });

  test("a catalog the policy empties fails, and never falls back", () => {
    const policy = origin.makePolicy(["CN", "US"], null);
    assert.throws(
      () => origin.allowedCatalog(CATALOG, policy),
      (error) => /Every model in the catalog is excluded/.test(error.hint),
    );
  });
});

describe("assertAutoAllowed", () => {
  test("refuses auto when the profile excludes what the org policy does not", () => {
    assert.throws(() => origin.assertAutoAllowed(CN), /--model auto can pick a model from CN/);
  });

  test("allows auto when the org policy covers the profile's list", () => {
    origin.assertAutoAllowed(origin.makePolicy(["CN"], ["CN"]));
    origin.assertAutoAllowed(origin.makePolicy([], ["CN"]));
  });
});

describe("catalog ranks replace the preferred lists", () => {
  test("the main default is the model ranked first among the allowed", () => {
    assert.equal(catalog.resolveDefault(CATALOG), KIMI);
    assert.equal(catalog.resolveDefault(origin.allowedCatalog(CATALOG, CN)), MUSE);
  });

  test("ranks beat the legacy order, which only an older gateway still uses", () => {
    const ranked = [
      catalogModel("zai-org/glm-5.3"),
      catalogModel(MUSE, { recommended: { main: 1 } }),
    ];
    assert.equal(catalog.resolveDefault(ranked), MUSE);
    assert.equal(catalog.resolveDefault(OLD_CATALOG), KIMI);
  });

  test("a model with no rank is never picked over a ranked one", () => {
    assert.equal(origin.recommendedFor(CATALOG, "fast"), DEEPSEEK);
    assert.equal(origin.recommendedFor(origin.allowedCatalog(CATALOG, CN), "fast"), GEMMA);
    assert.equal(origin.recommendedFor([catalogModel(MUSE)], "fast"), undefined);
  });
});

describe("run and chat: resolveEffectiveModel under a policy", () => {
  test("the default is the first-ranked allowed model", async () => {
    assert.equal(await catalog.resolveEffectiveModel(undefined, CLOSED_URL, undefined, CN), MUSE);
  });

  test("an excluded --model, profile model or auto refuses", async () => {
    await assert.rejects(
      () => catalog.resolveEffectiveModel(KIMI, CLOSED_URL, undefined, CN),
      /--model "moonshotai\/kimi-k3" is excluded/,
    );
    await assert.rejects(
      () => catalog.resolveEffectiveModel(undefined, CLOSED_URL, DERIVED, CN),
      /The profile model "acme\/qwen-finetune" is excluded/,
    );
    await assert.rejects(
      () => catalog.resolveEffectiveModel("auto", CLOSED_URL, undefined, CN),
      /--model auto can pick a model from CN/,
    );
  });

  test("an allowed --model passes as-is", async () => {
    assert.equal(await catalog.resolveEffectiveModel(GEMMA, CLOSED_URL, undefined, CN), GEMMA);
  });
});

describe("agentOn under a profile exclude-origin", () => {
  beforeEach(() => setProfileOrigins(["CN"]));

  test("claude: every slot, the startup model and the /model menu are allowed models", async () => {
    const result = await setup.agentOn(installed(claudeAdapter));
    assert.equal(result.model, MUSE);
    const text = read(".claude", "settings.json");
    assertNoExcluded(text, "settings.json");
    const settings = JSON.parse(text);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MUSE);
    assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, GEMMA);
    assert.deepEqual(
      settings.modelPicker.options.map((row) => row.model),
      [MUSE, GEMMA],
    );
  });

  test("claude: a re-on replaces a slot the policy now excludes", async () => {
    await setProfileOrigins(undefined);
    await setup.agentOn(installed(claudeAdapter));
    assert.ok(read(".claude", "settings.json").includes(KIMI));
    await setProfileOrigins(["CN"]);
    await setup.agentOn(installed(claudeAdapter));
    assertNoExcluded(read(".claude", "settings.json"), "settings.json after re-on");
  });

  test("copilot: providers.json's menu and the selected model are allowed models", async () => {
    await setup.agentOn(installed(copilotAdapter));
    const providers = read(".copilot", "providers.json");
    assertNoExcluded(providers, "providers.json");
    assert.deepEqual(
      JSON.parse(providers).models.map((row) => row.id),
      [MUSE, GEMMA],
    );
    assert.equal(JSON.parse(read(".copilot", "settings.json")).model, `aiand/${MUSE}`);
  });

  test("codex: the profile's model is an allowed one", async () => {
    await setup.agentOn(installed(codexAdapter));
    const toml = read(".codex", "aiand.config.toml");
    assertNoExcluded(toml, "aiand.config.toml");
    assert.match(toml, new RegExp(`model = "${MUSE}"`));
  });

  test("an excluded --model refuses before anything is written", async () => {
    await assert.rejects(
      () => setup.agentOn(installed(claudeAdapter), { model: DERIVED }),
      /--model "acme\/qwen-finetune" is excluded by exclude-origin CN \(profile\) \(origin CN\)/,
    );
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  });

  test("an excluded profile model refuses rather than being skipped", async () => {
    await config.updateProfile(config.resolveProfile().name, { model: KIMI });
    try {
      await assert.rejects(
        () => setup.agentOn(installed(claudeAdapter)),
        /The profile model "moonshotai\/kimi-k3" is excluded/,
      );
    } finally {
      await config.updateProfile(config.resolveProfile().name, { model: undefined });
    }
  });

  test("an older gateway with no origins fails closed and writes nothing", async () => {
    seedCatalogCache(cfg, { models: OLD_CATALOG });
    await assert.rejects(
      () => setup.agentOn(installed(claudeAdapter)),
      (error) => /does not publish model origins/.test(error.hint),
    );
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  });
});

describe("the org's policy, with no profile setting", () => {
  test("is read from the authenticated listing `on` already makes, and applied", async () => {
    await withMockGateway(async ({ url }) => {
      const base = `${url}/stub/origin-policy`;
      process.env.AIAND_BASE_URL = base;
      try {
        // No seeded cache for this gateway: the public listing still has CN models.
        await setup.agentOn(installed(claudeAdapter));
        const text = read(".claude", "settings.json");
        assertNoExcluded(text, "settings.json");
        assert.equal(JSON.parse(text).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, GEMMA);
        assert.deepEqual(await origin.cachedOrgPolicy(base, FAKE_API_KEY), ["CN"]);
      } finally {
        process.env.AIAND_BASE_URL = CLOSED_URL;
      }
    });
  });

  test("a cached org policy applies offline", async () => {
    await origin.saveOrgPolicy(CLOSED_URL, FAKE_API_KEY, ["CN"]);
    await setup.agentOn(installed(copilotAdapter));
    assertNoExcluded(read(".copilot", "providers.json"), "providers.json");
  });

  test("a gateway that sends no policy leaves the org unknown, not empty", () => {
    assert.equal(origin.policyFromListing({ object: "list", data: [] }), null);
    assert.deepEqual(origin.policyFromListing({ policy: { exclude_origins: ["cn", "CN", 1] } }), [
      "CN",
    ]);
  });
});

describe("status flags a config that holds an excluded model", () => {
  test("a hand-edited fast slot is named, with why", async () => {
    await setProfileOrigins(["CN"]);
    await setup.agentOn(installed(claudeAdapter));
    const path = join(home, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = DEEPSEEK;
    writeFileSync(path, JSON.stringify(settings));

    const check = await setup.originCheck();
    const result = await setup.agentStatus(claudeAdapter, check);
    assert.deepEqual(result.excluded, [{ model: DEEPSEEK, reason: "origin CN" }]);
    assert.match(
      setup.excludedWarning(result, check.policy),
      /\[claude\] Its config names models excluded by exclude-origin CN \(profile\): deepseek-ai\/deepseek-v4.1-flash-1017 \(origin CN\)\. Run `aiand claude on`/,
    );
  });

  test("copilot's menu rows are checked too", async () => {
    await setProfileOrigins(undefined);
    await setup.agentOn(installed(copilotAdapter));
    await setProfileOrigins(["CN"]);
    const result = await setup.agentStatus(copilotAdapter, await setup.originCheck());
    assert.deepEqual(result.excluded.map((entry) => entry.model).sort(), [...CN_IDS].sort());
  });

  test("a model the check cannot look up is flagged, never passed", async () => {
    await setProfileOrigins(["CN"]);
    await setup.agentOn(installed(codexAdapter));
    rmSync(join(cfg, "model-catalog.json"));
    // CLOSED_URL: the catalog is unreachable, so nothing can be shown to be allowed.
    const result = await setup.agentStatus(codexAdapter, await setup.originCheck());
    assert.deepEqual(result.excluded, [
      { model: MUSE, reason: "its origin could not be checked (catalog unreachable)" },
    ]);
  });

  test("no policy, no check", async () => {
    await setProfileOrigins(undefined);
    assert.equal(await setup.originCheck(), null);
  });
});

describe("run-agent under a profile exclude-origin", () => {
  // Copies the throwaway --settings overlay before the launcher removes it.
  const launch = async (args) => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    plantStub(bin, "claude", `cp "$2" "$AIAND_CAPTURE"\nexit 0`);
    const capture = join(home, "overlay.json");
    rmSync(capture, { force: true });
    const result = await runCli(["run-agent", "claude", ...args], {
      env: {
        ...harnessEnv(),
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: CLOSED_URL,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        AIAND_CAPTURE: capture,
      },
    });
    return { ...result, capture };
  };

  test("claude's session overlay holds only allowed models", async () => {
    await setProfileOrigins(["CN"]);
    const { code, stderr, capture } = await launch(["--", "-p", "hi"]);
    assert.equal(code, 0, stderr);
    const text = readFileSync(capture, "utf8");
    assertNoExcluded(text, "the --settings overlay");
    assert.equal(JSON.parse(text).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, GEMMA);
  });

  test("an excluded --model never launches", async () => {
    await setProfileOrigins(["CN"]);
    const { code, stderr, capture } = await launch(["--model", KIMI]);
    assert.equal(code, 1);
    assert.match(stderr, /is excluded by exclude-origin CN \(profile\)/);
    assert.equal(existsSync(capture), false);
  });
});

describe("aiand config set exclude-origin", () => {
  const env = () => cliEnv({ AIAND_CONFIG_DIR: cfg, AIAND_HOME: home });
  const stored = () =>
    JSON.parse(readFileSync(join(cfg, "config.json"), "utf8")).profiles.default?.excludeOrigins;

  test("stores the codes on the profile, and none clears them", async () => {
    const set = await runCli(["config", "set", "exclude-origin", "cn,ru"], { env: env() });
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Set exclude-origin = CN, RU on profile "default"/);
    assert.deepEqual(stored(), ["CN", "RU"]);

    const shown = await runCli(["config", "--json"], { env: env() });
    assert.deepEqual(JSON.parse(shown.stdout).excludeOrigins, ["CN", "RU"]);

    const cleared = await runCli(["config", "set", "exclude-origin", "none"], { env: env() });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(stored(), undefined);
  });

  test("refuses a value that is not a country code", async () => {
    const result = await runCli(["config", "set", "exclude-origin", "China"], { env: env() });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a list of country codes/);
  });
});
