import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { stdinLooksPiped } from "../dist/cli/stdin.js";
import { readSecret, readLineVisible, confirm } from "../dist/cli/prompt.js";
import { PassThrough } from "node:stream";
import { KEY } from "../dist/cli/select.js";
import { CliError } from "../dist/cli/errors.js";

// Piped stdin reaches the CLI however the parent provides it: real shells
// hand over a FIFO, redirections a file — and Node's child_process hands over
// an AF_UNIX socketpair, which fstat reports as neither. readStdin() must
// accept all three, or piped context from a Node parent is silently dropped
// (`run` answers without it, `login --with-token` dies asking for a pipe).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "index.js");

function childEnv(dir) {
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  delete env.AIAND_PROFILE;
  env.AIAND_HOME = join(dir, "home");
  env.AIAND_CONFIG_DIR = join(dir, "cfg");
  env.NO_UPDATE_CHECK = "1";
  env.CI = "1";
  return env;
}

// Spawn like a Node parent would: async pipes. On POSIX the stdin pipe is a
// socket, which is exactly the shape hasPipedInput() used to reject.
function runCli(args, { env, input, stdinFd } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = stdinFd !== undefined ? [stdinFd, "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdinFd === undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

describe("piped stdin across stdio shapes", () => {
  test("socket stdin (Node-spawned pipe) reaches the prompt", async () => {
    // No positionals: the prompt can only come from stdin. Exit 2
    // (NotLoggedInError, before any network) proves buildPrompt() saw it;
    // exit 1 "No prompt given." would prove it was dropped.
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["run"], { env: childEnv(dir), input: "piped marker" });
      assert.equal(r.code, 2, `expected NotLoggedIn, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /Not logged in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file-redirected stdin reaches the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    const marker = join(dir, "prompt.txt");
    writeFileSync(marker, "piped marker");
    const fd = openSync(marker, "r");
    try {
      const r = await runCli(["run"], { env: childEnv(dir), stdinFd: fd });
      assert.equal(r.code, 2, `expected NotLoggedIn, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /Not logged in/);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no stdin still refuses with a usage error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["run"], {
        env: childEnv(dir),
        input: "",
      });
      // Empty input closes immediately: readStdin sees no text.
      assert.equal(r.code, 1, `expected usage error, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /No prompt given/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("login --with-token rejects leftover stdin lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-stdin-test-"));
    try {
      const r = await runCli(["login", "--with-token"], {
        env: childEnv(dir),
        input: "sk-abc123\nleftover line\n",
      });
      assert.equal(r.code, 1, `expected leftover reject, got ${r.code}: ${r.stderr}`);
      assert.match(r.stderr, /single-line key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stdinLooksPiped", () => {
  const stats = (overrides = {}) => ({
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    mode: 0,
    ...overrides,
  });

  test("TTY is never piped, even for a FIFO", () => {
    assert.equal(stdinLooksPiped(stats({ isFIFO: () => true }), true), false);
  });

  test("FIFO is piped", () => {
    assert.equal(stdinLooksPiped(stats({ isFIFO: () => true }), false), true);
  });

  test("file is piped", () => {
    assert.equal(stdinLooksPiped(stats({ isFile: () => true }), false), true);
  });

  test("socket is piped", () => {
    assert.equal(stdinLooksPiped(stats({ isSocket: () => true }), false), true);
  });

  test("Windows anonymous pipe (mode 4096, type checks false) is piped", () => {
    assert.equal(stdinLooksPiped(stats({ mode: 4096 }), false), true);
  });

  test("unknown with mode 0 is not piped", () => {
    assert.equal(stdinLooksPiped(stats({ mode: 0 }), false), false);
  });

  test("regular-file mode bits without isFile are not piped", () => {
    assert.equal(stdinLooksPiped(stats({ mode: 0o100666 }), undefined), false);
  });
});

class FakeSecretInput extends EventEmitter {
  constructor() {
    super();
    this.raw = false;
  }
  get isTTY() {
    return true;
  }
  setRawMode(mode) {
    this.raw = mode;
  }
  resume() {}
  pause() {}
  setEncoding() {}
  send(chunk) {
    this.emit("data", chunk);
  }
}

class FakeSecretOutput {
  constructor() {
    this.text = "";
  }
  write(chunk) {
    this.text += chunk;
  }
}

// Raw-mode secret path is Unix-only; Windows uses visible readline input.
describe("readSecret raw mode", { skip: process.platform === "win32" }, () => {
  test("arrow keys add no stars and no key material", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send("a");
    input.send(KEY.UP);
    input.send(KEY.DOWN);
    input.send("b");
    input.send(KEY.ENTER_CR);
    assert.equal(await promise, "ab");
    assert.equal(output.text, "key: **\n");
  });

  test("CSI split across chunks is still swallowed", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send("\x1b");
    input.send("[A");
    input.send("a");
    input.send(KEY.ENTER_CR);
    assert.equal(await promise, "a");
    assert.equal(output.text, "key: *\n");
  });

  test("C0 controls are ignored, paste is one star per char", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send("sk-");
    input.send("\x09\x04"); // Tab + Ctrl-D: not key material
    input.send("abc");
    input.send(KEY.ENTER_CR);
    assert.equal(await promise, "sk-abc");
    assert.equal(output.text, "key: ******\n");
  });

  test("Ctrl-C still rejects with exit 130", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send("a");
    input.send(KEY.CTRL_C);
    await assert.rejects(promise, (error) => {
      assert.equal(error.exitCode, 130);
      return true;
    });
    assert.match(output.text, /\^C\n/);
  });

  test("empty Enter rejects CliError with exit 2, not a generic Error", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send(KEY.ENTER_CR);
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      return true;
    });
    assert.equal(input.raw, false);
  });

  test("stdin end rejects and restores raw mode", async () => {
    const input = new FakeSecretInput();
    const output = new FakeSecretOutput();
    const promise = readSecret("key: ", { input, output });
    input.send("ab");
    input.emit("end");
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /Input ended/);
      return true;
    });
    assert.equal(input.raw, false);
  });
});

describe("readSecret non-TTY", () => {
  test("empty line rejects CliError with exit 2", async () => {
    const input = new PassThrough();
    input.write("\n");
    const output = new FakeSecretOutput();
    await assert.rejects(readSecret("key: ", { input, output }), (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      return true;
    });
  });
});

// Prompt chrome defaults to stderr so `--json` stdout stays pure
// (login --paste --json must not prefix "Paste your ai& API key…" on stdout).
// Human prompts still render — just on stderr.
function captureStdio() {
  const log = { out: [], err: [] };
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = (chunk) => (log.out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (log.err.push(String(chunk)), true);
  return {
    log,
    restore() {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
}

describe("prompt output defaults to stderr", () => {
  test("readSecret raw mode: prompt and mask on stderr, stdout clean", { skip: process.platform === "win32" }, async () => {
    const input = new FakeSecretInput();
    const captured = captureStdio();
    try {
      const promise = readSecret("key: ", { input });
      input.send("ab");
      input.send(KEY.ENTER_CR);
      assert.equal(await promise, "ab");
    } finally {
      captured.restore();
    }
    assert.match(captured.log.err.join(""), /key: /);
    assert.match(captured.log.err.join(""), /\*\*/);
    assert.equal(captured.log.out.join(""), "");
  });

  test("readLineVisible: prompt on stderr, stdout clean", async () => {
    const input = new PassThrough();
    input.write("answer\n");
    const captured = captureStdio();
    let value;
    try {
      value = await readLineVisible("Q: ", { input });
    } finally {
      captured.restore();
    }
    assert.equal(value, "answer");
    assert.match(captured.log.err.join(""), /Q: /);
    assert.equal(captured.log.out.join(""), "");
  });

  test("confirm: prompt on stderr, still answers yes", async () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.write("y\n");
    const captured = captureStdio();
    let value;
    try {
      value = await confirm("Sure?", { input });
    } finally {
      captured.restore();
    }
    assert.equal(value, true);
    assert.match(captured.log.err.join(""), /Sure\?/);
    assert.equal(captured.log.out.join(""), "");
  });
});
