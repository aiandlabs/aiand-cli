// #175: a first activation must not redirect an existing checkout's launcher
// until the new installation exists. All failures use disposable local fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import {
  caseDir,
  controlledNodePath,
  newReleaseDouble,
  prebuiltFixtureBytes,
  publishToDouble,
  runInstaller,
} from "./installer-fixtures.mjs";

const OLD = "9.0.1";
const NEW = "9.7.0";
const linuxOnly = { skip: process.platform !== "linux" };
let double;
before(async () => {
  double = await newReleaseDouble();
  publishToDouble(double, OLD);
  publishToDouble(double, NEW, { prebuilt: prebuiltFixtureBytes(NEW) });
});
after(() => double.close());
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});

test("prebuilt install uses only explicit no-Node tools", linuxOnly, async () => {
  const c = caseDir();
  try {
    const controlled = controlledNodePath(c.dir);
    // No incidental /usr/bin or /bin tools: these disappear on hosts with Node
    // in those directories, even though the Node container keeps them on PATH.
    const path = controlled.path.split(delimiter)[0];
    const run = await runInstaller("sh", c.dir, {
      env: { ...releaseEnv(NEW), ...controlled.env },
      path,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = spawnSync(join(run.home, ".local", "bin", "aiand"), ["--version"], {
      env: { ...process.env, HOME: run.home, PATH: path },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), NEW);
  } finally {
    c.cleanup();
  }
});

for (const existingLauncher of [true, false]) {
  for (const failure of ["move-error", "TERM", "KILL"]) {
    test(`first activation ${failure}, launcher=${existingLauncher}`, linuxOnly, async () => {
      const c = caseDir();
      try {
        const home = join(c.dir, "home");
        const install = join(home, ".aiand", "cli");
        const launcher = join(home, ".local", "bin", "aiand");
        let original;
        if (existingLauncher) {
          const seed = await runInstaller("sh", c.dir, { env: releaseEnv(OLD) });
          assert.equal(seed.status, 0, seed.stderr);
          const checkout = join(home, "checkout");
          renameSync(install, checkout);
          writeFileSync(
            launcher,
            `#!/usr/bin/env bash\n# aiand launcher\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${checkout}/dist/index.js" "$@"\n`,
          );
          chmodSync(launcher, 0o755);
          original = readFileSync(launcher);
        }
        const bin = join(c.dir, "failed-first-activation");
        mkdirSync(bin);
        const fired = join(c.dir, "interrupted");
        const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
        writeFileSync(
          join(bin, "mv"),
          `#!/bin/sh
case "$1" in
  */.cli-staging-*)
    if [ "$2" = "${install}" ]; then
      : > "${fired}"
      ${failure === "move-error" ? "exit 1" : `kill -${failure} "$PPID"; exit 0`}
    fi ;;
esac
exec "${realMv}" "$@"
`,
        );
        chmodSync(join(bin, "mv"), 0o755);
        const run = await runInstaller("sh", c.dir, {
          args: ["update"],
          env: releaseEnv(NEW),
          path: `${bin}:${process.env.PATH}`,
        });
        assert.ok(existsSync(fired), "first activation boundary was reached");
        if (failure === "KILL") assert.equal(run.signal, "SIGKILL");
        else assert.equal(run.status, failure === "TERM" ? 130 : 1, run.stderr);
        assert.equal(existsSync(install), false);
        const assertLauncher = () => {
          if (!existingLauncher) {
            assert.equal(existsSync(launcher), false, "no dangling launcher was published");
            return;
          }
          assert.deepEqual(readFileSync(launcher), original);
          const result = spawnSync(launcher, ["--version"], {
            env: { ...process.env, HOME: home },
            encoding: "utf8",
            timeout: 5000,
          });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout.trim(), OLD);
        };
        assertLauncher();
        const retry = await runInstaller("sh", c.dir, {
          args: ["update"],
          env: releaseEnv("9.99.99"),
        });
        assert.notEqual(retry.status, 0, "retry cannot download its release");
        assertLauncher();
      } finally {
        c.cleanup();
      }
    });
  }
}
