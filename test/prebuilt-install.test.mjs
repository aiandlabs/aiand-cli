import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  caseDir,
  controlledNodePath,
  HAS_BASH,
  hostPrebuiltAssetName,
  leftovers,
  newReleaseDouble,
  OWNERSHIP_MARKER,
  PWSH,
  prebuiltFixtureBytes,
  publishToDouble,
  ROOT,
  runInstaller,
  seedInstall,
} from "./installer-fixtures.mjs";

const HOSTS = [
  ["install.sh", "sh", HAS_BASH ? false : "no bash on PATH"],
  ["install.ps1", "ps1", PWSH ? false : "no pwsh on PATH"],
];

let double;
before(async () => {
  double = await newReleaseDouble();
});
after(() => double.close());

let counter = 0;
const nextVersion = () => `10.${++counter}.0`;
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});
const installDir = (home) => join(home, ".aiand", "cli");
const packageAt = (home) =>
  JSON.parse(readFileSync(join(installDir(home), "package.json"), "utf8"));
const requestsSince = (offset) => double.requests.slice(offset);

function seedLaunchers(home) {
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const bash = join(bin, "aiand");
  const cmd = join(bin, "aiand.cmd");
  writeFileSync(bash, "#!/bin/sh\n# aiand launcher (seeded install)\nexit 99\n");
  chmodSync(bash, 0o755);
  writeFileSync(cmd, "@echo off\r\nREM aiand launcher (seeded install)\r\nexit /b 99\r\n");
  return {
    bash,
    cmd,
    bashBytes: readFileSync(bash),
    cmdBytes: readFileSync(cmd),
  };
}

function assertSeedPreserved(home, version, seeded) {
  assert.equal(packageAt(home).version, version);
  assert.ok(readFileSync(seeded.bash).equals(seeded.bashBytes), "the Bash launcher is untouched");
  assert.ok(readFileSync(seeded.cmd).equals(seeded.cmdBytes), "the cmd launcher is untouched");
  assert.deepEqual(leftovers(home), []);
}

function launcherWithControlledPath(kind, home, fixture) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: fixture.path, ...fixture.env };
  for (const [key, value] of Object.entries(fixture.env)) {
    if (value === undefined) delete env[key];
  }
  const bin = join(home, ".local", "bin");
  const launcher = join(
    bin,
    kind === "ps1" && process.platform === "win32" ? "aiand.cmd" : "aiand",
  );
  const [command, args] =
    process.platform === "win32" && kind === "sh"
      ? ["bash", [launcher, "--version"]]
      : [launcher, ["--version"]];
  return spawnSync(command, args, {
    env,
    encoding: "utf8",
    // A .cmd launcher needs the host command processor on Windows, never Node.
    shell: process.platform === "win32" && kind === "ps1",
  });
}

for (const [file, kind, skip] of HOSTS) {
  test(`${file} installs a verified host prebuilt without Node on PATH`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version, { prebuilt: prebuiltFixtureBytes(version) });
      const fixture = controlledNodePath(c.dir);
      const requestOffset = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(version), ...fixture.env },
        path: fixture.path,
      });
      assert.equal(run.status, 0, run.stderr);
      const installed = packageAt(run.home);
      assert.deepEqual(installed, { name: "@aiand/cli", version });
      const nativeName = process.platform === "win32" ? "aiand.exe" : "aiand";
      assert.ok(existsSync(join(installDir(run.home), nativeName)));
      for (const script of ["install.sh", "install.ps1"]) {
        assert.ok(
          readFileSync(join(installDir(run.home), script)).equals(readFileSync(join(ROOT, script))),
        );
      }
      assert.ok(existsSync(join(installDir(run.home), OWNERSHIP_MARKER)));
      assert.equal(existsSync(join(installDir(run.home), "dist", "index.js")), false);
      assert.deepEqual(leftovers(run.home), []);

      const launched = launcherWithControlledPath(kind, run.home, fixture);
      assert.equal(launched.status, 0, launched.stderr);
      assert.equal(launched.stdout.trim(), version);
      assert.ok(
        !requestsSince(requestOffset).some((path) => path.startsWith("/npm/")),
        "the prebuilt route never requests an npm manifest or tarball",
      );
      assert.ok(
        requestsSince(requestOffset).includes(
          `/rel/download/v${version}/${hostPrebuiltAssetName()}`,
        ),
      );
    } finally {
      c.cleanup();
    }
  });

  test(`${file} selects prebuilt when Node is below the installer minimum`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version, { prebuilt: prebuiltFixtureBytes(version) });
      const fixture = controlledNodePath(c.dir, "old");
      const requestOffset = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(version), ...fixture.env },
        path: fixture.path,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(packageAt(run.home).version, version);
      assert.ok(existsSync(fixture.oldNodeLog), "the old-Node probe actually ran");
      const calls = readFileSync(fixture.oldNodeLog, "utf8");
      assert.doesNotMatch(calls, /fetch-release|dist[\\/]index\.js/);
      assert.ok(!requestsSince(requestOffset).some((path) => path.startsWith("/npm/")));
    } finally {
      c.cleanup();
    }
  });

  test(`${file} keeps suitable Node on the verified npm release path`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version, { prebuilt: prebuiltFixtureBytes(version) });
      const requestOffset = double.requests.length;
      const run = await runInstaller(kind, c.dir, { env: releaseEnv(version) });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(packageAt(run.home).version, version);
      assert.ok(existsSync(join(installDir(run.home), "dist", "index.js")));
      assert.match(
        run.stderr,
        /Verified @aiand\/cli .* against npm's sha512 and the release's SHA256SUMS/,
      );
      assert.ok(
        !requestsSince(requestOffset).some((path) => path.endsWith(`/${hostPrebuiltAssetName()}`)),
      );
    } finally {
      c.cleanup();
    }
  });

  test(`${file} refuses a prebuilt SHA256SUMS mismatch`, { skip }, async () => {
    const c = caseDir();
    try {
      const oldVersion = "9.0.0";
      const version = nextVersion();
      publishToDouble(double, version, {
        prebuilt: prebuiltFixtureBytes(version),
        prebuiltServed: Buffer.from("tampered prebuilt bytes"),
      });
      seedInstall(join(c.dir, "home", ".aiand", "cli"), oldVersion);
      const seeded = seedLaunchers(join(c.dir, "home"));
      const fixture = controlledNodePath(c.dir);
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(version), ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /prebuilt.*SHA256SUMS|SHA256SUMS.*prebuilt|integrity check failed/i);
      assertSeedPreserved(run.home, oldVersion, seeded);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} refuses a prebuilt with the wrong version`, { skip }, async () => {
    const c = caseDir();
    try {
      const oldVersion = "9.0.0";
      const version = nextVersion();
      publishToDouble(double, version, {
        prebuilt: prebuiltFixtureBytes(version, { printVersion: "0.0.1" }),
      });
      seedInstall(join(c.dir, "home", ".aiand", "cli"), oldVersion);
      const seeded = seedLaunchers(join(c.dir, "home"));
      const fixture = controlledNodePath(c.dir);
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(version), ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /staged aiand verification failed/);
      assertSeedPreserved(run.home, oldVersion, seeded);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} refuses a prebuilt whose help fails`, { skip }, async () => {
    const c = caseDir();
    try {
      const oldVersion = "9.0.0";
      const version = nextVersion();
      publishToDouble(double, version, {
        prebuilt: prebuiltFixtureBytes(version, { helpExit: 3 }),
      });
      seedInstall(join(c.dir, "home", ".aiand", "cli"), oldVersion);
      const seeded = seedLaunchers(join(c.dir, "home"));
      const fixture = controlledNodePath(c.dir);
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(version), ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /staged aiand verification failed/);
      assertSeedPreserved(run.home, oldVersion, seeded);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} refuses an implicit prebuilt downgrade`, { skip }, async () => {
    const c = caseDir();
    try {
      const oldVersion = "20.0.0";
      const version = nextVersion();
      publishToDouble(double, version, { prebuilt: prebuiltFixtureBytes(version), latest: true });
      seedInstall(join(c.dir, "home", ".aiand", "cli"), oldVersion);
      const seeded = seedLaunchers(join(c.dir, "home"));
      const fixture = controlledNodePath(c.dir);
      const requestOffset = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        env: { ...releaseEnv(undefined), ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Refusing to downgrade/);
      assertSeedPreserved(run.home, oldVersion, seeded);
      assert.ok(requestsSince(requestOffset).includes("/rel/latest/download/SHA256SUMS"));
    } finally {
      c.cleanup();
    }
  });

  test(`${file} keeps development installs dependent on Node`, { skip }, async () => {
    const c = caseDir();
    try {
      const fixture = controlledNodePath(c.dir);
      const requestOffset = double.requests.length;
      const localCheckout = join(c.dir, "local-checkout");
      mkdirSync(join(localCheckout, "dist"), { recursive: true });
      writeFileSync(
        join(localCheckout, "package.json"),
        JSON.stringify({ name: "@aiand/cli", version: "0.0.0-local" }),
      );
      writeFileSync(join(localCheckout, "dist", "index.js"), "// local work stays here\n");
      const localInstaller = join(localCheckout, file);
      copyFileSync(join(ROOT, file), localInstaller);
      const local = await runInstaller(kind, c.dir, {
        installerPath: localInstaller,
        env: fixture.env,
        path: fixture.path,
      });
      assert.notEqual(local.status, 0);
      assert.match(local.stderr, /Node\.js 22\+ is required/);
      assert.equal(existsSync(installDir(local.home)), false);
      assert.equal(
        JSON.parse(readFileSync(join(localCheckout, "package.json"), "utf8")).version,
        "0.0.0-local",
      );

      const source = join(c.dir, "source-checkout");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "local-work.txt"), "keep me\n");
      const cloned = await runInstaller(kind, c.dir, {
        env: { AIAND_SOURCE: source, ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(cloned.status, 0);
      assert.match(cloned.stderr, /Node\.js 22\+ is required/);
      assert.equal(readFileSync(join(source, "local-work.txt"), "utf8"), "keep me\n");
      assert.equal(requestsSince(requestOffset).length, 0);
    } finally {
      c.cleanup();
    }
  });
}

// macOS's /bin/bash 3.2 in a UTF-8 locale once matched a byte-range bracket
// against ordinary letters and printed every prebuilt error as blanks. The
// message mixes text with C0, DEL, an encoded C1, a bidi override, a lone C1
// byte and a truncated sequence; bash builds it so raw bytes survive argv.
const PREBUILT_ERROR_FNS = (() => {
  const source = readFileSync(join(ROOT, "install.sh"), "utf8");
  return ["prebuilt_error", "prebuilt_printable_utf8"]
    .map((name) => source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"))?.[0])
    .join("");
})();
const PREBUILT_ERROR_CALL = String.raw`prebuilt_error "Refusing é 日本 — a"$'\x1b'"]0;t"$'\x07'"b"$'\xc2\x9b'"2Jc"$'\x7f'"d"$'\xe2\x80\xae'"e lone"$'\x9b'"X bad"$'\xe2\x9b'"Y"$'\x01'"Z"`;

function prebuiltError(locale) {
  return spawnSync("bash", ["-c", `${PREBUILT_ERROR_FNS}\n${PREBUILT_ERROR_CALL}`], {
    env: { ...process.env, LANG: locale, LC_ALL: locale },
  });
}

// Whether bash, under this locale, reads UTF-8 (a missing locale falls back to C).
function bashReadsUtf8(locale) {
  const run = spawnSync("bash", ["-c", "p=$'\\xc3\\xa9'; [[ $p == ? ]] && echo 1"], {
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    encoding: "utf8",
  });
  return run.stdout.trim() === "1";
}

test("install.sh defines the prebuilt_error helpers", { skip: !HAS_BASH }, () => {
  assert.match(PREBUILT_ERROR_FNS, /^prebuilt_error\(\) \{[\s\S]*^prebuilt_printable_utf8\(\) \{/m);
});

for (const locale of ["C.UTF-8", "en_US.UTF-8"]) {
  test(`install.sh prebuilt_error keeps text and drops controls under LC_ALL=${locale}`, {
    skip: !HAS_BASH ? "no bash on PATH" : bashReadsUtf8(locale) ? false : `no ${locale} locale`,
  }, () => {
    const run = prebuiltError(locale);
    assert.equal(run.status, 0, run.stderr.toString());
    assert.equal(
      run.stderr.toString("utf8"),
      "error: Refusing é 日本 — a ]0;t b  2Jc d e lone X bad  Y Z\n",
    );
  });
}

test("install.sh prebuilt_error drops every C0 and C1 byte under LC_ALL=C", {
  skip: HAS_BASH ? false : "no bash on PATH",
}, () => {
  const run = prebuiltError("C");
  assert.equal(run.status, 0, run.stderr.toString());
  const bytes = [...run.stderr.subarray(0, -1)];
  assert.deepEqual(
    bytes.filter((b) => b < 0x20 || (b >= 0x7f && b <= 0x9f)),
    [],
    run.stderr.toString("latin1"),
  );
  assert.match(run.stderr.toString("latin1"), /^error: Refusing .* lone X bad\xe2 Y Z\n$/);
});
