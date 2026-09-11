import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let dir, home, cfg;
const originalEnv = { ...process.env };

const K1 = "sk-test-sync-key-1";
const K2 = "sk-test-sync-key-2";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-sync-test-"));
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  delete process.env.AIAND_API_KEY;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const { opencodeAdapter } = await import("../dist/agents/opencode.js");
const { rebakeAgentKeys } = await import("../dist/agents/rebake.js");
const { registerAgent, AGENTS } = await import("../dist/agents/registry.js");

// Resolved from the live AIAND_HOME: tests switch homes mid-file and the seed
// must land where the adapter under test actually reads.
const opencodeConfig = () => join(process.env.AIAND_HOME, ".config", "opencode", "opencode.json");

function seedOpencodeConfig(key = K1, model = "m-default") {
  mkdirSync(dirname(opencodeConfig()), { recursive: true });
  writeFileSync(
    opencodeConfig(),
    JSON.stringify({
      provider: { aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: key } } },
      model: `aiand/${model}`,
    }) + "\n"
  );
}

describe("rebakeAgentKeys", () => {
  test("refreshes the opencode key literal, leaves the model ref untouched, skips active-no-refresh adapters, no notes for inactive", async () => {
    // Enable opencode with K1, plus a fixture adapter that is active but
    // persists no refreshable key (the "re-run on" skip path).
    seedOpencodeConfig(K1, "m-default");

    const fixtureTag = "__sync_no_refresh__";
    const fixtureFile = join(home, ".sync-fixture", "state");
    mkdirSync(join(home, ".sync-fixture"), { recursive: true });
    writeFileSync(fixtureFile, "active\n");
    registerAgent({
      id: fixtureTag,
      label: "Sync Fixture",
      bin: fixtureTag,
      install: { command: "", url: "" },
      detect: () => ({ installed: true, path: fixtureFile }),
      managedFiles: () => [fixtureFile],
      probe: async () => ({
        // Active only when the marker lives under the CURRENT home, so the
        // fixture never leaks into tests that switch AIAND_HOME.
        active: existsSync(join(process.env.AIAND_HOME, ".sync-fixture", "state")),
        model: "fixture",
      }),
      enable: async () => ({ model: "fixture", filesWritten: [fixtureFile] }),
      disable: async () => undefined,
    });

    const before = readFileSync(opencodeConfig(), "utf8");

    const notes = await rebakeAgentKeys(K2);

    // opencode key swapped; model ref + unrelated bytes untouched.
    assert.equal(readFileSync(opencodeConfig(), "utf8") !== before, true, "opencode file rewritten");
    const wired = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
    assert.equal(wired.provider.aiand.options.apiKey, K2);
    assert.equal(wired.model, "aiand/m-default", "model ref untouched");

    // opencode refreshed; fixture adapter skipped with the re-run guidance.
    const opencodeNote = notes.find((n) => n.agent === "opencode");
    const skipNote = notes.find((n) => n.agent === fixtureTag);
    assert.equal(opencodeNote?.state, "refreshed");
    assert.equal(skipNote?.state, "skipped");
    assert.match(skipNote.note, /Re-run `aiand __sync_no_refresh__ on`/);

    // No other agent produced a note: the rest of the registry is inactive here.
    for (const adapter of AGENTS) {
      if (adapter.id === "opencode" || adapter.id === fixtureTag) continue;
      assert.equal(notes.some((n) => n.agent === adapter.id), false, `${adapter.id} should have no note (inactive)`);
    }
  });

  test("produces no notes on a fresh home with nothing active", async () => {
    const freshHome = join(dir, "fresh");
    process.env.AIAND_HOME = freshHome;
    mkdirSync(freshHome, { recursive: true });
    const notes = await rebakeAgentKeys(K2);
    assert.deepEqual(notes, []);
  });

  test("is idempotent: a second rebake with the same key leaves files untouched", async () => {
    const freshHome = join(dir, "idempotent");
    process.env.AIAND_HOME = freshHome;
    mkdirSync(freshHome, { recursive: true });
    seedOpencodeConfig(K2, "m-default");

    const first = readFileSync(opencodeConfig(), "utf8");
    const notes = await rebakeAgentKeys(K2);
    assert.equal(notes.some((n) => n.agent === "opencode" && n.state === "refreshed"), true);
    assert.equal(
      readFileSync(opencodeConfig(), "utf8"),
      first,
      "same key is a no-op"
    );

    process.env.AIAND_HOME = home;
  });
});
