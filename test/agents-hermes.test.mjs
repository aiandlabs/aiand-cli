import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test, { describe } from "node:test";
import {
  captureStdio,
  catalogModel,
  cliEnv,
  hermeticPath,
  plantStub,
  runCli,
  seedCatalogCache,
  withEnv,
  withTestEnv,
} from "./helpers.mjs";

// The Hermes adapter: launcher-only membership (detect/status/refusals) plus
// the throwaway HERMES_HOME overlay sessionLaunch builds. Tests drive the
// built adapter from ../dist/agents/hermes/adapter.js against a temp home shaped like
// a real ~/.hermes: state to symlink back, credentials that must stay
// isolated, user plugins to link back (minus our own provider id), and a
// config.yaml with its own model: section.

let home, cfg, stubBin;
const env = withTestEnv("aiand-hermes-", (dir) => {
  home = join(dir, "home");
  cfg = join(dir, "cfg");
  stubBin = join(dir, "bin");
  mkdirSync(stubBin, { recursive: true });

  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  process.env.AIAND_API_KEY = "sk-test-not-real";
  seedCatalogCache(cfg);
});

const hermes = await import("../dist/agents/hermes/adapter.js");
const setup = await import("../dist/agents/setup.js");

const realHome = () => join(home, ".hermes");

/** A real-shaped ~/.hermes: state, credentials, plugins, config, env. */
function plantHermesHome() {
  const dir = realHome();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "plugins", "model-providers", "other"), { recursive: true });
  mkdirSync(join(dir, "plugins", "model-providers", "aiand"), { recursive: true });
  mkdirSync(join(dir, "plugins", "extra-tool"), { recursive: true });
  writeFileSync(join(dir, "sessions", "s1.json"), '{"s":1}\n');
  writeFileSync(join(dir, "skills", "keep.txt"), "skill\n");
  writeFileSync(join(dir, "plugins", "extra-tool", "keep.txt"), "tool\n");
  writeFileSync(join(dir, "plugins", "model-providers", "other", "p.py"), "plugin\n");
  writeFileSync(join(dir, "plugins", "model-providers", "aiand", "stale.py"), "stale\n");
  writeFileSync(join(dir, "tokens.json"), '{"token":"x"}\n');
  writeFileSync(join(dir, "auth-credentials.json"), '{"a":1}\n');
  writeFileSync(
    join(dir, "config.yaml"),
    'theme: dark\nmodel:\n  # user comment\n  provider: "auto"\n  default: "user-model"\n  base_url: "https://openrouter.ai/api/v1"\n\nother:\n  key: 1\n',
  );
  writeFileSync(
    join(dir, ".env"),
    'USER_KEY=keep\nANTHROPIC_API_KEY="user-key"\nexport ANTHROPIC_BASE_URL="https://proxy.example"\nANTHROPIC_TOKEN="tok"\nAIAND_HERMES_API_KEY="stale"\nAIAND_HERMES_BASE_URL="https://stale.example"\n',
  );
  return dir;
}

/** File bytes + dir listings, recursively: the whole real-home snapshot. */
function snapshotTree(dir) {
  const rows = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    rows.push(name, st.isDirectory() ? snapshotTree(path) : readFileSync(path).toString("base64"));
  }
  return rows.join("|");
}

const sessionInput = (overrides = {}) => ({
  apiKey: "sk-test-key-0000000000000000000000",
  model: "zai-org/glm-5.3",
  catalog: [],
  baseUrl: "https://api.aiand.com",
  profileName: "default",
  ...overrides,
});

describe("hermes adapter: membership", () => {
  test("detect reports the binary on PATH", async () => {
    plantStub(stubBin, "hermes");
    const detected = await withEnv({ PATH: hermeticPath(stubBin, "/usr/bin") }, () =>
      hermes.hermesAdapter.detect(),
    );
    assert.equal(detected.installed, true);
    assert.equal(detected.path, join(stubBin, "hermes"));
  });

  test("detect misses without the binary", async () => {
    rmSync(join(stubBin, "hermes"), { force: true });
    const detected = await withEnv({ PATH: hermeticPath(dirname(process.execPath)) }, () =>
      hermes.hermesAdapter.detect(),
    );
    assert.deepEqual(detected, { installed: false, path: null });
  });

  test("probe is always inactive", async () => {
    assert.deepEqual(await hermes.hermesAdapter.probe(), { active: false, model: null });
  });

  test("managedFiles is empty: nothing persistent is ever written", () => {
    assert.deepEqual(hermes.hermesAdapter.managedFiles(), []);
  });

  test("agentOn refuses with the per-session message", async () => {
    await assert.rejects(setup.agentOn(hermes.hermesAdapter), (error) => {
      assert.match(error.message, /per session only/);
      assert.match(error.hint, /aiand run-agent hermes/);
      return true;
    });
  });

  test("agentOff refuses with the per-session message", async () => {
    await assert.rejects(setup.agentOff(hermes.hermesAdapter), (error) => {
      assert.match(error.message, /per session only/);
      assert.match(error.hint, /aiand run-agent hermes/);
      return true;
    });
  });

  test("status --json reports installed and off through the CLI", async () => {
    plantStub(stubBin, "hermes");
    const { code, stdout } = await runCli(["hermes", "status", "--json"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.agent, "hermes");
    assert.equal(parsed.installed, true);
    assert.equal(parsed.state, "off");
    assert.equal(parsed.model, null);
  });

  test("hermes / on / off all refuse through the CLI", async () => {
    for (const args of [["hermes"], ["hermes", "on"], ["hermes", "off"]]) {
      const { code, stderr } = await runCli(args, {
        env: cliEnv({ AIAND_HOME: home, AIAND_CONFIG_DIR: cfg }),
      });
      assert.equal(code, 1, `${args.join(" ")} exits 1`);
      assert.match(stderr, /per session only/);
      assert.match(stderr, /aiand run-agent hermes/);
    }
  });

  test("help hermes prints the verbs", async () => {
    const { code, stdout } = await runCli(["help", "hermes"], {
      env: cliEnv({ AIAND_HOME: home, AIAND_CONFIG_DIR: cfg }),
    });
    assert.equal(code, 0);
    assert.match(stdout, /aiand hermes \[on\|off\|status\]/);
    assert.match(stdout, /Verbs/);
  });

  test("status without the binary exits 0 and prints the install hint", async () => {
    rmSync(join(stubBin, "hermes"), { force: true });
    const { code, stdout, stderr } = await runCli(["hermes", "status"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: hermeticPath(dirname(process.execPath)),
      }),
    });
    assert.equal(code, 0, "missing binary is still a successful status report");
    assert.match(stdout, /installed\s+no/);
    assert.match(stderr, /Install it with: curl -fsSL https:\/\/hermes-agent\.nousresearch\.com/);
    assert.match(stderr, /hermes-agent\.nousresearch\.com\/docs/);
  });

  test("aiand status never lists hermes: launcher-only is off the wiring surface", async () => {
    plantStub(stubBin, "hermes");
    const { stdout } = await runCli(["status", "--json", "--local"], {
      env: cliEnv({
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: cfg,
        PATH: `${stubBin}${delimiter}${process.env.PATH}`,
      }),
    });
    const ids = (JSON.parse(stdout).agents ?? []).map((row) => row.agent).sort();
    assert.deepEqual(ids, ["claude", "codex", "opencode"]);
  });
});

describe("hermes adapter: sessionLaunch overlay", () => {
  test("builds the overlay, routes through the aiand provider, cleans up", async () => {
    plantHermesHome();
    const before = snapshotTree(realHome());
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());

    const overlay = launch.env.HERMES_HOME;
    assert.ok(overlay.includes("aiand-hermes-"), "overlay dir name");

    // The key never rides the child env: routing travels as provider args +
    // HERMES_* pointers, and the secret itself only in the overlay .env.
    assert.deepEqual(launch.env, {
      HERMES_HOME: overlay,
      HERMES_INFERENCE_PROVIDER: "aiand",
      HERMES_MODEL: "zai-org/glm-5.3",
      HERMES_INFERENCE_MODEL: "zai-org/glm-5.3",
    });
    assert.deepEqual(launch.args, ["--provider", "aiand", "--model", "zai-org/glm-5.3"]);
    // The launcher's generic strip owns the passthrough filtering; the
    // adapter only declares which routing flags it owns.
    assert.deepEqual(launch.stripPassthroughFlags, ["--provider", "--model", "-m"]);

    // State symlinks back; credentials never link.
    if (process.platform !== "win32") {
      assert.equal(readlinkSync(join(overlay, "sessions")), join(realHome(), "sessions"));
      assert.equal(readlinkSync(join(overlay, "skills")), join(realHome(), "skills"));
      // User plugins link back one by one, minus our own provider id.
      assert.equal(
        readlinkSync(join(overlay, "plugins", "extra-tool")),
        join(realHome(), "plugins", "extra-tool"),
      );
      assert.equal(
        readlinkSync(join(overlay, "plugins", "model-providers", "other")),
        join(realHome(), "plugins", "model-providers", "other"),
      );
    } else {
      assert.equal(readFileSync(join(overlay, "sessions", "s1.json"), "utf8"), '{"s":1}\n');
      assert.equal(
        readFileSync(join(overlay, "plugins", "extra-tool", "keep.txt"), "utf8"),
        "tool\n",
      );
    }
    assert.ok(!existsSync(join(overlay, "tokens.json")));
    assert.ok(!existsSync(join(overlay, "auth-credentials.json")));
    // Our provider id is overlay-only (a stale user file under it never
    // shadows this launch), written fresh as real files, never links.
    const providerDir = join(overlay, "plugins", "model-providers", "aiand");
    assert.equal(lstatSync(providerDir).isSymbolicLink(), false, "our provider is a real dir");
    assert.ok(!existsSync(join(providerDir, "stale.py")), "stale user file under our id stays out");
    const initPy = readFileSync(join(providerDir, "__init__.py"), "utf8");
    assert.ok(initPy.includes('api_mode="chat_completions"'), "chat completions mode");
    assert.ok(
      initPy.includes('env_vars=("AIAND_HERMES_API_KEY", "AIAND_HERMES_BASE_URL")'),
      "dedicated env names",
    );
    assert.ok(initPy.includes('fallback_models=("zai-org/glm-5.3",)'), "pinned fallback");
    assert.ok(initPy.includes('item.pop("name", None)'), "tool-role name pop");
    assert.ok(initPy.includes("register_provider(aiand)"));
    const pluginYaml = readFileSync(join(providerDir, "plugin.yaml"), "utf8");
    assert.ok(pluginYaml.includes("kind: model-provider"));

    // The overlay .env: 0600, user lines carried, ours stripped then written.
    const envPath = join(overlay, ".env");
    const envText = readFileSync(envPath, "utf8");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.ok(envText.includes("USER_KEY=keep"));
    assert.ok(envText.includes('AIAND_HERMES_API_KEY="sk-test-key-0000000000000000000000"'));
    assert.ok(envText.includes('AIAND_HERMES_BASE_URL="https://api.aiand.com"'));
    assert.ok(!envText.includes("user-key"), "user ANTHROPIC_API_KEY stripped");
    assert.ok(!envText.includes("proxy.example"), "user ANTHROPIC_BASE_URL stripped");
    assert.ok(!envText.includes("stale"), "stale AIAND_HERMES_* stripped");

    // The overlay config.yaml: providers.aiand block plus the model pin.
    const configText = readFileSync(join(overlay, "config.yaml"), "utf8");
    assert.ok(statSync(join(overlay, "config.yaml")).isFile());
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    assert.ok(configText.includes("key_env: AIAND_HERMES_API_KEY"));
    assert.ok(configText.includes("transport: chat_completions"));
    assert.ok(configText.includes('default_model: "zai-org/glm-5.3"'));
    assert.ok(configText.includes('models: ["zai-org/glm-5.3"]'));
    assert.ok(configText.includes("discover_models: false"));
    assert.ok(configText.includes("theme: dark"), "user keys survive");
    assert.ok(configText.includes("# user comment"), "comments survive");
    assert.ok(configText.includes("other:"), "later sections survive");
    assert.ok(!configText.includes('"user-model"'), "the user model is replaced");

    // The real home is untouched; cleanup removes the overlay.
    assert.equal(snapshotTree(realHome()), before);
    await launch.cleanup();
    assert.equal(existsSync(overlay), false);
  });

  test("--model native leaves the model unpinned", async () => {
    plantHermesHome();
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput({ model: "native" }));
    // The provider is still forced (routing must stay on the gateway); only
    // the model id is left to Hermes's own default, so no --model rides.
    assert.deepEqual(launch.args, ["--provider", "aiand"]);
    assert.deepEqual(launch.env, {
      HERMES_HOME: launch.env.HERMES_HOME,
      HERMES_INFERENCE_PROVIDER: "aiand",
    });
    const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "user-model"/);
    assert.ok(!configText.includes("zai-org"), "no aiand-pinned default");
    assert.ok(!configText.includes("default_model"), "the providers block names no model");
    assert.ok(configText.includes("key_env: AIAND_HERMES_API_KEY"), "the provider still routes");
    const initPy = readFileSync(
      join(launch.env.HERMES_HOME, "plugins", "model-providers", "aiand", "__init__.py"),
      "utf8",
    );
    assert.ok(initPy.includes("fallback_models=()"), "empty fallback tuple");
    await launch.cleanup();
  });

  test("pinHermesModel rewrites the scalar sentinel without a duplicate key", () => {
    // The pure seam: a fresh install's `model: ""` must become the mapping,
    // not keep its scalar value in front of it.
    const out = hermes.pinHermesModel(
      '_config_version: 49\nmodel: ""\nother:\n  key: 1\n',
      "zai-org/glm-5.3",
    );
    assert.equal(
      out,
      '_config_version: 49\nmodel:\n  provider: aiand\n  default: "zai-org/glm-5.3"\nother:\n  key: 1\n',
    );
    assert.equal(hermes.pinHermesModel('model: ""\n', undefined), "model:\n  provider: aiand\n");
  });

  test("pinHermesProvider appends, merges, and replaces the aiand block", () => {
    const appended = hermes.pinHermesProvider("theme: dark\n", "https://api.aiand.com", "m/1");
    assert.ok(appended.includes("providers:\n  aiand:"), "block appended");
    assert.ok(appended.includes('default_model: "m/1"'));
    assert.ok(appended.includes('models: ["m/1"]'));
    assert.ok(appended.includes("theme: dark"), "user keys survive");

    const merged = hermes.pinHermesProvider(
      "providers:\n  other:\n    base_url: x\n",
      "https://api.aiand.com",
      "m/1",
    );
    assert.ok(merged.includes("other:\n    base_url: x"), "other providers survive");
    assert.ok(merged.includes("  aiand:"), "aiand added alongside");

    const replaced = hermes.pinHermesProvider(
      'providers:\n  aiand:\n    base_url: "old"\n    models: ["old"]\n  other:\n    k: v\n',
      "https://api.aiand.com",
      "m/2",
    );
    assert.ok(!replaced.includes('"old"'), "the stale block is replaced");
    assert.ok(replaced.includes('default_model: "m/2"'));
    assert.ok(replaced.includes("other:\n    k: v"), "siblings survive");

    const native = hermes.pinHermesProvider("theme: dark\n", "https://api.aiand.com", undefined);
    assert.ok(native.includes("key_env: AIAND_HERMES_API_KEY"), "connection stays");
    assert.ok(!native.includes("default_model"), "native names no model");
    assert.ok(!/^ {2}models:/m.test(native), "native lists no models");
  });

  test("a symlinked real config.yaml is copied, never linked", async () => {
    // The copy is by NAME: Dirent.isFile() is false for a symlink, so an
    // isFile() gate would link it and the overlay edit would write through
    // to the real home.
    const dir = plantHermesHome();
    const target = join(dir, "config.target.yaml");
    writeFileSync(target, 'theme: dark\nmodel:\n  provider: "auto"\n  default: "user-model"\n');
    rmSync(join(dir, "config.yaml"));
    symlinkSync(target, join(dir, "config.yaml"));
    const before = readFileSync(target, "utf8");
    const overlay = await hermes.buildHermesOverlay(dir, {
      apiKey: "sk-test-key-0000000000000000000000",
      baseUrl: "https://api.aiand.com",
      model: "zai-org/glm-5.3",
    });
    try {
      const overlayConfig = join(overlay, "config.yaml");
      assert.equal(lstatSync(overlayConfig).isSymbolicLink(), false, "overlay config is a copy");
      assert.match(readFileSync(overlayConfig, "utf8"), /provider: aiand/);
      assert.equal(readFileSync(target, "utf8"), before, "the link target is untouched");
    } finally {
      rmSync(overlay, { recursive: true, force: true });
    }
  });

  test("no --model resolves the catalog default", async () => {
    plantHermesHome();
    const launch = await hermes.hermesAdapter.sessionLaunch(
      sessionInput({ model: undefined, catalog: [catalogModel("zai-org/glm-5.3")] }),
    );
    const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    await launch.cleanup();
  });

  test("a config without a model: section gets one prepended", async () => {
    const dir = plantHermesHome();
    writeFileSync(join(dir, "config.yaml"), "theme: dark\n");
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
    const configText = readFileSync(join(launch.env.HERMES_HOME, "config.yaml"), "utf8");
    assert.ok(configText.startsWith("model:"), "model block first");
    assert.match(configText, /provider: aiand/);
    assert.match(configText, /default: "zai-org\/glm-5\.3"/);
    assert.ok(configText.includes("theme: dark"));
    await launch.cleanup();
  });

  test("a missing real home still launches (fresh install)", async () => {
    rmSync(realHome(), { recursive: true, force: true });
    const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
    const envText = readFileSync(join(launch.env.HERMES_HOME, ".env"), "utf8");
    assert.match(envText, /AIAND_HERMES_API_KEY=/);
    await launch.cleanup();
  });

  test("AIAND_DEBUG=1 logs the launch to stderr", async () => {
    plantHermesHome();
    const capture = captureStdio();
    let launch;
    try {
      launch = await withEnv({ AIAND_DEBUG: "1" }, () =>
        hermes.hermesAdapter.sessionLaunch(sessionInput()),
      );
    } finally {
      capture.restore();
    }
    try {
      const err = capture.log.err.join("");
      assert.match(err, /\[aiand hermes\] mode: pinned/);
      assert.match(err, /\[aiand hermes\] model: zai-org\/glm-5\.3/);
      assert.match(err, /\[aiand hermes\] base URL: https:\/\/api\.aiand\.com/);
      assert.match(err, /\[aiand hermes\] home overlay: .*aiand-hermes-/);
    } finally {
      await launch.cleanup();
    }
  });

  test("HERMES_HOME env override is honoured as the real home", async () => {
    plantHermesHome();
    const elsewhere = mkdtempSync(join(dirname(home), "hermes-elsewhere-"));
    const previous = process.env.HERMES_HOME;
    process.env.HERMES_HOME = elsewhere;
    try {
      const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
      const overlay = launch.env.HERMES_HOME;
      // The empty override home contributes nothing: no state came across.
      assert.ok(!existsSync(join(overlay, "sessions")), "no state carried from the real home");
      assert.ok(existsSync(join(overlay, ".env")), "routing still written");
      await launch.cleanup();
    } finally {
      process.env.HERMES_HOME = previous;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("cleanup restores the store shims and only removes overlay-pointing additions", async () => {
    // #36 Hermes rewrites checkout/.hermes/bin/* to whatever HERMES_HOME the
    // session ran under; without the restore, cleanup deletes the path its
    // own `hermes` binary points at. The PATH entry here is a symlink to the
    // store shim — the shape that stranded a real install during verification.
    const shims = join(env.dir, "checkout", ".hermes", "bin");
    mkdirSync(shims, { recursive: true });
    const original = "#!/bin/sh\nexec /real/store/python3 -I -c 'script'\n";
    writeFileSync(join(shims, "hermes"), original, { mode: 0o755 });
    writeFileSync(join(shims, "hermes-acp"), "original-acp\n");
    const pathDir = join(env.dir, "shim-path");
    mkdirSync(pathDir, { recursive: true });
    symlinkSync(join(shims, "hermes"), join(pathDir, "hermes"));

    const previousPath = process.env.PATH;
    process.env.PATH = `${pathDir}${delimiter}${previousPath}`;
    try {
      const launch = await hermes.hermesAdapter.sessionLaunch(sessionInput());
      const overlay = launch.env.HERMES_HOME;
      // Simulate the session relocating the shims, plus additions: ones that
      // point at the overlay (cleanup's to remove) and a legit one (kept).
      writeFileSync(join(shims, "hermes"), `#!/bin/sh\nexec ${overlay}/tools/python3 -I -c 'x'\n`);
      writeFileSync(join(shims, "hermes-acp"), "relocated\n");
      symlinkSync(join(overlay, ".env"), join(shims, "added-link"));
      writeFileSync(join(shims, "added-file"), `#!/bin/sh\nexec ${overlay}/tools/python3\n`);
      writeFileSync(join(shims, "user-note.txt"), "the user's own addition\n");

      await launch.cleanup();
      assert.equal(readFileSync(join(shims, "hermes"), "utf8"), original, "store shim restored");
      assert.equal(readFileSync(join(shims, "hermes-acp"), "utf8"), "original-acp\n");
      assert.ok(!existsSync(join(shims, "added-link")), "an overlay-pointing link is removed");
      assert.ok(!existsSync(join(shims, "added-file")), "an overlay-pointing file is removed");
      assert.equal(
        readFileSync(join(shims, "user-note.txt"), "utf8"),
        "the user's own addition\n",
        "a legit addition survives",
      );
      assert.equal(existsSync(overlay), false, "overlay removed");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
