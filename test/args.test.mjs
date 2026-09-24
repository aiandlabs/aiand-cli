import assert from "node:assert/strict";
import test, { describe } from "node:test";

const { parse, float } = await import("../dist/cli/args.js");

describe("float validation", () => {
  test("float rejects Infinity and NaN, accepts finite", () => {
    const argvFor = (raw) =>
      raw.startsWith("-") ? [`--temperature=${raw}`] : ["--temperature", raw];
    for (const raw of ["Infinity", "-Infinity", "NaN"]) {
      const parsed = parse(argvFor(raw), { temperature: { type: "string" } });
      assert.throws(() => float(parsed, "temperature"), /must be a number/);
    }
    for (const [raw, expected] of [
      ["0.5", 0.5],
      ["1", 1],
      ["-3.14", -3.14],
    ]) {
      const parsed = parse(argvFor(raw), { temperature: { type: "string" } });
      assert.equal(float(parsed, "temperature"), expected);
    }
  });
});
