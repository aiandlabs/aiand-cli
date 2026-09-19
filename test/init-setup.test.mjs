import assert from "node:assert/strict";
import test, { before } from "node:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stdin, stdout } from "node:process";
import { catalogModel, withTestEnv } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

// --- Shared temp env (key + catalog + opencode caches, like init-polish) ------
let home, cfg, stubBin, bin;
withTestEnv("aiand-init-setup-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  stubBin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(stubBin, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  process.env.AIAND_BASE_URL = "https://fixture.test";

  // capabilities ["tools"] (no vision): every wired model warns as text-only.
  writeFileSync(
    join(cfg, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: [catalogModel("zai-org/glm-5.3"), catalogModel("other/model")],
    })
  );
  writeFileSync(
    join(cfg, "opencode-api.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://fixture.test",
      models: { "zai-org/glm-5.3": { id: "zai-org/glm-5.3", name: "GLM 5.3" } },
    })
  );

  bin = join(dirname(import.meta.dirname), "dist", "index.js");
});

let eng, initCmd;
before(async () => {
  eng = await import("../dist/agents/setup.js");
  initCmd = await import("../dist/commands/init.js");
});

// --- Helpers -----------------------------------------------------------------

const runCli = async (args, { withStubs = false, env = {} } = {}) => {
  const path = withStubs ? `${stubBin}:${process.env.PATH}` : (env.PATH ?? process.env.PATH);
  try {
    const { stdout, stderr } = await execFileAsync("node", [bin, ...args], {
      env: { ...process.env, PATH: path, AIAND_HOME: home, AIAND_CONFIG_DIR: cfg, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** Plant a POSIX-sh `opencode` stub on the temp bin dir so detection finds it. */
function plantOpencodeStub() {
  const script = join(stubBin, "opencode");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  chmodSync(script, 0o755);
}

/** Hermetic PATH (stubs + node + which) so --all wires exactly the stub. */
function hermeticPath() {
  try {
    symlinkSync(process.execPath, join(stubBin, "node"));
  } catch {
    // Already linked by an earlier run in this process.
  }
  return [stubBin, "/usr/bin"].join(":");
}

/** Minimal in-process adapter shaped like dispatch's fixture. */
function makeFixture(homedir, { installed = true } = {}) {
  const file = () => join(homedir, ".fixture", "config.json");
  return {
    id: "fixture-agent",
    label: "Fixture Agent",
    bin: "fixture-agent",
    install: { command: "npm i -g fixture-agent", url: "https://example.com/fixture" },
    detect: () =>
      installed
        ? { installed: true, path: "/usr/bin/fixture-agent" }
        : { installed: false, path: null },
    managedFiles: () => [file()],
    probe: async () => {
      try {
        const parsed = JSON.parse(readFileSync(file(), "utf8"));
        return { active: parsed.aiand === true, model: parsed.aiand ? parsed.model ?? null : null };
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
        // Missing file is a first-time on.
      }
      writeFileSync(file(), `${JSON.stringify({ ...current, aiand: true, model: input.model })}\n`);
      return { model: input.model, filesWritten: [file()] };
    },
    disable: async () => ({ stripped: false }),
  };
}

/** Run fn with isTTY overridden on stdio (faked TTY or forced pipe). */
async function withIsTty({ stdinIsTty, stdoutIsTty }, fn) {
  const targets = [
    [stdin, stdinIsTty],
    [stdout, stdoutIsTty],
  ];
  const saved = targets.map(([stream]) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  try {
    for (const [stream, value] of targets) {
      Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
    }
    return await fn();
  } finally {
    targets.forEach(([stream], i) => {
      if (saved[i]) Object.defineProperty(stream, "isTTY", saved[i]);
      else delete stream.isTTY;
    });
  }
}

/** Run init.run in-process on a faked TTY, capturing both streams.
 * Chunks stay per write: the runner streams its own progress to stdout, so
 * the command's output is the one chunk that parses as JSON. */
async function runInitOnTty(args, { path } = {}) {
  const savedPath = process.env.PATH;
  if (path !== undefined) process.env.PATH = path;
  try {
    return await withIsTty({ stdinIsTty: true, stdoutIsTty: true }, async () => {
      const outChunks = [];
      let errOut = "";
      const origOut = stdout.write;
      const origErr = process.stderr.write;
      stdout.write = (chunk) => {
        outChunks.push(String(chunk));
        return true;
      };
      process.stderr.write = (chunk) => {
        errOut += String(chunk);
        return true;
      };
      try {
        await initCmd.run(args);
      } finally {
        stdout.write = origOut;
        process.stderr.write = origErr;
      }
      const jsonChunks = outChunks.filter((c) => {
        try {
          JSON.parse(c);
          return true;
        } catch {
          return false;
        }
      });
      return { outChunks, jsonChunks, err: errOut };
    });
  } finally {
    process.env.PATH = savedPath;
  }
}

// --- setup.ts: detect before session ------------------------------------------

test("agentOn with no binary and no session exits 127, never a login", async () => {
  const savedKey = process.env.AIAND_API_KEY;
  const savedBase = process.env.AIAND_BASE_URL;
  const savedCfg = process.env.AIAND_CONFIG_DIR;
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  process.env.AIAND_CONFIG_DIR = join(home, "empty-cfg");
  mkdirSync(process.env.AIAND_CONFIG_DIR, { recursive: true });
  try {
    await assert.rejects(eng.agentOn(makeFixture(home, { installed: false })), (e) => {
      assert.equal(e.exitCode, 127);
      assert.match(e.message, /is not installed/);
      assert.match(e.hint, /Install it with: npm i -g fixture-agent/);
      assert.match(e.hint, /See: https:\/\/example.com\/fixture/);
      return true;
    });
  } finally {
    process.env.AIAND_CONFIG_DIR = savedCfg;
    if (savedKey !== undefined) process.env.AIAND_API_KEY = savedKey;
    if (savedBase !== undefined) process.env.AIAND_BASE_URL = savedBase;
  }
});

test("opencode on with missing binary and no session: 127 + Install hint, no login text", async () => {
  const { code, stdout, stderr } = await runCli(["opencode", "on"], {
    env: { PATH: dirname(process.execPath), AIAND_API_KEY: "" },
  });
  assert.equal(code, 127);
  assert.match(stderr, /OpenCode is not installed\./);
  assert.match(stderr, /Install it with: npm install -g opencode-ai/);
  assert.match(stderr, /https:\/\/opencode\.ai/);
  assert.doesNotMatch(stderr, /Not logged in|Not signed in/);
  assert.equal(stdout, "");
});

test("opencode on signed-out with binary installed still exits 2", async () => {
  plantOpencodeStub();
  const { code, stderr } = await runCli(["opencode", "on"], {
    withStubs: true,
    env: { AIAND_API_KEY: "" },
  });
  assert.equal(code, 2);
  assert.match(stderr, /Not logged in\./);
});

// --- setup.ts: explicit --model "" errors --------------------------------------

test("agentOn with model '' errors instead of silently defaulting", async () => {
  await assert.rejects(eng.agentOn(makeFixture(home), { model: "" }), (e) => {
    assert.match(e.message, /--model "" is not in the catalog\./);
    return true;
  });
});

test("agentOn with a non-empty --model still wires it", async () => {
  const result = await eng.agentOn(makeFixture(home), { model: "other/model" });
  assert.equal(result.state, "on");
  assert.equal(result.model, "other/model");
});

test("opencode on --model '' errors clearly", async () => {
  plantOpencodeStub();
  const { code, stderr } = await runCli(["opencode", "on", "--model", ""], { withStubs: true });
  assert.equal(code, 1);
  assert.match(stderr, /--model "" is not in the catalog\./);
});

test("opencode on --model <id> still wires (non-empty unchanged)", async () => {
  plantOpencodeStub();
  const { code, stderr } = await runCli(["opencode", "on", "--model", "zai-org/glm-5.3"], {
    withStubs: true,
  });
  assert.equal(code, 0, stderr);
});

// --- init.ts: failures keep exit code + hint -----------------------------------

test("init opencode with missing binary: Install hint + URL on stderr, exit 127", async () => {
  const { code, stdout, stderr } = await runCli(["init", "opencode"], {
    env: { PATH: dirname(process.execPath) },
  });
  assert.equal(code, 127);
  assert.match(stderr, /OpenCode is not installed\./);
  assert.match(stderr, /Install it with: npm install -g opencode-ai/);
  assert.match(stderr, /https:\/\/opencode\.ai/);
  assert.equal(stdout, "");
});

test("init --all signed-out and non-interactive exits 2", async () => {
  plantOpencodeStub();
  const { code, stderr } = await runCli(["init", "--all"], {
    env: { PATH: hermeticPath(), AIAND_API_KEY: "" },
  });
  assert.equal(code, 2);
  assert.match(stderr, /Not logged in\./);
});

test("init opencode --json with missing binary carries hint + exit_code", async () => {
  const { code, stdout } = await runCli(["init", "opencode", "--json"], {
    env: { PATH: dirname(process.execPath) },
  });
  assert.equal(code, 127);
  const [row] = JSON.parse(stdout).agents;
  assert.equal(row.agent, "opencode");
  assert.equal(row.failed, true);
  assert.equal(row.exit_code, 127);
  assert.match(row.note, /is not installed/);
  assert.match(row.hint, /Install it with:/);
  assert.match(row.hint, /https:\/\/opencode\.ai/);
});

test("init --all --json signed-out carries hint + exit_code 2", async () => {
  plantOpencodeStub();
  const { code, stdout } = await runCli(["init", "--all", "--json"], {
    env: { PATH: hermeticPath(), AIAND_API_KEY: "" },
  });
  assert.equal(code, 2);
  const [row] = JSON.parse(stdout).agents;
  assert.equal(row.failed, true);
  assert.equal(row.exit_code, 2);
  assert.match(row.note, /Not logged in/);
  assert.match(row.hint, /aiand login/);
});

// --- init.ts: warnings surface like the direct verb -----------------------------

test("init surfaces the same model warnings as the direct on verb", async () => {
  plantOpencodeStub();
  const direct = await runCli(["opencode", "on"], { withStubs: true });
  assert.equal(direct.code, 0, direct.stderr);
  const warning = /(\S+ is text-only and can't take images\.)/.exec(direct.stderr)?.[1];
  assert.ok(warning, `direct on should warn, got: ${direct.stderr}`);

  const viaInit = await runCli(["init", "opencode"], { withStubs: true });
  assert.equal(viaInit.code, 0, viaInit.stderr);
  assert.ok(viaInit.stderr.includes(warning), `init should repeat it, got: ${viaInit.stderr}`);
});

test("init --json success rows include warnings", async () => {
  plantOpencodeStub();
  const { code, stdout } = await runCli(["init", "opencode", "--json"], { withStubs: true });
  assert.equal(code, 0);
  const [row] = JSON.parse(stdout).agents;
  assert.equal(row.failed, undefined);
  assert.ok(
    (row.warnings ?? []).some((w) => /text-only and can't take images/.test(w)),
    `expected a text-only warning, got: ${JSON.stringify(row.warnings)}`
  );
});

// --- init.ts: TTY --json is JSON only --------------------------------------------

test("TTY init --json with zero detected emits JSON only", async () => {
  const { outChunks, jsonChunks, err } = await runInitOnTty(["--json"], {
    path: dirname(process.execPath),
  });
  assert.equal(jsonChunks.length, 1, `one JSON write, got: ${JSON.stringify(outChunks)}`);
  const parsed = JSON.parse(jsonChunks[0]);
  assert.deepEqual(parsed.agents, []);
  assert.match(parsed.message, /No coding agents detected/);
  assert.ok(
    outChunks.every((c) => !c.includes("Which agents")),
    "no checkbox chrome"
  );
  assert.equal(err, "");
});

test("TTY init --json with detected agents emits JSON only, no checkbox", async () => {
  plantOpencodeStub();
  const { outChunks, jsonChunks, err } = await runInitOnTty(["--json"], { path: hermeticPath() });
  assert.equal(jsonChunks.length, 1, `one JSON write, got: ${JSON.stringify(outChunks)}`);
  const parsed = JSON.parse(jsonChunks[0]);
  assert.deepEqual(parsed.agents, []);
  assert.deepEqual(parsed.detected, ["opencode"]);
  assert.ok(
    outChunks.every((c) => !c.includes("Which agents")),
    "no checkbox chrome"
  );
  assert.equal(err, "");
});

test("non-TTY init --json with detected agents is unchanged", async () => {
  plantOpencodeStub();
  const { code, stdout } = await runCli(["init", "--json"], { withStubs: true });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    agents: [],
    message: "Non-interactive: pass --all or name agents.",
    detected: ["opencode"],
  });
});
