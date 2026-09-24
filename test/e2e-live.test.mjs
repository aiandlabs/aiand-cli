// Live end-to-end: `aiand opencode on` points an installed opencode at the
// gateway, then `opencode run "…"` must return the expected word. Real network
// calls to api.aiand.com are the point: no mocks, no offline catalog.
//
// Activates only when BOTH are present:
//   - process.env.AIAND_API_KEY (repo secret in CI, withheld on fork PRs)
//   - the `opencode` binary on PATH (installed in CI per INSTALL_HINTS.opencode)
// Otherwise the file registers a single skipped test and exits 0.
// Fork CI with a billed-out key skips the live assertion (balance is not a
// CLI failure). Official-repo CI still fails so an empty org key is visible.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { INSTALL_HINTS } from "../dist/agents/detect.js";

const bin = join(dirname(import.meta.dirname), "dist", "index.js");
const PROMPT = "Reply with exactly the single word: pong";
// A live on + a real model call; each step gets its own cap inside the whole.
const LIVE_TEST_TIMEOUT_MS = 420_000;
const LIVE_STEP_TIMEOUT_MS = 180_000;

function binaryOnPath(name) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
  });
  return probe.status === 0 && !probe.error;
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter((s) => typeof s === "string" && s.length > 0)
    .join("\n");
}

const hasKey = Boolean(process.env.AIAND_API_KEY);
const hasBinary = binaryOnPath("opencode");
const skipReason = !hasKey
  ? "AIAND_API_KEY is not set — live gateway assertions need a real key"
  : !hasBinary
    ? `opencode binary not on PATH — install it with: ${INSTALL_HINTS.opencode.command}`
    : null;

if (skipReason) {
  test("live opencode e2e (skipped without key+binary)", { skip: skipReason }, () => {});
} else {
  test("live opencode e2e: on -> run -> assert", { timeout: LIVE_TEST_TIMEOUT_MS }, (t) => {
    // Sandbox both homes: the CLI resolves configs from AIAND_HOME, opencode
    // from HOME/XDG_CONFIG_HOME (USERPROFILE, HOMEDRIVE+HOMEPATH, APPDATA and
    // LOCALAPPDATA on win32). Pointing them all at one sandbox keeps the real
    // home untouched and makes the file the CLI writes the one opencode reads.
    // XDG_CONFIG_HOME is set, not deleted, so an ambient CI value can't win.
    //
    // AIAND_API_KEY rides only the CLI `on` child, which bakes it into the
    // sandbox config. `opencode run` authenticates through that config file,
    // so the key is stripped from its environment — a leaked env var would
    // hand it to every process the agent spawns.
    const sandbox = mkdtempSync(join(tmpdir(), "aiand-e2e-live-"));
    const home = join(sandbox, "home");
    const work = join(sandbox, "work");
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    let phase = "setup";
    let runOut = "";
    const { AIAND_API_KEY: liveKey, ...scrubbed } = process.env;
    const scrub = (value) =>
      typeof value === "string" && liveKey ? value.split(liveKey).join("[redacted]") : value;
    try {
      const sandboxEnv = {
        ...scrubbed,
        AIAND_HOME: home,
        AIAND_CONFIG_DIR: join(sandbox, "config"),
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        // Real network calls are the point here: lift test/net-guard.mjs.
        AIAND_TEST_ALLOW_NETWORK: "1",
      };
      if (process.platform === "win32") {
        const { root } = parse(home);
        sandboxEnv.USERPROFILE = home;
        sandboxEnv.HOMEDRIVE = root.replace(/[\\/]$/, "");
        sandboxEnv.HOMEPATH = home.slice(root.length - 1);
        sandboxEnv.APPDATA = join(home, "AppData", "Roaming");
        sandboxEnv.LOCALAPPDATA = join(home, "AppData", "Local");
        mkdirSync(sandboxEnv.APPDATA, { recursive: true });
        mkdirSync(sandboxEnv.LOCALAPPDATA, { recursive: true });
      }
      const cli = (args, timeoutMs) =>
        execFileSync("node", [bin, ...args], {
          encoding: "utf8",
          env: { ...sandboxEnv, AIAND_API_KEY: liveKey },
          timeout: timeoutMs,
          cwd: work,
          stdio: ["ignore", "pipe", "pipe"],
        });

      // (a) Sanity: `opencode on --json` wires the sandbox config. Exit 0 and
      // JSON reporting routing/model is the assertion; the live catalog
      // resolves the default model, so no --model flag (exercises that path).
      phase = "opencode on --json";
      const onOut = cli(["opencode", "on", "--json"], LIVE_STEP_TIMEOUT_MS);
      const on = JSON.parse(onOut);
      assert.equal(on.agent, "opencode");
      assert.equal(on.state, "on");
      assert.ok(typeof on.model === "string" && on.model.length > 0, "wired model reported");
      const configPath = join(home, ".config", "opencode", "opencode.json");
      assert.ok(on.files.includes(configPath), `opencode.json in files: ${on.files}`);
      assert.ok(existsSync(configPath), "opencode.json written to sandbox home");
      assert.match(readFileSync(configPath, "utf8"), /api\.aiand\.com/, "config routes at ai&");

      // (b) The real ask: `opencode run` against the live gateway through the
      // config step (a) just wrote, assert the deterministic word comes back.
      phase = `opencode run "${PROMPT}"`;
      runOut = execFileSync("opencode", ["run", PROMPT], {
        encoding: "utf8",
        env: sandboxEnv,
        timeout: LIVE_STEP_TIMEOUT_MS,
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Static assertion text: no child stdout/stderr interpolation. A
      // scrubbed, truncated reply is attached to the thrown error below.
      assert.match(runOut, /pong/i, "gateway replied with the expected word");
    } catch (error) {
      const insufficient = /insufficient credits/i.test(errorText(error));
      const officialCi = process.env.GITHUB_REPOSITORY === "aiandlabs/aiand-cli";
      if (insufficient && !officialCi) {
        t.skip("live gateway returned insufficient credits");
        return;
      }
      error.message = scrub(`[e2e-live] failed during ${phase}: ${error.message}`);
      for (const key of ["stdout", "stderr", "actual"]) {
        if (typeof error[key] === "string") error[key] = scrub(error[key]);
      }
      if (runOut && phase.startsWith("opencode run")) {
        error.cause = { reply: scrub(runOut).slice(0, 500) };
      }
      throw error;
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
