import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startSmokeDouble } from "../scripts/smoke-double.mjs";

describe("smoke double request log", () => {
  test("records every completion model, including an absent model", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-smoke-double-"));
    const logPath = join(dir, "requests.jsonl");
    const { child, baseUrl } = await startSmokeDouble(dir, { logPath });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      rmSync(dir, { recursive: true, force: true });
    });

    for (const body of [
      { model: "zai-org/glm-5.3" },
      { model: "other/model" },
      { noModel: true },
    ]) {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      await response.text();
    }

    const rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows, [
      { method: "POST", path: "/v1/chat/completions", model: "zai-org/glm-5.3" },
      { method: "POST", path: "/v1/chat/completions", model: "other/model" },
      { method: "POST", path: "/v1/chat/completions", model: null },
    ]);
  });
});
