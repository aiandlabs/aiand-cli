// OpenCode ships as two programs that read one opencode.json: the terminal
// `opencode` (1.x `opencode-ai`, 2.x `@opencode/cli`) and OpenCode Desktop,
// which shares 2.x's background service. These tests pin what aiand does
// for each: where the config lives, which line a binary is, when a launch
// needs a private server, and what `open`/`status` say with only the app.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import {
  CLOSED_URL,
  catalogModel,
  cliEnv,
  enableInput,
  FAKE_API_KEY,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

const box = withTestEnv("aiand-oc-surfaces-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
});

const surfaces = await import("../dist/agents/opencode/surfaces.js");
const { opencodeAdapter } = await import("../dist/agents/opencode/adapter.js");
const { recordAddedState } = await import("../dist/agents/snapshot.js");

const posix = process.platform !== "win32";

/** A fake npm global install of `pkg`@`version` whose bin must never run. */
function npmInstall(root, pkg, version) {
  const pkgDir = join(root, "lib", "node_modules", ...pkg.split("/"));
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  const marker = join(root, "ran");
  writeFileSync(join(pkgDir, "bin", "opencode"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, {
    mode: 0o755,
  });
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync(join(pkgDir, "bin", "opencode"), join(root, "bin", "opencode"));
  return { bin: join(root, "bin"), marker };
}

describe("opencode config location", () => {
  test("follows XDG_CONFIG_HOME like both OpenCode lines do", async () => {
    await withEnv({ AIAND_HOME: undefined, XDG_CONFIG_HOME: "/xdg/config" }, async () => {
      assert.equal(surfaces.opencodeConfigDir(), join("/xdg/config", "opencode"));
    });
    await withEnv({ AIAND_HOME: undefined, XDG_CONFIG_HOME: undefined }, async () => {
      assert.equal(surfaces.opencodeConfigDir(), join(homedir(), ".config", "opencode"));
    });
  });

  test("under AIAND_HOME the scoped home wins over XDG_CONFIG_HOME", async () => {
    await withEnv({ XDG_CONFIG_HOME: "/xdg/config" }, async () => {
      assert.equal(
        surfaces.opencodeConfigDir(),
        join(process.env.AIAND_HOME, ".config", "opencode"),
      );
      assert.deepEqual(opencodeAdapter.managedFiles(), [
        join(process.env.AIAND_HOME, ".config", "opencode", "opencode.json"),
      ]);
    });
  });
});

describe("which OpenCode line a binary is", () => {
  test("npm installs are read from package.json without running them", { skip: !posix }, () => {
    for (const [pkg, version, major] of [
      ["@opencode/cli", "2.3.0", 2],
      ["opencode-ai", "1.18.32", 1],
    ]) {
      const root = join(box.dir, `npm-${major}`);
      const { bin, marker } = npmInstall(root, pkg, version);
      withEnvSync({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, () => {
        assert.equal(surfaces.terminalMajor("opencode"), major, pkg);
      });
      assert.equal(existsSync(marker), false, `${pkg}'s binary never ran`);
    }
  });

  test("a standalone binary is asked with --version", { skip: !posix }, () => {
    for (const [output, major] of [
      ["opencode v2.3.0", 2],
      ["1.18.32", 1],
    ]) {
      const bin = join(box.dir, `standalone-${major}`);
      plantStub(bin, "opencode", `[ "$1" = "--version" ] && echo "${output}" && exit 0\nexit 1`);
      withEnvSync({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, () => {
        assert.equal(surfaces.terminalMajor("opencode"), major, output);
      });
    }
    const broken = join(box.dir, "standalone-broken");
    plantStub(broken, "opencode", "exit 3");
    withEnvSync({ PATH: hermeticPath(broken, "/usr/bin", "/bin") }, () => {
      assert.equal(surfaces.terminalMajor("opencode"), null);
    });
  });
});

describe("--standalone for a 2.x launch", () => {
  test("added for the TUI and the subcommands that take it", () => {
    for (const args of [
      [],
      ["--continue"],
      ["run", "hi"],
      ["mini"],
      ["models"],
      ["."],
      // An option's value is not the subcommand.
      ["--log-level", "debug", "run", "hi"],
      ["-m", "aiand/x", "run", "hi"],
      ["--session=abc", "run"],
    ]) {
      assert.deepEqual(surfaces.standaloneArgs(args), ["--standalone"], args.join(" "));
    }
  });

  test("left out when the args pick a server or run a subcommand that refuses it", () => {
    for (const args of [
      ["--standalone"],
      ["--server", "http://127.0.0.1:1"],
      ["--server=http://127.0.0.1:1"],
      ["service", "restart"],
      ["upgrade"],
      ["mcp", "list"],
      ["acp"],
      ["--log-level", "debug", "service", "status"],
    ]) {
      assert.deepEqual(surfaces.standaloneArgs(args), [], args.join(" "));
    }
  });
});

describe("opencode launches on each line", { skip: !posix }, () => {
  const catalog = [catalogModel("zai-org/glm-5.3")];
  const launch = (args) =>
    opencodeAdapter.sessionLaunch({
      apiKey: "sk-x",
      model: undefined,
      profileName: "default",
      catalog,
      args,
    });

  test("run-agent on 2.x runs a private server so the inline config applies", async () => {
    const { bin } = npmInstall(join(box.dir, "ra-2"), "@opencode/cli", "2.3.0");
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      const session = await launch(["run", "hi"]);
      try {
        assert.deepEqual(session.args, ["--standalone"]);
        assert.deepEqual(session.stripPassthroughFlags, ["--server"]);
        assert.ok(session.env.OPENCODE_CONFIG_CONTENT);
        assert.deepEqual((await launch(["service", "status"])).args, []);
      } finally {
        await session.cleanup();
      }
    });
  });

  test("run-agent on 2.x still gets --standalone when it strips the user's --server", async () => {
    const { bin } = npmInstall(join(box.dir, "ra-2-server"), "@opencode/cli", "2.3.0");
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      for (const args of [
        ["run", "hi", "--server", "http://127.0.0.1:4096"],
        ["--server=http://127.0.0.1:4096", "run", "hi"],
      ]) {
        const session = await launch(args);
        try {
          assert.deepEqual(session.args, ["--standalone"], args.join(" "));
          assert.deepEqual(session.stripPassthroughFlags, ["--server"]);
        } finally {
          await session.cleanup();
        }
      }
    });
  });

  test("run-agent on 1.x adds nothing", async () => {
    const { bin } = npmInstall(join(box.dir, "ra-1"), "opencode-ai", "1.18.32");
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      const session = await launch([]);
      try {
        assert.equal(session.args, undefined);
        assert.equal(session.stripPassthroughFlags, undefined);
      } finally {
        await session.cleanup();
      }
    });
  });

  test("open adds --standalone on 2.x only with the inline model", async () => {
    const { bin } = npmInstall(join(box.dir, "open-2"), "@opencode/cli", "2.3.0");
    const config = join(process.env.AIAND_HOME, ".config", "opencode", "opencode.json");
    mkdirSync(join(config, ".."), { recursive: true });
    await withEnv({ PATH: hermeticPath(bin, "/usr/bin", "/bin") }, async () => {
      writeFileSync(
        config,
        JSON.stringify({
          model: "anthropic/claude-x",
          provider: { aiand: { models: { "zai-org/glm-5.3": {} } } },
        }),
      );
      const own = await opencodeAdapter.openExtras({ args: [] });
      assert.deepEqual(own.args, ["--standalone"]);
      assert.match(own.env.OPENCODE_CONFIG_CONTENT, /aiand\/zai-org\/glm-5\.3/);
      writeFileSync(config, JSON.stringify({ model: "aiand/zai-org/glm-5.3" }));
      // The shared service re-reads opencode.json itself: nothing to add.
      assert.deepEqual(await opencodeAdapter.openExtras({ args: [] }), {});
    });
  });
});

describe("OpenCode Desktop without the terminal program", {
  skip: process.platform !== "darwin",
}, () => {
  function state() {
    const root = join(box.dir, `desktop-${Math.random().toString(36).slice(2)}`);
    const home = join(root, "home");
    mkdirSync(join(home, "Applications", "OpenCode.app"), { recursive: true });
    const cfg = join(root, "cfg");
    seedCatalogCache(cfg);
    return {
      home,
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        AIAND_API_KEY: FAKE_API_KEY,
        AIAND_BASE_URL: CLOSED_URL,
        PATH: hermeticPath("/usr/bin", "/bin"),
      }),
    };
  }

  test("status lists both programs, and on wires the config the app reads", async () => {
    const { home, env } = state();
    const status = await runCli(["opencode", "status", "--json"], { env });
    assert.equal(status.code, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.installed, true);
    assert.deepEqual(parsed.surfaces, [
      { name: "terminal", path: null },
      { name: "desktop", path: join(home, "Applications", "OpenCode.app") },
    ]);
    const on = await runCli(["opencode", "on"], { env });
    assert.equal(on.code, 0, on.stderr);
    assert.ok(existsSync(join(home, ".config", "opencode", "opencode.json")));
  });

  test("aiand opencode wires and points at the app instead of failing", async () => {
    const { home, env } = state();
    const open = await runCli(["opencode"], { env });
    assert.equal(open.code, 0, open.stderr);
    assert.match(open.stdout, /aiand does not launch the app: open OpenCode Desktop/);
    const config = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(config.provider.aiand.options["x-aiand"], true);
    const withArgs = await runCli(["opencode", "run", "hi"], { env });
    assert.equal(withArgs.code, 1);
    assert.match(withArgs.stderr, /Only the OpenCode desktop app is installed/);
  });

  test("run-agent with only the app fails before any sign-in", async () => {
    const { env } = state();
    delete env.AIAND_API_KEY; // signed out: a login prompt here would be the bug
    const result = await runCli(["run-agent", "opencode", "--", "run", "hi"], { env });
    assert.equal(result.code, 127);
    assert.match(result.stderr, /Only the OpenCode desktop app is installed/);
    assert.doesNotMatch(result.stderr + result.stdout, /sign in|log in|login/i);
  });

  test("aiand status names the terminal and the desktop app", async () => {
    const { home, env } = state();
    const terminalBin = join(home, "..", "bin");
    plantStub(terminalBin, "opencode", "exit 1");
    const result = await runCli(["status"], {
      env: { ...env, PATH: `${terminalBin}${delimiter}${env.PATH}` },
    });
    assert.match(result.stdout, /terminal: .*opencode, desktop: .*OpenCode\.app/);
  });
});

describe("pre-XDG configs", { skip: !posix }, () => {
  test("off strips a marked provider aiand wrote to ~/.config before honoring XDG", async () => {
    const root = join(box.dir, "legacy");
    const home = join(root, "home");
    const legacy = join(home, ".config", "opencode", "opencode.json");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        theme: "dark",
        provider: { aiand: { options: { apiKey: "sk-old", "x-aiand": true } } },
      }),
    );
    const cfg = join(root, "cfg");
    seedCatalogCache(cfg);
    // HOME, not AIAND_HOME: the legacy path only differs when XDG applies.
    const env = cliEnv({
      AIAND_HOME: undefined,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "xdg"),
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
    });
    const off = await runCli(["opencode", "off"], { env });
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /stripped the aiand provider from .*which OpenCode does not read/);
    assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), { theme: "dark" });
  });

  test("the pre-XDG cleanup keeps a private file private", async () => {
    const root = join(box.dir, "legacy-mode");
    const home = join(root, "home");
    const legacy = join(home, ".config", "opencode", "opencode.json");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({
        provider: {
          other: { options: { apiKey: "sk-other-provider" } },
          aiand: { options: { apiKey: "sk-old", "x-aiand": true } },
        },
      }),
      { mode: 0o600 },
    );
    chmodSync(legacy, 0o600);
    const cfg = join(root, "cfg");
    seedCatalogCache(cfg);
    const env = cliEnv({
      AIAND_HOME: undefined,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "xdg"),
      AIAND_CONFIG_DIR: cfg,
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: CLOSED_URL,
    });
    assert.equal((await runCli(["opencode", "off"], { env })).code, 0);
    assert.equal(statSync(legacy).mode & 0o777, 0o600, "another provider's key stays private");
    assert.equal(
      JSON.parse(readFileSync(legacy, "utf8")).provider.other.options.apiKey,
      "sk-other-provider",
    );
  });

  test("a record of another config path never hands its model to this one", async () => {
    // Through `aiand opencode on` the snapshot that holds the record is
    // replaced when the path changes; this pins the adapter-level guard.
    const config = join(process.env.AIAND_HOME, ".config", "opencode", "opencode.json");
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, JSON.stringify({ model: "aiand/zai-org/glm-5.3" }));
    await recordAddedState("opencode", {
      model: "aiand/zai-org/glm-5.3",
      previousModel: "anthropic/claude-x",
      configPath: "/elsewhere/opencode/opencode.json",
    });
    seedCatalogCache(process.env.AIAND_CONFIG_DIR);
    await opencodeAdapter.enable(
      enableInput({
        model: "zai-org/glm-5.3",
        catalog: [catalogModel("zai-org/glm-5.3")],
        baseUrl: CLOSED_URL,
      }),
    );
    await opencodeAdapter.disable();
    assert.equal(JSON.parse(readFileSync(config, "utf8")).model, "aiand/zai-org/glm-5.3");
  });
});

/** withEnv for synchronous bodies. */
function withEnvSync(vars, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
