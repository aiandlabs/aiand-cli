import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CLOSED_URL, makeFixture, seedCatalogCache, withTestEnv } from "./helpers.mjs";

let home;
withTestEnv("aiand-setup-snapshot-", (dir) => {
  home = join(dir, "home");
  const cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = CLOSED_URL;
  // A fresh catalog cache so agentOn never touches the network.
  seedCatalogCache(cfg);
});

const setup = await import("../dist/agents/setup.js");
const snapshot = await import("../dist/agents/snapshot.js");

function plantPreAiand(adapter) {
  const [file] = adapter.managedFiles();
  mkdirSync(dirname(file), { recursive: true });
  const original = '{"theme":"dark"}\n';
  writeFileSync(file, original);
  return { file, original };
}

describe("agentOn enable failure", () => {
  test("keeps the fresh snapshot when enable fails after writing, and restore recovers pre-aiand bytes", async () => {
    const adapter = makeFixture(home, { id: "fail-after-write", failAfterWrite: true });
    const { file, original } = plantPreAiand(adapter);

    await assert.rejects(() => setup.agentOn(adapter), /boom-after-write/);

    assert.equal(await snapshot.hasSnapshot(adapter.id), true);
    assert.equal(await snapshot.restoreSnapshot(adapter.id, adapter.managedFiles()), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });

  test("discards the fresh snapshot when enable fails before writing anything", async () => {
    const adapter = makeFixture(home, { id: "fail-before-write", failBeforeWrite: true });
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
