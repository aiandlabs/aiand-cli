import assert from "node:assert/strict";
import test from "node:test";
import { PROXY_SUPPORT, proxyNoteForOn } from "../dist/agents/proxy-support.js";
import { AGENTS } from "../dist/agents/registry.js";

const MARKER = "AIAND_PROXY_BRIDGE";

test("every agent has a row of proxy support", () => {
  assert.deepEqual(Object.keys(PROXY_SUPPORT).sort(), AGENTS.map((a) => a.id).sort());
});

test("on says nothing on a network without a bridge", () => {
  for (const adapter of AGENTS) assert.equal(proxyNoteForOn(adapter, {}, MARKER), null);
});

test("behind the bridge, on names the way through for each agent", () => {
  for (const adapter of AGENTS) {
    const note = proxyNoteForOn(adapter, { [MARKER]: "1" }, MARKER);
    assert.ok(note, adapter.id);
    if (PROXY_SUPPORT[adapter.id].viaAiand === "yes") {
      assert.ok(note.includes(`\`aiand ${adapter.id}\``), note);
    } else {
      assert.match(note, /cannot carry its requests/);
    }
  }
});
