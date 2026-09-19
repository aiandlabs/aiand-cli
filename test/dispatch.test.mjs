import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Load the registry once at module scope (it ships opencode) so the
// adapter-dependent dispatch test below runs against the real adapter.
const registry = await import("../dist/agents/registry.js");
const ADAPTERS_WIRED = registry.AGENTS.length > 0;

// --- Fixture adapter ---------------------------------------------------------
// A minimal AgentAdapter the engine exercises against a temp AIAND_HOME. The
// registry ships opencode (a real adapter), so the engine tests call engine
// functions directly and the subprocess tests cover registry paths too.

function makeFixture(home) {
  const file = () => join(home, ".fixture", "config.json");
  return {
    id: "fixture-agent",
    label: "Fixture Agent",
    bin: "fixture-agent",
    install: { command: "npm i -g fixture-agent", url: "https://example.com/fixture" },
    detect: () => ({ installed: true, path: "/usr/bin/fixture-agent" }),
    managedFiles: () => [file()],
    probe: async () => {
      try {
        const cfg = JSON.parse(readFileSync(file(), "utf8"));
        return {
          active: cfg.aiand === true,
          model: cfg.aiand ? cfg.model ?? null : null,
        };
      } catch {
        return { active: false, model: null };
      }
    },
    enable: async (input) => {
      mkdirSync(dirname(file()), { recursive: true });
      let current = {};
      try {
        current = JSON.parse(readFileSync(file(), "utf8"));
      } catch {
        // missing file is a first-time on
      }
      writeFileSync(file(), `${JSON.stringify({ ...current, aiand: true, model: input.model })}\n`);
      return { model: input.model, filesWritten: [file()] };
    },
    disable: async () => {
      const path = file();
      let raw;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return { stripped: false };
      }
      let cfg;
      try {
        cfg = JSON.parse(raw);
      } catch {
        return { stripped: false };
      }
      if (cfg.aiand !== true) return { stripped: false };
      delete cfg.aiand;
      writeFileSync(path, `${JSON.stringify(cfg)}\n`);
      return { stripped: true };
    },
  };
}

// --- Engines + shared temp env ------------------------------------------------
let eng;
let dir, home, cfg, bin;
const originalEnv = { ...process.env };
const SPY_ROOT = tmpdir();

before(async () => {
  dir = mkdtempSync(join(SPY_ROOT, "aiand-dispatch-"));
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = "https://fixture.test";

  // Seed a fresh catalog cache so agentOn never touches the network.
  const model = (id, price) => ({
    id,
    name: id,
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
    input_per_1m: price,
    output_per_1m: price,
    cached_input_per_1m: null,
  });
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: [model("zai-org/glm-5.3", "1"), model("other/model", "2")],
    })
  );

  eng = await import("../dist/agents/setup.js");
  bin = join(dirname(import.meta.dirname), "dist", "index.js");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

// --- Subprocess dispatch tests (built dist/index.js) --------------------------

const runCli = async (args, env) => {
  try {
    const { stdout, stderr } = await execFileAsync("node", [bin, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

describe("dispatch subprocess", () => {
  test("unknown command -> 127 with a suggestion", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["sttaus"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 127);
      assert.match(stderr, /Did you mean .*status/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("unknown agent noun -> 127", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["not-an-agent"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 127);
      assert.match(stderr, /Unknown command/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  // Adapter-dependent dispatch: routes to the opencode adapter shipped in
  // AGENTS. `status --json` needs no session; it returns agent status JSON.
  test("opencode noun dispatches to the opencode adapter, not unknown-command", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const r = await runCli(["opencode", "status", "--json"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(r.code, 127);
      assert.ok(JSON.parse(r.stdout).agent);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("aiand init --all with no detectable agents is friendly and exits 0", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      // PATH holds only node's own directory: the registry ships opencode
      // (a real adapter), but `which` cannot resolve there, so
      // detection finds nothing and init has nothing to wire.
      const { code, stdout } = await runCli(["init", "--all"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
        PATH: dirname(process.execPath),
      });
      assert.equal(code, 0);
      assert.match(stdout, /No coding agents detected/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("aiand status --json has the {auth, agents} shape", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      // Parent harness sets AIAND_API_KEY; null it out so the child takes the
      // signed-out path (openSession treats an empty/absent key as unset).
      env.AIAND_API_KEY = "";
      const { code, stdout } = await runCli(
        ["status", "--json"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      // Signed-out is a script gate: exit 1, body still parses.
      assert.equal(code, 1);
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.auth && typeof parsed.auth === "object");
      assert.ok(Array.isArray(parsed.agents));
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

// --- Engine-level tests (temp env, direct engine calls) ----------------------

function cleanFixture() {
  // The engine's backup manifest outlives the config file between tests —
  // clear both so each test starts from a genuinely pristine agent state.
  rmSync(join(cfg, "backups", "fixture-agent"), { recursive: true, force: true });
  const file = join(home, ".fixture", "config.json");
  if (existsSync(file)) unlinkSync(file);
}

function plant(content) {
  const file = join(home, ".fixture", "config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

describe("engine: fixture adapter", () => {
  test("on writes via the adapter and reports files", async () => {
    cleanFixture();
    const result = await eng.agentOn(makeFixture(home));
    assert.equal(result.state, "on");
    assert.equal(result.model, "zai-org/glm-5.3");
    const file = join(home, ".fixture", "config.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).aiand, true);
    assert.deepEqual(result.files, [file]);
  });

  test("registerAgent is idempotent by id", async () => {
    const before = registry.AGENTS.length;
    registry.registerAgent(makeFixture(home));
    registry.registerAgent(makeFixture(home));
    assert.equal(registry.AGENTS.length, before + 1);
    assert.equal(registry.AGENTS.filter((a) => a.id === "fixture-agent").length, 1);
    assert.ok(registry.findAgent("fixture-agent"));
  });

  test("off subtracts aiand keys and keeps the user's", async () => {
    cleanFixture();
    const original = '{"permissions":{"allow":["Bash*"]}}\n';
    plant(original);
    await eng.agentOn(makeFixture(home));
    assert.notEqual(readFileSync(join(home, ".fixture", "config.json"), "utf8"), original);
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    const after = JSON.parse(readFileSync(join(home, ".fixture", "config.json"), "utf8"));
    assert.equal(after.aiand, undefined);
    assert.deepEqual(after.permissions, { allow: ["Bash*"] });
  });

  test("agentOn with no binary prints an install hint and exits 127", async () => {
    cleanFixture();
    const missing = {
      ...makeFixture(home),
      detect: () => ({ installed: false, path: null }),
    };
    await assert.rejects(eng.agentOn(missing), (e) => {
      assert.equal(e.exitCode, 127);
      assert.match(e.message, /is not installed/);
      assert.match(e.hint, /Install it with: npm i -g fixture-agent/);
      assert.match(e.hint, /See: https:\/\/example.com\/fixture/);
      return true;
    });
  });

  test("off without a snapshot reports nothing to turn off", async () => {
    cleanFixture();
    const off = await eng.agentOff(makeFixture(home));
    assert.equal(off.state, "off");
    assert.equal(off.note, "Already your own config — nothing to turn off.");
  });

  test("status reports on/off states", async () => {
    cleanFixture();
    // off (no file)
    assert.equal((await eng.agentStatus(makeFixture(home))).state, "off");

    // inactive existing config still reports off
    plant(JSON.stringify({ permissions: { allow: ["Bash*"] } }));
    let status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "off");
    assert.equal(status.model, null);

    // on
    await eng.agentOn(makeFixture(home));
    status = await eng.agentStatus(makeFixture(home));
    assert.equal(status.state, "on");
    assert.equal(status.installed, true);
  });

  test("second on keeps the first snapshot; off keeps edits; restore --force rewinds", async () => {
    cleanFixture();
    const original = '{"original":true}\n';
    const file = join(home, ".fixture", "config.json");
    plant(original);
    await eng.agentOn(makeFixture(home));
    writeFileSync(file, JSON.stringify({ aiand: true, model: "touched", extra: 1 }));
    await eng.agentOn(makeFixture(home));
    await eng.agentOff(makeFixture(home));
    const afterOff = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(afterOff.aiand, undefined);
    assert.equal(afterOff.extra, 1);
    const { restoreSnapshot } = await import("../dist/agents/snapshot.js");
    assert.equal(await restoreSnapshot("fixture-agent", [file]), true);
    assert.equal(readFileSync(file, "utf8"), original);
  });
});

describe("engine: not signed in", () => {
  test("agentOn without a session throws NotLoggedInError (exit 2)", async () => {
    const savedKey = process.env.AIAND_API_KEY;
    const savedBase = process.env.AIAND_BASE_URL;
    const savedCfg = process.env.AIAND_CONFIG_DIR;
    delete process.env.AIAND_API_KEY;
    delete process.env.AIAND_BASE_URL;
    const emptyCfg = join(dir, "empty-cfg");
    process.env.AIAND_CONFIG_DIR = emptyCfg;
    mkdirSync(emptyCfg, { recursive: true });
    try {
      const { NotLoggedInError } = await import("../dist/cli/errors.js");
      await assert.rejects(eng.agentOn(makeFixture(home)), (e) => {
        assert.ok(e instanceof NotLoggedInError);
        assert.equal(e.exitCode, 2);
        return true;
      });
    } finally {
      process.env.AIAND_CONFIG_DIR = savedCfg;
      if (savedKey !== undefined) process.env.AIAND_API_KEY = savedKey;
      if (savedBase !== undefined) process.env.AIAND_BASE_URL = savedBase;
    }
  });
});

// --- Flag suggestions ---
describe("flag suggestions", () => {
  test("status --profle suggests --profile and exits nonzero", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["status", "--profle"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(code, 0);
      assert.match(stderr, /Did you mean --profile\?/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("status --zzzqqq keeps the generic hint", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["status", "--zzzqqq"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(code, 0);
      assert.match(stderr, /Run the command with --help to see its flags/);
      assert.doesNotMatch(stderr, /Did you mean/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

// --- status exit codes ---
describe("status exit codes", () => {
  /** A loopback gateway that fails every identity call with 500, exercising
   * the unreachable path; the sibling auth-flow test covers the refused
   * connection (dead port) half instead. */
  function failingGateway() {
    const server = createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gateway is down" }));
    });
    return server;
  }

  test("signed-out status --json exits 1 with reachable=true", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const { code, stdout } = await runCli(
        ["status", "--json"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      assert.equal(code, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.auth.signed_in, false);
      assert.equal(parsed.auth.reachable, true);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("unreachable gateway exits 0 with reachable=false (no false failure)", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    const server = failingGateway();
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const dead = `http://127.0.0.1:${server.address().port}`;
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "sk-test-not-real";
      env.AIAND_BASE_URL = dead;
      env.AIAND_AUTH_URL = dead;
      const { code, stdout } = await runCli(
        ["status", "--json"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.auth.signed_in, false);
      assert.equal(parsed.auth.reachable, false);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("unreachable gateway prose names the outage and exits 0", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    const server = failingGateway();
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const dead = `http://127.0.0.1:${server.address().port}`;
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "sk-test-not-real";
      env.AIAND_BASE_URL = dead;
      env.AIAND_AUTH_URL = dead;
      const { code, stdout, stderr } = await runCli(
        ["status"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      assert.equal(code, 0);
      assert.match(stdout, /Gateway unreachable/);
      assert.match(stderr, /Check your network/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("signed-out prose exits 1", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const { code, stdout } = await runCli(
        ["status"],
        { ...env, AIAND_HOME: join(spy, "h"), AIAND_CONFIG_DIR: join(spy, "c") }
      );
      assert.equal(code, 1);
      assert.match(stdout, /Not signed in/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

describe("agent help short flag (#13.1)", () => {
  test("opencode -h and opencode on -h exit 0 with help", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      for (const args of [
        ["opencode", "-h"],
        ["opencode", "on", "-h"],
      ]) {
        const { code, stdout } = await runCli(args, {
          AIAND_HOME: join(spy, "h"),
          AIAND_CONFIG_DIR: join(spy, "c"),
        });
        assert.equal(code, 0, `aiand ${args.join(" ")} should exit 0`);
        assert.match(stdout, /aiand opencode/);
        assert.match(stdout, /Verbs/);
      }
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("restore -h still works", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stdout } = await runCli(["restore", "-h"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 0);
      assert.match(stdout, /aiand restore/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

describe("agent extra positionals (#13.2)", () => {
  test("opencode on bogus errors", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["opencode", "on", "bogus"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(code, 0);
      assert.match(stderr, /at most one verb/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("bare on reaches session check, bare status still works", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const on = await runCli(["opencode", "on"], {
        ...env,
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(on.code, 2);
      assert.match(on.stderr, /Not logged in/);
      assert.doesNotMatch(on.stderr, /at most one verb/);

      const status = await runCli(["opencode", "status"], {
        ...env,
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(status.code, 0);
      assert.match(status.stdout, /agent/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

describe("leading globals (#13.3)", () => {
  test("leading --json works like trailing", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const { code, stdout } = await runCli(["--json", "status"], {
        ...env,
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 1);
      assert.ok(JSON.parse(stdout).auth);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("leading --profile is accepted, not Unknown command", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const { code, stdout, stderr } = await runCli(
        ["--profile", "foo", "status", "--json"],
        {
          ...env,
          AIAND_HOME: join(spy, "h"),
          AIAND_CONFIG_DIR: join(spy, "c"),
        }
      );
      assert.notEqual(code, 127);
      assert.doesNotMatch(stderr, /Unknown command/);
      assert.equal(code, 1);
      assert.ok(JSON.parse(stdout).auth);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("leading --base-url is accepted", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const env = { ...process.env };
      env.AIAND_API_KEY = "";
      const { code, stderr } = await runCli(
        ["--base-url", "http://127.0.0.1:9", "status", "--json"],
        {
          ...env,
          AIAND_HOME: join(spy, "h"),
          AIAND_CONFIG_DIR: join(spy, "c"),
        }
      );
      assert.notEqual(code, 127);
      assert.doesNotMatch(stderr, /Unknown command "--base-url"/);
      assert.equal(code, 1);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("leading --json reaches agent nouns", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const r = await runCli(["--json", "opencode", "status"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(r.code, 127);
      assert.ok(JSON.parse(r.stdout).agent);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

describe("help topics (#13.4)", () => {
  test("help opencode matches opencode --help", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const help = await runCli(["help", "opencode"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      const flag = await runCli(["opencode", "--help"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(help.code, 0);
      assert.equal(flag.code, 0);
      assert.match(help.stdout, /aiand opencode/);
      assert.ok(help.stdout.includes(flag.stdout.trim()));
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("help frobnicate exits nonzero", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stderr } = await runCli(["help", "frobnicate"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.notEqual(code, 0);
      assert.match(stderr, /Unknown help topic/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });

  test("help status still works", async () => {
    const spy = mkdtempSync(join(SPY_ROOT, "aiand-spy-"));
    try {
      const { code, stdout } = await runCli(["help", "status"], {
        AIAND_HOME: join(spy, "h"),
        AIAND_CONFIG_DIR: join(spy, "c"),
      });
      assert.equal(code, 0);
      assert.match(stdout, /aiand status/);
    } finally {
      rmSync(spy, { recursive: true, force: true });
    }
  });
});

describe("update hint via launched path (#13.5)", () => {
  test("subprocess with .aiand launched path prints the bash hint", async () => {
    const { stdout } = await execFileAsync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { updateInstallHint } from ${JSON.stringify(bin)}; console.log("HINT:" + updateInstallHint({ launched: "/tmp/fixture/.aiand/cli/dist/index.js" }));`,
      ]
    );
    assert.match(stdout, /HINT:bash ~\/\.aiand\/cli\/install\.sh/);
  });

  test("subprocess with npm launched path prints npm install", async () => {
    const { stdout } = await execFileAsync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { updateInstallHint } from ${JSON.stringify(bin)}; console.log("HINT:" + updateInstallHint());`,
        "/usr/local/lib/node_modules/@aiand/cli/dist/index.js",
      ],
      { env: { ...process.env, AIAND_DIR: "" } }
    );
    assert.match(stdout, /HINT:npm install -g @aiand\/cli/);
  });
});

describe("float validation (#17.3)", () => {
  test("float rejects Infinity and NaN, accepts finite", async () => {
    const { parse, float } = await import("../dist/cli/args.js");
    const argvFor = (raw) =>
      raw.startsWith("-") ? [`--temperature=${raw}`] : ["--temperature", raw];
    for (const raw of ["Infinity", "-Infinity", "NaN"]) {
      const parsed = parse(argvFor(raw), {
        temperature: { type: "string" },
      });
      assert.throws(() => float(parsed, "temperature"), /must be a number/);
    }
    for (const [raw, expected] of [
      ["0.5", 0.5],
      ["1", 1],
      ["-3.14", -3.14],
    ]) {
      const parsed = parse(argvFor(raw), {
        temperature: { type: "string" },
      });
      assert.equal(float(parsed, "temperature"), expected);
    }
  });
});
