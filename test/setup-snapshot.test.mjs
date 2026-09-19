import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { withTestEnv } from "./helpers.mjs";

let home, cfg;
withTestEnv("aiand-setup-snapshot-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = "https://fixture.test";

  // Seed a fresh catalog cache so agentOn never touches the network.
  const model = (id, price) => ({
    id,
    name: id,
    object: "model",
    created: 1,
    owned_by: "fixture",
    provider: "fixture",
    context_window: 1000,
    capabilities: ["tools"],
    reasoning_efforts: null,
    reasoning_effort_default: null,
    description: null,
    currency: "usd",
    input_per_1m: price,
    output_per_1m: price,
    cached_input_per_1m: null,
  });
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: [model("zai-org/glm-5.3", "1"), model("other/model", "2")],
    })
  );
});

const setup = await import("../dist/agents/setup.js");
const snapshot = await import("../dist/agents/snapshot.js");

// Minimal AgentAdapter (see test/dispatch.test.mjs makeFixture) whose enable
// can throw before or after writing the managed file.
function makeFixture(id, { failBeforeWrite = false, failAfterWrite = false } = {}) {
  const file = () => join(home, `.fixture-${id}`, "config.json");
  return {
    id,
    label: `Fixture ${id}`,
    bin: `fixture-${id}`,
    install: { command: "true", url: "https://example.com/fixture" },
    detect: () => ({ installed: true, path: "/usr/bin/fixture" }),
    managedFiles: () => [file()],
    probe: async () => {
      try {
        const parsed = JSON.parse(readFileSync(file(), "utf8"));
        return { active: parsed.aiand === true, model: parsed.aiand ? parsed.model ?? null : null };
      } catch {
        return { active: false, model: null };
      }
    },
    enable: async (input) => {
      if (failBeforeWrite) throw new Error("boom-before-write");
      mkdirSync(dirname(file()), { recursive: true });
      let current = {};
      try {
        current = JSON.parse(readFileSync(file(), "utf8"));
      } catch {
        // missing file is a first-time on
      }
      writeFileSync(file(), `${JSON.stringify({ ...current, aiand: true, model: input.model })}\n`);
      if (failAfterWrite) throw new Error("boom-after-write");
      return { model: input.model, filesWritten: [file()] };
    },
    disable: async () => ({ stripped: false }),
  };
}

function plantPreAiand(adapter) {
  const [file] = adapter.managedFiles();
  mkdirSync(dirname(file), { recursive: true });
  const original = '{"theme":"dark"}\n';
  writeFileSync(file, original);
  return { file, original };
}

describe("agentOn enable failure", () => {
  test("keeps the fresh snapshot when enable fails after writing, and restore recovers pre-aiand bytes", async () => {
    const adapter = makeFixture("fail-after-write", { failAfterWrite: true });
    const { file, original } = plantPreAiand(adapter);

    await assert.rejects(() => setup.agentOn(adapter), /boom-after-write/);

    assert.equal(await snapshot.hasSnapshot(adapter.id), true);
    assert.equal(await snapshot.restoreSnapshot(adapter.id, adapter.managedFiles()), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });

  test("discards the fresh snapshot when enable fails before writing anything", async () => {
    const adapter = makeFixture("fail-before-write", { failBeforeWrite: true });
    const { file, original } = plantPreAiand(adapter);

    await assert.rejects(() => setup.agentOn(adapter), /boom-before-write/);

    assert.equal(await snapshot.hasSnapshot(adapter.id), false);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

describe("restoreSnapshot atomic write", () => {
  test("restores byte-identical content with and without a trailing newline", async () => {
    const withNewline = join(home, "atomic-with.json");
    const withoutNewline = join(home, "atomic-without.json");
    writeFileSync(withNewline, '{"a":1}\n');
    writeFileSync(withoutNewline, '{"b":2}');

    await snapshot.snapshotFiles("atomic-fixture", [withNewline, withoutNewline]);

    writeFileSync(withNewline, '{"routed":true}\n');
    writeFileSync(withoutNewline, '{"routed":true}');

    assert.equal(
      await snapshot.restoreSnapshot("atomic-fixture", [withNewline, withoutNewline]),
      true
    );
    assert.deepEqual(readFileSync(withNewline), Buffer.from('{"a":1}\n'));
    assert.deepEqual(readFileSync(withoutNewline), Buffer.from('{"b":2}'));
  });
});
