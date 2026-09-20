import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { withTestEnv } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

const { run } = await import("../dist/commands/run-agent.js");

// --- Stub-agent scaffolding ------------------------------------------------
// A temp bin dir holds shell stub scripts (chmod 0755) that dump the child
// env + argv to capture files and exit 42. The catalog cache is seeded so
// getCatalog never touches the network.

const STUB_SCRIPT = `#!/bin/sh
env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42
`;

let home, cfg, binDir;
let stubCli;

function model(id) {
  return {
    id,
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
    input_per_1m: "1",
    output_per_1m: "1",
    cached_input_per_1m: null,
  };
}

function plantStub(name) {
  const path = join(binDir, name);
  writeFileSync(path, STUB_SCRIPT, { mode: 0o755 });
  return path;
}

// A stub that always writes a marker file, so an invalid --model (which must
// never spawn the child) can be detected by the marker's absence.
const MARKER_STUB = `#!/bin/sh
touch "$AIAND_MARKER"
exit 42
`;
function plantMarkerStub(name) {
  const path = join(binDir, name);
  writeFileSync(path, MARKER_STUB, { mode: 0o755 });
  return path;
}

// A stub that dumps env, then lingers until the test drops $AIAND_DONE (or a
// bounded wait expires), so the launcher parent can be signaled mid-session.
const LINGER_STUB = `#!/bin/sh
env > "$AIAND_CAPTURE.env"
i=0
while [ ! -f "$AIAND_DONE" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
`;
function plantLingerStub(name) {
  const path = join(binDir, name);
  writeFileSync(path, LINGER_STUB, { mode: 0o755 });
  return path;
}
// Sessionless env for direct run() calls: no key and an empty config dir, so
// a missing validation would surface as NotLoggedIn instead. Restores env.
async function withoutSession(fn) {
  const saved = {
    AIAND_API_KEY: process.env.AIAND_API_KEY,
    AIAND_HOME: process.env.AIAND_HOME,
    AIAND_CONFIG_DIR: process.env.AIAND_CONFIG_DIR,
  };
  const empty = mkdtempSync(join(tmpdir(), "aiand-runagent-nosess-"));
  delete process.env.AIAND_API_KEY;
  process.env.AIAND_HOME = empty;
  process.env.AIAND_CONFIG_DIR = empty;
  try {
    return await fn();
  } finally {
    rmSync(empty, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const env = withTestEnv("aiand-runagent-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  binDir = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Seed a fresh catalog cache so session launches never hit the network.
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: [model("aiand/glm-5.3"), model("aiand/other")],
    })
  );

  // One capture dir per subprocess run, created fresh inside each test.
  stubCli = (args, extraEnv, captureRoot) => {
    const raw = {
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: "sk-test-aiand",
      PATH: `${binDir}:${process.env.PATH}`,
      AIAND_CAPTURE: join(captureRoot, "capture"),
      ...extraEnv,
    };
    // An explicit undefined deletes a default (`AIAND_API_KEY: undefined`
    // simulates a signed-out user).
    const envWithPaths = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    return execFileAsync("node", [BIN, "run-agent", ...args], {
      env: envWithPaths,
    }).then(
      () => ({ code: 0, stdout: "", stderr: "" }),
      (e) => ({ code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" })
    );
  };
});

describe("run-agent launcher", () => {
  test("opencode: OPENCODE_CONFIG_CONTENT carries the session key, exit 42 propagates", async () => {
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode", "--", "--version"], {}, capture);
      assert.equal(code, 42);

      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      const config = JSON.parse(match[1]);
      // Key rides in a throwaway 0600 file via {file:} substitution, not
      // the child env; the launcher's cleanup unlinks it after the exit.
      assert.match(config.provider?.aiand?.options?.apiKey, /^\{file:.+\}$/);
      // The CLI has exited: the launcher's cleanup must already have
      // unlinked the throwaway key file (contents + 0600 are covered in
      // test/agents-opencode.test.mjs while the launch is still live).
      const keyFile = config.provider.aiand.options.apiKey.slice("{file:".length, -1);
      assert.equal(existsSync(keyFile), false);
      assert.match(readFileSync(join(capture, "capture.args"), "utf8"), /^--version\n/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("-- passthrough preserves flags and order verbatim", async () => {
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      await stubCli(["opencode", "--", "--version", "--flag", "x"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["--version", "--flag", "x"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("non-flag positional before -- is passthrough too", async () => {
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      await stubCli(["opencode", "--model", "aiand/glm-5.3", "--", "extra", "--args"], {}, capture);
      const args = readFileSync(join(capture, "capture.args"), "utf8").trim().split("\n");
      assert.deepEqual(args, ["extra", "--args"]);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("no agent name -> CliError usage hint", async () => {
    const { code, stderr } = await stubCli([], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /run-agent needs a coding agent name/i);
    assert.match(stderr, /aiand run-agent opencode -- --version/i);
  });

  test("unknown agent -> CliError listing agents", async () => {
    const { code, stderr } = await stubCli(["not-an-agent"], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown agent "not-an-agent"/);
    assert.match(stderr, /Agents:/);
  });

  test("invalid --model -> exit 1 with valid-ids hint, child never spawned", async () => {
    // opencode stub writes a marker file only when actually spawned; an invalid
    // model must fail before spawn, so the marker never appears.
    plantMarkerStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    const marker = join(capture, "marker");
    try {
      const { code, stderr } = await stubCli(
        ["opencode", "--model", "nope"],
        { AIAND_MARKER: marker },
        capture
      );
      assert.equal(code, 1);
      assert.match(stderr, /--model "nope" is not in the catalog/);
      assert.match(stderr, /Valid ids: aiand\/glm-5.3, aiand\/other/);
      assert.throws(() => readFileSync(marker, "utf8"), /ENOENT/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });
  test("unknown agent -> exit 1 listing the opencode registry", async () => {
    const { code, stderr } = await stubCli(["not-an-agent"], {}, env.dir);
    assert.equal(code, 1);
    assert.match(stderr, /Unknown agent "not-an-agent"/);
    assert.match(stderr, /Agents: opencode/);
  });

  test("missing binary -> 127 with install hint", async () => {
    // Opencode is registered but its binary is not on the stripped PATH (no
    // stub planted; the system has no opencode), so detect() misses -> 127 +
    // install hint. Using a real AGENTS member keeps this hermetic.
    // PATH is stubs + system probe dirs only: a real opencode install on this
    // machine must not leak into detection, or the launcher would spawn the
    // interactive binary and hang the suite waiting on a TTY. Node itself
    // resolves through the stub dir so odd install layouts stay covered.
    // Earlier tests plant an opencode stub in the shared bin dir; a missing
    // binary needs it gone, so remove the leftover before detecting.
    rmSync(join(binDir, "opencode"), { force: true });
    try {
      symlinkSync(process.execPath, join(binDir, "node"));
    } catch {
      // Already linked by an earlier run in this process.
    }
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    const hermeticPath = [binDir, "/usr/bin", "/bin"].join(delimiter);
    try {
      const { code, stderr } = await stubCli(["opencode"], { PATH: hermeticPath }, capture);
      assert.equal(code, 127);
      assert.match(stderr, /OpenCode is not installed/);
      assert.match(stderr, /Install it with:/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("signed-out + missing binary -> 127 with install hint, never a login", async () => {
    // Detect runs before session: no Env key and no binary is still 127 +
    // Install hint, never "Not logged in" or a login ceremony.
    rmSync(join(binDir, "opencode"), { force: true });
    try {
      symlinkSync(process.execPath, join(binDir, "node"));
    } catch {
      // Already linked by an earlier run in this process.
    }
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    const hermeticPath = [binDir, "/usr/bin", "/bin"].join(delimiter);
    try {
      const { code, stderr } = await stubCli(
        ["opencode"],
        { PATH: hermeticPath, AIAND_API_KEY: undefined },
        capture
      );
      assert.equal(code, 127);
      assert.match(stderr, /OpenCode is not installed/);
      assert.match(stderr, /Install it with:/);
      assert.doesNotMatch(stderr, /Not logged in/);
      assert.doesNotMatch(stderr, /aiand login/);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("signed-out + binary present -> Not logged in, never 127", async () => {
    // The reorder only skips the session when there is no binary: a present
    // binary still resolves the session key and fails as NotLoggedIn.
    plantStub("opencode");
    await withoutSession(async () => {
      const savedPath = process.env.PATH;
      process.env.PATH = `${binDir}${delimiter}${savedPath}`;
      try {
        await assert.rejects(run(["opencode"]), (error) => {
          assert.match(error.message, /Not logged in/);
          assert.doesNotMatch(error.message, /is not installed/);
          return true;
        });
      } finally {
        process.env.PATH = savedPath;
      }
    });
  });

  test("throwaway config has tool_call true when the catalog lists tools", async () => {
    // The seeded catalog fixture carries capabilities ["tools"]; the session
    // overlay must map that to tool_call true on every model entry.
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.equal(config.provider.aiand.models["aiand/glm-5.3"].tool_call, true);
      assert.equal(config.provider.aiand.models["aiand/other"].tool_call, true);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("opencode: OPENCODE_CONFIG_CONTENT carries provider.aiand config", async () => {
    // opencode is registered and its sessionLaunch emits OPENCODE_CONFIG_CONTENT.
    // When --model is omitted the launcher resolves a default, so a concrete
    // aiand/<id> root ref appears.
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.ok(config.provider?.aiand, "provider.aiand present");
      assert.match(config.provider.aiand.options?.baseURL, /^https:\/\/api\.aiand\.com/);
      assert.ok(config.model, "a concrete model root ref resolved");
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("omitted --model uses the profile model when still in the catalog", async () => {
    // Seeded catalog lists aiand/glm-5.3 first (the fallback default) — a
    // profile model of aiand/other must win the root ref instead.
    plantStub("opencode");
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { model: "aiand/other" } } })
    );
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const config = JSON.parse(envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
      assert.equal(config.model, "aiand/aiand/other");
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("explicit --model wins over the profile model", async () => {
    plantStub("opencode");
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { model: "aiand/other" } } })
    );
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode", "--model", "aiand/glm-5.3"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const config = JSON.parse(envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
      assert.equal(config.model, "aiand/aiand/glm-5.3");
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("http --base-url rejects with the https error before session key resolution", async () => {
    // Sessionless: without the early guard this fails as NotLoggedIn, so the
    // https error proves validation runs before session key resolution.
    await withoutSession(() =>
      assert.rejects(run(["opencode", "--base-url", "http://evil.example"]), (error) => {
        assert.match(error.message, /Base URL must use https/);
        assert.doesNotMatch(error.message, /Not logged in/);
        return true;
      })
    );
  });

  test("--help with a bad --base-url still prints help (no https error)", async () => {
    // Help must win over base-url validation so `run-agent --help --base-url
    // http://…` is usable.
    await withoutSession(async () => {
      const chunks = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk, ...rest) => {
        chunks.push(String(chunk));
        return originalWrite.call(process.stdout, chunk, ...rest);
      };
      try {
        await run(["--help", "--base-url", "http://evil.example"]);
      } finally {
        process.stdout.write = originalWrite;
      }
      assert.match(chunks.join(""), /run-agent/);
    });
  });

  test("omitted --base-url passes the profile apiUrl into sessionLaunch", async () => {
    plantStub("opencode");
    const custom = "https://gw.example.test";
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ profile: "default", profiles: { default: { apiUrl: custom } } })
    );
    writeFileSync(
      join(cfg, "model-catalog.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: custom,
        models: [model("aiand/glm-5.3"), model("aiand/other")],
      })
    );
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
      assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
      const config = JSON.parse(match[1]);
      assert.equal(config.provider?.aiand?.options?.baseURL, `${custom}/v1`);
    } finally {
      writeFileSync(join(cfg, "config.json"), JSON.stringify({ profile: "default", profiles: {} }));
      writeFileSync(
        join(cfg, "model-catalog.json"),
        JSON.stringify({
          fetchedAt: Date.now(),
          baseUrl: "https://api.aiand.com",
          models: [model("aiand/glm-5.3"), model("aiand/other")],
        })
      );
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("child env scrubs AIAND_API_KEY but keeps the adapter injection", async () => {
    // stubCli always sets AIAND_API_KEY in the parent env; the launcher must
    // not forward it — the adapter's own injection carries the key instead.
    plantStub("opencode");
    const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
    try {
      const { code } = await stubCli(["opencode"], {}, capture);
      assert.equal(code, 42);
      const envText = readFileSync(join(capture, "capture.env"), "utf8");
      assert.doesNotMatch(envText, /^AIAND_API_KEY=/m);
      assert.match(envText, /^OPENCODE_CONFIG_CONTENT=/m);
    } finally {
      rmSync(capture, { recursive: true, force: true });
    }
  });

  test("http loopback --base-url passes https validation", async () => {
    // Same sessionless env: the failure must come from a later stage
    // (session, detection), never the https guard.
    await withoutSession(() =>
      assert.rejects(run(["opencode", "--base-url", "http://localhost:1234"]), (error) => {
        assert.doesNotMatch(error.message, /Base URL must use https/);
        return true;
      })
    );
  });

  for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    test(`${signal} to run-agent removes the throwaway key dir before exit`, async () => {
      if (process.platform === "win32") return;
      plantLingerStub("opencode");
      const capture = mkdtempSync(join(tmpdir(), "aiand-cap-"));
      const doneFile = join(capture, "done");
      const child = spawn("node", [BIN, "run-agent", "opencode"], {
        env: {
          AIAND_HOME: home,
          AIAND_CONFIG_DIR: cfg,
          AIAND_API_KEY: "sk-test-aiand",
          PATH: `${binDir}:${process.env.PATH}`,
          AIAND_CAPTURE: join(capture, "capture"),
          AIAND_DONE: doneFile,
        },
        stdio: "ignore",
      });
      try {
        // Wait until the stub dump includes the overlay (existsSync alone
        // races: `env > file` truncates before env finishes writing).
        const captureEnv = join(capture, "capture.env");
        const deadline = Date.now() + 10000;
        let envText = "";
        while (Date.now() < deadline) {
          if (existsSync(captureEnv)) {
            envText = readFileSync(captureEnv, "utf8");
            if (/^OPENCODE_CONFIG_CONTENT=/m.test(envText)) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        const match = envText.match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
        assert.ok(match, "OPENCODE_CONFIG_CONTENT in child env");
        const apiKey = JSON.parse(match[1]).provider.aiand.options.apiKey;
        assert.match(apiKey, /^\{file:.+\}$/);
        const keyFile = apiKey.slice("{file:".length, -1);
        assert.ok(keyFile.includes("aiand-opencode-"));
        assert.equal(existsSync(keyFile), true);
        // Signal the parent only: cleanup must wipe the dir before exit.
        child.kill(signal);
        const exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
        assert.equal(exitCode, expectedCode);
        assert.equal(existsSync(keyFile), false);
        assert.equal(existsSync(dirname(keyFile)), false);
      } finally {
        writeFileSync(doneFile, "done");
        child.kill("SIGKILL");
        rmSync(capture, { recursive: true, force: true });
      }
    });
  }
});
