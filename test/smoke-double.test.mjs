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

  test("serves the default streaming echo with its model and reasoning effort", async (t) => {
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

    const catalogResponse = await fetch(`${baseUrl}/v1/models`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.object, "list");
    assert.equal(catalog.data.length, 1);
    assert.equal(catalog.data[0].id, "zai-org/glm-5.3");

    const completionResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zai-org/glm-5.3", reasoning_effort: "high" }),
    });
    assert.equal(completionResponse.status, 200);
    assert.match(completionResponse.headers.get("content-type"), /^text\/event-stream/);
    const sse = await completionResponse.text();
    assert.ok(sse.includes("echo:zai-org/glm-5.3:effort=high"));
    assert.ok(sse.includes("[DONE]"));

    const rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows, [
      { method: "POST", path: "/v1/chat/completions", model: "zai-org/glm-5.3" },
    ]);
  });

  test("serves a caller-provided catalog as non-streaming JSON and logs its model", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-smoke-double-"));
    const logPath = join(dir, "requests.jsonl");
    const models = ["zai-org/glm-5.3", "other/model"].map((id) => ({ id, name: id }));
    const { child, baseUrl } = await startSmokeDouble(dir, { logPath, models, stream: false });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
      rmSync(dir, { recursive: true, force: true });
    });

    const catalogResponse = await fetch(`${baseUrl}/v1/models`);
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(await catalogResponse.json(), { object: "list", data: models });

    const completionResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "other/model" }),
    });
    assert.equal(completionResponse.status, 200);
    assert.match(completionResponse.headers.get("content-type"), /^application\/json/);
    const completion = await completionResponse.json();
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, "other/model");
    assert.deepEqual(completion.choices, [
      {
        index: 0,
        message: { role: "assistant", content: "echo:other/model" },
        finish_reason: "stop",
      },
    ]);

    const rows = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows, [
      { method: "POST", path: "/v1/chat/completions", model: "other/model" },
    ]);
  });
});
