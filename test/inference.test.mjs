import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { withEnv } from "./helpers.mjs";

const { describeEmptyResponse } = await import("../dist/api/inference.js");
const { ApiError } = await import("../dist/cli/errors.js");

describe("describeEmptyResponse", () => {
  test("prefers the server's own reason when it sends one", () => {
    const message = describeEmptyResponse({
      meta: { emptyCompletion: "reasoning_only" },
      finishReason: "stop",
    });
    assert.match(message, /reasoned/i);
  });

  test("explains a budget exhausted inside reasoning, with no header to go on", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "length",
      usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 40 } },
    });
    assert.match(message, /40 reasoning tokens/);
    assert.match(message, /--max-tokens/);
  });

  test("distinguishes plain truncation from truncation inside reasoning", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "length",
      usage: { completion_tokens: 40 },
    });
    assert.match(message, /token limit/i);
    assert.doesNotMatch(message, /reasoning/i);
  });

  test("explains a model that reasoned then stopped without truncating", () => {
    const message = describeEmptyResponse({
      meta: {},
      finishReason: "stop",
      usage: { completion_tokens_details: { reasoning_tokens: 12 } },
    });
    assert.match(message, /12 tokens/);
  });

  test("always returns something actionable, even with no evidence at all", () => {
    const message = describeEmptyResponse({ meta: {} });
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /undefined|NaN/);
  });
});

describe("SSE reading", () => {
  const originalFetch = globalThis.fetch;

  function stubStream(chunks) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream", "X-Model": "m" } },
      );
  }

  async function collect(chunks) {
    const { streamChatCompletion } = await import("../dist/api/inference.js");
    return withEnv({ AIAND_ALLOW_KEY_TO: "https://example.invalid" }, async () => {
      stubStream(chunks);
      try {
        const { meta, chunks: stream } = await streamChatCompletion(
          {
            profile: { name: "t", apiUrl: "https://example.invalid" },
            token: "sk-x",
            credential: null,
          },
          { model: "m", messages: [] },
        );
        const out = [];
        for await (const c of stream) out.push(c);
        return { meta, out };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("assembles content deltas in order and stops at [DONE]", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ignored" } }] })}\n\n`,
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "Hello");
  });

  test("reassembles an event split across network chunks", async () => {
    const payload = JSON.stringify({ choices: [{ delta: { content: "split" } }] });
    const { out } = await collect([
      `data: ${payload.slice(0, 10)}`,
      `${payload.slice(10)}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "split");
  });

  test("ignores keep-alives and unparseable frames instead of throwing", async () => {
    const { out } = await collect([
      ": keep-alive\n\n",
      "data: {not json\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "ok");
  });

  test("surfaces reasoning deltas separately from content", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "say" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    assert.equal(out.find((c) => c.reasoning)?.reasoning, "think");
    assert.equal(out.find((c) => c.text)?.text, "say");
  });

  test("carries finish_reason and usage off the final frame", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { completion_tokens: 7 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const last = out.at(-1);
    assert.equal(last.finishReason, "length");
    assert.equal(last.usage.completion_tokens, 7);
  });

  test("applies a metrics event after [DONE] to meta without yielding a completion chunk", async () => {
    const { meta, out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ignored" } }] })}\n\n`,
      `event: metrics\ndata: ${JSON.stringify({
        tokens: { input: 7, output: 2, total: 9, cached: 0 },
        cost: 0.000018,
        currency: "usd",
        ttft_ms: 120,
        inference_ms: 850,
      })}\n\n`,
    ]);

    assert.deepEqual(
      out.map((chunk) => chunk.text),
      ["answer"],
    );
    assert.equal(meta.cost, "0.000018");
    assert.equal(meta.costCurrency, "usd");
    assert.equal(meta.inferenceMs, 850);
  });

  test("reads the resolved model from headers, available before the body", async () => {
    const { meta } = await collect(["data: [DONE]\n\n"]);
    assert.equal(meta.model, "m");
  });

  test("tolerates CRLF line endings", async () => {
    const { out } = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ]);
    assert.equal(out.map((c) => c.text ?? "").join(""), "crlf");
  });

  const cap = 1024 * 1024;
  const frame = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;

  test("cuts off a line over 1 MiB however the network splits it", async () => {
    const body = `${frame("x".repeat(cap + 1 - frame("").length))}\n\ndata: [DONE]\n\n`;
    const end = body.indexOf("\n");
    // Whole in one read, cut at the cap, and cut just before the newline.
    for (const cut of [end + 1, cap, end]) {
      const error = await collect([body.slice(0, cut), body.slice(cut)]).then(
        () => assert.fail(`accepted with a cut at ${cut}`),
        (e) => e,
      );
      assert.ok(error instanceof ApiError, `cut at ${cut}`);
      assert.equal(error.status, 502);
      assert.match(error.message, /over 1 MiB/);
    }
  });

  test("still reads a line of exactly 1 MiB, however it is split", async () => {
    const text = "x".repeat(cap - frame("").length);
    const body = `${frame(text)}\n\ndata: [DONE]\n\n`;
    const end = body.indexOf("\n");
    for (const cut of [end + 1, end]) {
      const { out } = await collect([body.slice(0, cut), body.slice(cut)]);
      assert.equal(out[0].text, text, `cut at ${cut}`);
    }
  });

  test("caps metrics and ignored lines after [DONE] across read boundaries", async () => {
    const metrics = 'data: {"cost":0.25,"currency":"usd","inference_ms":42}';
    for (const line of [metrics, frame("ignored"), ": keep-alive", "event: metrics"]) {
      const prefix = "data: [DONE]\n\nevent: metrics\n";
      const body = `${prefix}${line.padEnd(cap + 1)}\n\n`;
      for (const cut of [1, prefix.length, prefix.length + cap, body.length - 2, body.length]) {
        await assert.rejects(collect([body.slice(0, cut), body.slice(cut)]), (error) => {
          assert.ok(error instanceof ApiError, `${line}, cut at ${cut}`);
          assert.equal(error.status, 502);
          assert.match(error.message, /over 1 MiB/);
          return true;
        });
      }
    }
  });

  test("accepts exact-cap post-[DONE] lines and applies the split metrics trailer", async () => {
    const metrics = 'data: {"cost":0.25,"currency":"usd","inference_ms":42}';
    const prefix = `${frame("answer")}\n\ndata: [DONE]\n\n`;
    const ignored = `${frame("ignored").padEnd(cap)}\n\n`;
    const trailer = `event: metrics\n${metrics.padEnd(cap)}\n\n`;
    const body = prefix + ignored + trailer;
    for (const chunks of [
      [body],
      [prefix, ignored, trailer],
      [prefix.slice(0, -4), prefix.slice(-4) + ignored.slice(0, cap), ignored.slice(cap), trailer],
      [prefix + ignored, trailer.slice(0, -2), trailer.slice(-2)],
    ]) {
      const { meta, out } = await collect(chunks);
      assert.deepEqual(
        out.map((chunk) => chunk.text),
        ["answer"],
      );
      assert.equal(meta.cost, "0.25");
      assert.equal(meta.costCurrency, "usd");
      assert.equal(meta.inferenceMs, 42);
    }
  });
});
