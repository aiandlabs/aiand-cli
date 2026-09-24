import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../dist/cli/errors.js";
import { createKeyParser, KEY, promptCheckbox, promptSelect } from "../dist/cli/select.js";
import { FakeInput, FakeOutput } from "./helpers.mjs";

// --- createKeyParser ---------------------------------------------------------

test("createKeyParser: buffers an arrow split across chunks", () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.push("a\x1b"), ["a"]);
  assert.equal(parser.hasPendingEsc(), true);
  assert.deepEqual(parser.push("[A"), ["\x1b[A"]);
  assert.deepEqual(parser.flush(), []);
});

test("createKeyParser: lone trailing Esc flushes as Esc, printable bytes as-is", () => {
  const parser = createKeyParser();
  assert.deepEqual(parser.push("\x1b"), []);
  assert.equal(parser.hasPendingEsc(), true);
  assert.deepEqual(parser.flush(), ["\x1b"]);
});

// --- promptCheckbox ----------------------------------------------------------

test("promptCheckbox: space toggles, Enter returns selected values", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Which agents?",
    choices: [
      { value: "opencode", label: "OpenCode" },
      { value: "fixture-a", label: "Fixture A" },
      { value: "fixture-b", label: "Fixture B" },
    ],
    input,
    output,
  });
  input.send(" "); // toggle OpenCode
  input.send(KEY.DOWN);
  input.send(" "); // toggle Fixture A
  input.send(" "); // untoggle Fixture A
  input.send(KEY.UP);
  input.send(" "); // toggle OpenCode again? -> already on, turns off
  input.send(KEY.DOWN);
  input.send(KEY.DOWN);
  input.send(" "); // toggle Fixture B
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, ["fixture-b"]);
  assert.match(output.text, /✓.*Which agents\?.*Fixture B/);
});

test("promptCheckbox: empty selection is returnable", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Select",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, []);
});

test("promptCheckbox: initial pre-checks the listed values", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Select",
    choices: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    initial: ["a"],
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.deepEqual(await promise, ["a"]);
});

test("promptCheckbox: non-TTY input throws CliError instead of hanging", async () => {
  const input = new FakeInput({ tty: false });
  await assert.rejects(
    promptCheckbox({ message: "Pick", choices: [{ value: "a", label: "A" }], input }),
    (err) => err && err.name === "CliError",
  );
});

// --- promptSelect ------------------------------------------------------------

test("promptSelect: plain Enter returns the first choice and writes the summary", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [
      { value: "org_1", label: "Acme" },
      { value: "org_2", label: "Globex" },
    ],
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "org_1");
  assert.match(output.text, /✓.*Which org\?.*Acme/);
});

test("promptSelect: DOWN then Enter returns the second choice", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [
      { value: "org_1", label: "Acme" },
      { value: "org_2", label: "Globex" },
    ],
    input,
    output,
  });
  input.send(KEY.DOWN);
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "org_2");
  assert.match(output.text, /✓.*Which org\?.*Globex/);
});

test("promptSelect: Esc returns null", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [{ value: "org_1", label: "Acme" }],
    input,
    output,
  });
  input.send(KEY.ESC);
  assert.equal(await promise, null);
});

test("promptCheckbox: Esc returns null, not an empty selection", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Select",
    choices: [{ value: "a", label: "A" }],
    input,
    output,
  });
  input.send(" ");
  input.send(KEY.ESC);
  assert.equal(await promise, null);
});

test("promptSelect: Ctrl-C rejects with a 130 CliError and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [{ value: "org_1", label: "Acme" }],
    input,
    output,
  });
  input.send(KEY.CTRL_C);
  await assert.rejects(
    promise,
    (error) =>
      error instanceof CliError && error.exitCode === 130 && error.message === "Cancelled.",
  );
  assert.equal(input.raw, false, "raw mode off");
  assert.ok(output.text.includes("\x1b[?25h"), "cursor shown again");
});

test("promptSelect: initial preselects the matching row", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [
      { value: "org_1", label: "Acme" },
      { value: "org_2", label: "Globex" },
    ],
    initial: "org_2",
    input,
    output,
  });
  input.send(KEY.ENTER_CR);
  assert.equal(await promise, "org_2");
});

test("promptSelect: empty choices returns null without prompting", async () => {
  const input = new FakeInput({ tty: false });
  assert.equal(await promptSelect({ message: "Pick", choices: [], input }), null);
});

test("promptCheckbox: empty choices returns [] without prompting", async () => {
  const input = new FakeInput({ tty: false });
  const output = new FakeOutput();
  assert.deepEqual(await promptCheckbox({ message: "Pick", choices: [], input, output }), []);
  assert.equal(input.raw, false);
  assert.equal(output.text, "");
});

test("promptSelect: stdin end rejects and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptSelect({
    message: "Which org?",
    choices: [{ value: "org_1", label: "Acme" }],
    input,
    output,
  });
  queueMicrotask(() => input.end());
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /Input ended/);
    return true;
  });
  assert.equal(input.raw, false);
  assert.match(output.text, /\x1b\[\?25h/);
});

test("promptCheckbox: renders choice hints", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const promise = promptCheckbox({
    message: "Which agents?",
    choices: [{ value: "opencode", label: "OpenCode", hint: "recommended" }],
    input,
    output,
  });
  await Promise.resolve();
  input.send(KEY.ENTER_CR);
  await promise;
  assert.match(output.text, /recommended/);
});
