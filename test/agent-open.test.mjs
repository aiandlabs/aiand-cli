import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  CLOSED_URL,
  cliEnv,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const { installIfMissing, runAgentBinary } = await import("../dist/agents/launch.js");

const CAPTURE_STUB = `env > "$AIAND_CAPTURE.env"
printf '%s\\n' "$@" > "$AIAND_CAPTURE.args"
exit 42`;

let binDir;
const box = withTestEnv("aiand-open-", (dir) => {
  binDir = join(dir, "bin");
  for (const agent of ["opencode", "claude", "codex"]) plantStub(binDir, agent, CAPTURE_STUB);
});

function freshState() {
  const state = mkdtempSync(join(box.dir, "state-"));
  const cfg = join(state, "cfg");
  seedCatalogCache(cfg);
  return { home: join(state, "home"), cfg, capture: join(state, "capture") };
}

const cli = (args, state, env = {}) =>
  runCli(args, {
    env: cliEnv({
      AIAND_HOME: state.home,
      AIAND_CONFIG_DIR: state.cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
      AIAND_CAPTURE: state.capture,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      ...env,
    }),
  });

const capturedArgs = (state) =>
  readFileSync(`${state.capture}.args`, "utf8").split("\n").slice(0, -1);
const capturedEnv = (state) => readFileSync(`${state.capture}.env`, "utf8");
const opencodeJson = (state) => join(state.home, ".config", "opencode", "opencode.json");

describe("aiand <agent> opens the agent", () => {
  test("a fresh opencode is wired, then runs with the args verbatim", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["opencode", "run", "--flag", "hi"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
    const config = JSON.parse(readFileSync(opencodeJson(state), "utf8"));
    assert.equal(config.provider.aiand.options["x-aiand"], true);
    assert.equal(config.model, "aiand/zai-org/glm-5.3");
    assert.deepEqual(capturedArgs(state), ["run", "--flag", "hi"]);
    assert.doesNotMatch(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=/m);
  });

  test("an agent already on opens without wiring again", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const before = readFileSync(opencodeJson(state), "utf8");
    const { code, stderr } = await cli(["opencode"], state);
    assert.equal(code, 42);
    assert.doesNotMatch(stderr, /now using ai&/);
    assert.equal(readFileSync(opencodeJson(state), "utf8"), before);
  });

  test("aiand code is OpenCode", async () => {
    const state = freshState();
    const { code } = await cli(["code", "--continue"], state);
    assert.equal(code, 42);
    assert.ok(existsSync(opencodeJson(state)));
    assert.deepEqual(capturedArgs(state), ["--continue"]);
  });

  test("a model of the user's own stays in opencode.json, but OpenCode opens on ai&", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    const { code, stderr } = await cli(["opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /Left your existing model \(anthropic\/claude-sonnet-4-5\)/);
    assert.equal(
      JSON.parse(readFileSync(opencodeJson(state), "utf8")).model,
      "anthropic/claude-sonnet-4-5",
    );
    const inline = capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m);
    assert.deepEqual(JSON.parse(inline[1]), { model: "aiand/zai-org/glm-5.3" });
  });

  test("OpenCode opens on a model its wired provider lists, catalog or not", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    assert.equal((await cli(["config", "set", "model", "other/model"], state)).code, 0);
    const inline = () => JSON.parse(capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.deepEqual(inline(), { model: "aiand/zai-org/glm-5.3" });
    rmSync(join(state.cfg, "model-catalog.json"));
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.deepEqual(inline(), { model: "aiand/zai-org/glm-5.3" });
  });

  test("`--` passes a verb through to the agent", async () => {
    const state = freshState();
    const { code } = await cli(["opencode", "--", "status"], state);
    assert.equal(code, 42);
    assert.deepEqual(capturedArgs(state), ["status"]);
  });

  test("codex opens on its ai& profile", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["codex", "exec", "hi"], state);
    assert.equal(code, 42);
    assert.match(stderr, /Codex is now using ai&\./);
    assert.ok(existsSync(join(state.home, ".codex", "aiand.config.toml")));
    assert.deepEqual(capturedArgs(state), ["--profile", "aiand", "exec", "hi"]);
  });

  test("codex args that pick a profile get no second --profile", async () => {
    const state = freshState();
    assert.equal((await cli(["codex", "--profile", "aiand", "exec", "hi"], state)).code, 42);
    assert.deepEqual(capturedArgs(state), ["--profile", "aiand", "exec", "hi"]);
    assert.equal((await cli(["codex", "-pwork"], state)).code, 42);
    assert.deepEqual(capturedArgs(state), ["-pwork"]);
  });

  test("codex management commands run without the ai& profile, which they refuse", async () => {
    const state = freshState();
    const { code } = await cli(["codex", "login", "status"], state);
    assert.equal(code, 42);
    assert.deepEqual(capturedArgs(state), ["login", "status"]);
  });

  test("on --model native keeps OpenCode's own default when it opens", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode", "on", "--model", "native"], state)).code, 0);
    assert.equal((await cli(["opencode"], state)).code, 42);
    assert.doesNotMatch(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=/m);
  });

  test("an OPENCODE_CONFIG_CONTENT of the user's own is kept, and its model wins", async () => {
    const state = freshState();
    mkdirSync(dirname(opencodeJson(state)), { recursive: true });
    writeFileSync(opencodeJson(state), '{ "model": "anthropic/claude-sonnet-4-5" }\n');
    const inline = () => JSON.parse(capturedEnv(state).match(/^OPENCODE_CONFIG_CONTENT=(.*)$/m)[1]);

    await cli(["opencode"], state, { OPENCODE_CONFIG_CONTENT: '{ "theme": "mine", }' });
    assert.deepEqual(inline(), { theme: "mine", model: "aiand/zai-org/glm-5.3" });

    await cli(["opencode"], state, { OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt-5"}' });
    assert.deepEqual(inline(), { model: "openai/gpt-5" });

    await cli(["opencode"], state, { OPENCODE_CONFIG_CONTENT: "not json" });
    assert.match(capturedEnv(state), /^OPENCODE_CONFIG_CONTENT=not json$/m);
  });

  test("claude opens with only its own args once wired", async () => {
    const state = freshState();
    const { code } = await cli(["claude", "-p", "hi"], state);
    assert.equal(code, 42);
    const settings = JSON.parse(readFileSync(join(state.home, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.env.AIAND_MANAGED);
    assert.deepEqual(capturedArgs(state), ["-p", "hi"]);
  });

  test("a leading --profile wires again, so the agent runs on that profile", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const { code, stderr } = await cli(["--profile", "work", "opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
  });

  test("a leading --base-url wires again, so the agent reaches that gateway", async () => {
    const state = freshState();
    assert.equal((await cli(["opencode"], state)).code, 42);
    const other = "http://127.0.0.1:10";
    seedCatalogCache(state.cfg, { baseUrl: other });
    const { code, stderr } = await cli(["--base-url", other, "opencode"], state);
    assert.equal(code, 42);
    assert.match(stderr, /OpenCode is now using ai&\./);
    const config = JSON.parse(readFileSync(opencodeJson(state), "utf8"));
    assert.equal(config.provider.aiand.options.baseURL, `${other}/v1`);
  });

  test("a missing agent with no terminal exits 127 with the install hint, never npm", async () => {
    const state = freshState();
    const empty = mkdtempSync(join(box.dir, "nobin-"));
    const marker = join(state.home, "npm-ran");
    plantStub(empty, "npm", `touch "${marker}"`);
    const { code, stderr } = await cli(["opencode"], state, {
      PATH: hermeticPath(empty, dirname(process.execPath)),
    });
    assert.equal(code, 127);
    assert.match(stderr, /OpenCode is not installed/);
    assert.match(stderr, /Install it with: npm install -g opencode-ai@/);
    assert.equal(existsSync(marker), false);
  });

  test("signed out with no terminal exits 2 and never runs the agent", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["opencode"], state, { AIAND_API_KEY: "" });
    assert.equal(code, 2);
    assert.match(stderr, /Not logged in/i);
    assert.equal(existsSync(`${state.capture}.args`), false);
  });
});

async function onTty(answer, fn) {
  const saved = [process.stdin, process.stdout].map((s) => [
    s,
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  ]);
  for (const [stream] of saved) {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
  }
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    if (answer !== undefined) process.stdin.push(`${answer}\n`);
    return await fn();
  } finally {
    process.stderr.write = write;
    for (const [stream, desc] of saved) {
      if (desc) Object.defineProperty(stream, "isTTY", desc);
      else delete stream.isTTY;
    }
  }
}

function installable(command = "npm install -g fixture-agent@1.2.3") {
  const dir = mkdtempSync(join(box.dir, "install-"));
  const agent = join(dir, "agent");
  return {
    dir,
    agent,
    adapter: {
      id: "fixture-agent",
      label: "Fixture Agent",
      bin: "fixture-agent",
      install: { command, url: "https://example.com/fixture" },
      detect: () =>
        existsSync(agent) ? { installed: true, path: agent } : { installed: false, path: null },
    },
  };
}

function withNpm(dir, script, fn) {
  plantStub(dir, "npm", script);
  return withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, fn);
}

describe("installIfMissing", () => {
  test("an installed agent is left alone", async () => {
    const { adapter, agent } = installable();
    writeFileSync(agent, "");
    await installIfMissing(adapter);
  });

  test("an install command that is not npm is never run, and never asked about", async () => {
    const { adapter } = installable("brew install fixture-agent");
    await onTty(undefined, () =>
      assert.rejects(installIfMissing(adapter), (error) => {
        assert.equal(error.exitCode, 127);
        assert.match(error.hint, /Install it with: brew install fixture-agent/);
        return true;
      }),
    );
  });

  test("yes (the default) runs npm install -g with the pinned package", async () => {
    const { adapter, agent, dir } = installable();
    const args = join(dir, "npm-args");
    await withNpm(dir, `printf '%s\\n' "$@" > "${args}"\ntouch "${agent}"`, () =>
      onTty("", () => installIfMissing(adapter)),
    );
    assert.deepEqual(readFileSync(args, "utf8").split("\n").slice(0, -1), [
      "install",
      "-g",
      "fixture-agent@1.2.3",
    ]);
  });

  test("no leaves it uninstalled: 127 + Install hint, npm never runs", async () => {
    const { adapter, dir } = installable();
    const marker = join(dir, "npm-ran");
    await withNpm(dir, `touch "${marker}"`, () =>
      onTty("n", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.equal(error.exitCode, 127);
          assert.match(error.hint, /Install it with: npm install -g fixture-agent@1\.2\.3/);
          return true;
        }),
      ),
    );
    assert.equal(existsSync(marker), false);
  });

  test("a failing npm says so and keeps the hint", async () => {
    const { adapter, dir } = installable();
    await withNpm(dir, "exit 3", () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.equal(error.exitCode, 127);
          assert.match(error.message, /Installing Fixture Agent failed: npm exited with 3\./);
          assert.match(
            error.hint,
            /Install it yourself with: npm install -g fixture-agent@1\.2\.3/,
          );
          return true;
        }),
      ),
    );
  });

  test("npm not on PATH says so", async () => {
    const { adapter } = installable();
    const empty = mkdtempSync(join(box.dir, "nonpm-"));
    await withEnv({ PATH: hermeticPath(empty) }, () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), /Installing Fixture Agent failed: .*ENOENT/),
      ),
    );
  });

  test("an install npm puts off PATH says where to look", async () => {
    const { adapter, dir } = installable();
    await withNpm(dir, "exit 0", () =>
      onTty("y", () =>
        assert.rejects(installIfMissing(adapter), (error) => {
          assert.match(error.message, /installed, but fixture-agent is not on your PATH/);
          assert.match(error.hint, /npm prefix -g/);
          return true;
        }),
      ),
    );
  });
});

describe("runAgentBinary", () => {
  test("stops reading stdin before the agent takes the terminal", async () => {
    const dir = mkdtempSync(join(box.dir, "run-"));
    plantStub(dir, "fixture-agent", "exit 0");
    process.stdin.resume();
    try {
      await withEnv({ PATH: hermeticPath(dir, "/usr/bin", "/bin") }, () =>
        runAgentBinary(installable().adapter, [], process.env),
      );
      assert.equal(process.stdin.isPaused(), true);
    } finally {
      process.stdin.pause();
    }
  });
});
