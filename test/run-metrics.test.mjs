import assert from "node:assert/strict";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, FAKE_API_KEY, runCli, withMockGateway, withTestEnv } from "./helpers.mjs";

// #101: Streaming completion metrics must match non-streaming footers and JSON.
withTestEnv("aiand-run-metrics-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  delete process.env.AIAND_KEY_STORAGE;
  process.env.CI = "1";
});

const cli = (baseUrl, args) =>
  runCli(["run", "-m", "m/run-metrics", ...args, "hi"], {
    env: cliEnv({
      NO_COLOR: "1",
      CI: "1",
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: baseUrl,
    }),
    stdin: "ignore",
  });

const ordinaryFooter = "m/run-metrics  ·  7 in / 2 out  ·  req-run-metrics";
const metricsFooter =
  "m/run-metrics  ·  7 in / 2 out  ·  0.000018 USD  ·  850ms  ·  req-run-metrics";

function assertOrdinaryResult(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Metrics answer\n");
  assert.equal(result.stderr.trim(), ordinaryFooter);
  assert.doesNotMatch(result.stderr, /0\.000018|\busd\b|850ms|Cancelled\./i);
}

describe("run completion metrics (mock gateway)", () => {
  test("default streaming footer matches --no-stream when metrics are available", async () => {
    await withMockGateway(async ({ url }) => {
      const baseUrl = `${url}/stub/run-metrics`;
      const streaming = await cli(baseUrl, []);
      const nonStreaming = await cli(baseUrl, ["--no-stream"]);

      assert.equal(streaming.code, 0);
      assert.equal(nonStreaming.code, 0);
      assert.equal(streaming.stdout, "Metrics answer\n");
      assert.equal(nonStreaming.stdout, "Metrics answer\n");
      assert.equal(streaming.stderr.trim(), metricsFooter);
      assert.equal(nonStreaming.stderr.trim(), metricsFooter);
      assert.ok(
        streaming.stderr.includes("7 in / 2 out  ·  0.000018 USD  ·  850ms"),
        "the footer includes the documented tokens, cost, currency, and inference time",
      );
    });
  });

  test("default streaming prints the ordinary footer when metrics are absent", async () => {
    await withMockGateway(async ({ url }) => {
      const result = await cli(`${url}/stub/run-metrics-none`, []);
      assertOrdinaryResult(result);
    });
  });

  test("default streaming ignores a trailer later than the bounded wait", async () => {
    await withMockGateway(async ({ url }) => {
      const started = Date.now();
      const result = await cli(`${url}/stub/run-metrics-slow`, []);
      const elapsed = Date.now() - started;

      assertOrdinaryResult(result);
      assert.ok(elapsed >= 250, `the command waited for the trailer grace period (${elapsed} ms)`);
      assert.ok(
        elapsed < 1000,
        `the 250 ms grace period ended before the late trailer (${elapsed} ms)`,
      );
    });
  });

  test("default and --no-stream --json expose the same metrics fields", async () => {
    await withMockGateway(async ({ url }) => {
      const baseUrl = `${url}/stub/run-metrics`;
      const streaming = await cli(baseUrl, ["--json"]);
      const nonStreaming = await cli(baseUrl, ["--no-stream", "--json"]);

      assert.equal(streaming.code, 0);
      assert.equal(nonStreaming.code, 0);
      assert.equal(streaming.stderr, "");
      assert.equal(nonStreaming.stderr, "");
      const streamingJson = JSON.parse(streaming.stdout);
      const nonStreamingJson = JSON.parse(nonStreaming.stdout);

      for (const document of [streamingJson, nonStreamingJson]) {
        assert.equal(document.id, "chatcmpl-run-metrics");
        assert.equal(document.created, 1700000000);
        assert.equal(document.model, "m/run-metrics");
        assert.deepEqual(document.choices, [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Metrics answer",
              reasoning_content: "Reasoning.",
            },
            finish_reason: "stop",
          },
        ]);
        assert.deepEqual(document.usage, {
          prompt_tokens: 7,
          completion_tokens: 2,
          total_tokens: 9,
          prompt_tokens_details: { cached_tokens: 0 },
        });
        assert.deepEqual(
          {
            cost: document.cost,
            currency: document.currency,
            inference_ms: document.inference_ms,
          },
          { cost: 0.000018, currency: "usd", inference_ms: 850 },
        );
      }
      assert.deepEqual(streamingJson, nonStreamingJson);
      assert.equal(streaming.stdout, `${JSON.stringify(streamingJson, null, 2)}\n`);
      assert.equal(nonStreaming.stdout, `${JSON.stringify(nonStreamingJson, null, 2)}\n`);
    });
  });
});
