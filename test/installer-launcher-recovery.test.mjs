// The directory swap and launcher publication must agree even across a change
// between the prebuilt and npm layouts. Exercise the command, not just metadata.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  caseDir,
  controlledNodePath,
  newReleaseDouble,
  prebuiltFixtureBytes,
  publishToDouble,
  ROOT,
  runInstaller,
  stubTarball,
  tarEntry,
} from "./installer-fixtures.mjs";

const OLD = "9.0.1";
const NEW = "9.7.0";
let double;
before(async () => {
  double = await newReleaseDouble();
  for (const version of [OLD, NEW]) {
    const scripts = ["install.sh", "install.ps1"].map((name) =>
      tarEntry(`package/${name}`, readFileSync(join(ROOT, name)), { mode: 0o755 }),
    );
    publishToDouble(double, version, {
      tarball: stubTarball(version, scripts),
      prebuilt: prebuiltFixtureBytes(version),
    });
  }
});
after(() => double.close());
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});

for (const prebuilt of [false, true]) {
  test(`install.sh: a symlinked install directory runs the new ${prebuilt ? "prebuilt" : "npm"} version`, {
    skip: process.platform !== "linux",
  }, async () => {
    const c = caseDir();
    try {
      const initial = await runInstaller("sh", c.dir, { env: releaseEnv(OLD) });
      assert.equal(initial.status, 0, initial.stderr);
      const install = join(initial.home, ".aiand", "cli");
      const previous = join(initial.home, "old-target");
      renameSync(install, previous);
      symlinkSync(previous, install);
      const noNode = controlledNodePath(c.dir);
      const path = prebuilt ? noNode.path : process.env.PATH;
      const run = await runInstaller("sh", c.dir, {
        args: ["update"],
        env: { ...releaseEnv(NEW), ...noNode.env },
        path,
      });
      assert.equal(run.status, 0, run.stderr);
      const result = spawnSync(join(initial.home, ".local", "bin", "aiand"), ["--version"], {
        env: { ...process.env, HOME: initial.home, PATH: path },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), NEW);
      assert.equal(JSON.parse(readFileSync(join(previous, "package.json"))).version, OLD);
    } finally {
      c.cleanup();
    }
  });
}

test("install.sh: a failed first swap move leaves shell PATH configuration unchanged", {
  skip: process.platform !== "linux",
}, async () => {
  const c = caseDir();
  try {
    const initial = await runInstaller("sh", c.dir, { env: releaseEnv(OLD) });
    assert.equal(initial.status, 0, initial.stderr);
    const install = join(initial.home, ".aiand", "cli");
    const rc = join(initial.home, ".bashrc");
    writeFileSync(rc, "# existing shell configuration\n");
    const bin = join(c.dir, "failed-move-bin");
    mkdirSync(bin);
    const fired = join(c.dir, "move-failed");
    const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "mv"),
      `#!/bin/sh
if [ "$1" = "${install}" ]; then
  : > "${fired}"
  exit 1
fi
exec "${realMv}" "$@"
`,
    );
    chmodSync(join(bin, "mv"), 0o755);
    const run = await runInstaller("sh", c.dir, {
      args: ["update"],
      env: { ...releaseEnv(NEW), AIAND_NO_MODIFY_PATH: undefined, SHELL: "/bin/bash" },
      path: `${bin}:${process.env.PATH}`,
    });
    assert.ok(existsSync(fired));
    assert.notEqual(run.status, 0);
    assert.equal(readFileSync(rc, "utf8"), "# existing shell configuration\n");
    const result = spawnSync(join(initial.home, ".local", "bin", "aiand"), ["--version"], {
      env: { ...process.env, HOME: initial.home },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), OLD);
  } finally {
    c.cleanup();
  }
});

for (const failure of ["TERM", "KILL", "write-error"]) {
  test(`install.sh: ${failure} while writing the launcher preserves the old command`, {
    skip: process.platform !== "linux",
  }, async () => {
    const c = caseDir();
    try {
      const initial = await runInstaller("sh", c.dir, { env: releaseEnv(OLD) });
      assert.equal(initial.status, 0, initial.stderr);
      const launcher = join(initial.home, ".local", "bin", "aiand");
      const original = readFileSync(launcher);
      const bin = join(c.dir, "write-failure-bin");
      mkdirSync(bin);
      const fired = join(c.dir, "write-failed");
      const realCat = spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim();
      writeFileSync(
        join(bin, "cat"),
        `#!/bin/sh
case "$(readlink /proc/$$/fd/1)" in
  "${launcher}" | "${initial.home}/.local/bin/.aiand-launcher-"*)
    : > "${fired}"
    printf '#!/usr/bin/env bash\\n# partial launcher\\n'
    ${failure === "write-error" ? "exit 74" : `kill -${failure} "$PPID"; exit 0`} ;;
esac
exec "${realCat}" "$@"
`,
      );
      chmodSync(join(bin, "cat"), 0o755);
      const run = await runInstaller("sh", c.dir, {
        args: ["update"],
        env: releaseEnv(NEW),
        path: `${bin}:${process.env.PATH}`,
      });
      assert.ok(existsSync(fired), "the launcher write was reached");
      if (failure === "KILL") assert.equal(run.signal, "SIGKILL");
      else assert.equal(run.status, failure === "TERM" ? 130 : 74, run.stderr);
      assert.deepEqual(readFileSync(launcher), original);
      const result = spawnSync(launcher, ["--version"], {
        env: { ...process.env, HOME: initial.home },
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), OLD);
    } finally {
      c.cleanup();
    }
  });
}

function interrupt(dir, install, point, signal) {
  const bin = join(dir, "interrupt-bin");
  mkdirSync(bin);
  const tool = point === "after-cleanup" ? "rm" : "mv";
  const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  const fired = join(dir, "interrupted");
  const match =
    tool === "rm"
      ? `for arg in "$@"; do case "$arg" in "${install}.prev-$PPID"*) hit=1 ;; esac; done`
      : `case "$1" in */.cli-staging-*) [ "$2" = "${install}" ] && hit=1 ;; esac`;
  writeFileSync(
    join(bin, tool),
    `#!/bin/sh
hit=0
${match}
if [ "$hit" = 1 ] && [ ! -e "${fired}" ]; then
  : > "${fired}"
  ${point === "between-moves" ? ":" : `"${real}" "$@" || exit $?`}
  kill -${signal} "$PPID"
  exit 0
fi
exec "${real}" "$@"
`,
  );
  chmodSync(join(bin, tool), 0o755);
  return { bin, fired };
}

for (const fromPrebuilt of [true, false]) {
  for (const point of ["between-moves", "after-swap", "after-cleanup"]) {
    for (const signal of ["TERM", "KILL"]) {
      test(`install.sh: ${fromPrebuilt ? "prebuilt to npm" : "npm to prebuilt"}, ${signal} ${point}`, {
        skip: process.platform !== "linux",
      }, async () => {
        const c = caseDir();
        try {
          const noNode = controlledNodePath(c.dir);
          const firstPath = fromPrebuilt ? noNode.path : process.env.PATH;
          const updatePath = fromPrebuilt ? process.env.PATH : noNode.path;
          const initial = await runInstaller("sh", c.dir, {
            env: { ...releaseEnv(OLD), ...noNode.env },
            path: firstPath,
          });
          assert.equal(initial.status, 0, initial.stderr);
          const install = join(initial.home, ".aiand", "cli");
          const launcher = join(initial.home, ".local", "bin", "aiand");
          // Upgrade from the old route-specific launcher, not just the new template.
          writeFileSync(
            launcher,
            fromPrebuilt
              ? `#!/usr/bin/env bash\n# aiand launcher\nexec "${install}/aiand" "$@"\n`
              : `#!/usr/bin/env bash\n# aiand launcher\nNODE_BIN="\${AIAND_NODE_BIN:-${process.execPath}}"\nexec "$NODE_BIN" --disable-warning=ExperimentalWarning "${install}/dist/index.js" "$@"\n`,
          );
          chmodSync(launcher, 0o755);
          const launch = () =>
            spawnSync(launcher, ["--version"], {
              env: { ...process.env, HOME: initial.home, PATH: updatePath },
              encoding: "utf8",
              timeout: 5000,
            });
          assert.equal(launch().stdout.trim(), OLD);
          const sentinel = join(initial.home, ".aiand", "unrelated.txt");
          writeFileSync(sentinel, "preserve this\n");
          const { bin, fired } = interrupt(c.dir, install, point, signal);
          const run = await runInstaller("sh", c.dir, {
            args: ["update"],
            installerPath: join(install, "install.sh"),
            env: { ...releaseEnv(NEW), ...noNode.env },
            path: `${bin}:${updatePath}`,
          });
          assert.ok(existsSync(fired), "the interruption boundary was reached");
          if (signal === "TERM") assert.equal(run.status, 130, run.stderr);
          else assert.equal(run.signal, "SIGKILL");
          const expected = point === "between-moves" ? OLD : NEW;
          if (point !== "between-moves" || signal !== "KILL") {
            const result = launch();
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), expected);
          }
          // A killed mid-swap run needs an external installer because its directory
          // is absent. Otherwise exercise the copy preserved by the installed release.
          const retry = await runInstaller("sh", c.dir, {
            args: ["update"],
            ...(existsSync(install) ? { installerPath: join(install, "install.sh") } : {}),
            env: { ...releaseEnv("9.99.99"), ...noNode.env },
            path: updatePath,
          });
          assert.notEqual(retry.status, 0, "the retry download fails");
          const result = launch();
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout.trim(), expected);
          assert.equal(readFileSync(sentinel, "utf8"), "preserve this\n");
        } finally {
          c.cleanup();
        }
      });
    }
  }
}
