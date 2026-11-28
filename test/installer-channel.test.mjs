// `--channel next` (install.ps1: `-Channel next`, or the same flag): the
// installers take the build of main npm calls `next`, resolved through the
// SHA256SUMS on the rolling `next` prerelease and checked against npm's sha512,
// the same two-party check a release gets. Served from a loopback double.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  caseDir,
  controlledNodePath,
  HAS_BASH,
  leftovers,
  newReleaseDouble,
  PWSH,
  publishToDouble,
  runInstaller,
  seedInstall,
  sha256,
  stubTarball,
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
// Each case gets its own major, so the shared double's builds never collide.
const nextBuild = (major) =>
  `${major}.0.1-next.20261128090503.g${(++counter).toString(16).padStart(7, "0")}`;
let majors = 10;
const freshMajor = () => ++majors;

const doubleEnv = () => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
});

/** Publish `version` to npm and name it in the next prerelease's SHA256SUMS. */
function publishNext(version, { sums } = {}) {
  publishToDouble(double, version);
  const dir = join(double.root, "rel", "download", "next");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SHA256SUMS"),
    sums ?? `${sha256(stubTarball(version))}  aiand-cli-${version}.tgz\n`,
  );
  writeFileSync(
    join(double.root, "npm", "@aiand", "cli", "next"),
    JSON.stringify({ name: "@aiand/cli", version }),
  );
}

function unpublishNext() {
  rmSync(join(double.root, "rel", "download", "next"), { recursive: true, force: true });
}

const installedVersion = (home) =>
  JSON.parse(readFileSync(join(home, ".aiand", "cli", "package.json"), "utf8")).version;

/** Run with a seeded install of `installed` (or none). */
async function run(kind, { installed, args = [], env = {}, path } = {}) {
  const c = caseDir();
  try {
    if (installed) seedInstall(join(c.dir, "home", ".aiand", "cli"), installed);
    const result = await runInstaller(kind, c.dir, { args, env: { ...doubleEnv(), ...env }, path });
    let version = null;
    try {
      version = installedVersion(result.home);
    } catch {
      // no install
    }
    return { ...result, version, leftovers: leftovers(result.home) };
  } finally {
    c.cleanup();
  }
}

// pwsh off Windows cannot run the aiand.cmd it writes, so its exit code is not read on success.
const ok = (kind, r) => {
  if (kind === "sh") assert.equal(r.status, 0, r.stderr);
};

for (const [file, kind, skip] of HOSTS) {
  describe(file, () => {
    const flag = kind === "sh" ? ["--channel", "next"] : ["-Channel", "next"];

    test("the next flag installs the build the next prerelease names", { skip }, async () => {
      const major = freshMajor();
      const build = nextBuild(major);
      publishNext(build);
      const r = await run(kind, { installed: `${major}.0.0`, args: flag });
      ok(kind, r);
      assert.equal(r.version, build, r.stderr);
      assert.match(r.stderr, /against npm's sha512 and the next prerelease's SHA256SUMS/);
      assert.deepEqual(r.leftovers, []);
    });

    test("--channel=next and --channel next work as well", { skip }, async () => {
      for (const args of [["--channel=next"], ["--channel", "next"]]) {
        const major = freshMajor();
        const build = nextBuild(major);
        publishNext(build);
        const r = await run(kind, { installed: `${major}.0.0`, args });
        ok(kind, r);
        assert.equal(r.version, build, `${args.join(" ")}: ${r.stderr}`);
      }
    });

    test("AIAND_CHANNEL=next picks the channel when no flag does", { skip }, async () => {
      const major = freshMajor();
      const build = nextBuild(major);
      publishNext(build);
      const r = await run(kind, { installed: `${major}.0.0`, env: { AIAND_CHANNEL: "next" } });
      ok(kind, r);
      assert.equal(r.version, build, r.stderr);
    });

    test("update over a next build stays on next", { skip }, async () => {
      const major = freshMajor();
      const older = nextBuild(major);
      const newer = nextBuild(major).replace("20261128090503", "20261129090503");
      publishNext(newer);
      const r = await run(kind, { installed: older, args: ["update"] });
      ok(kind, r);
      assert.equal(r.version, newer, r.stderr);
      assert.match(r.stderr, /Staying on the next channel/);
    });

    test("going back to stable from a newer next build is a refused downgrade", {
      skip,
    }, async () => {
      const major = freshMajor();
      const build = nextBuild(major);
      publishToDouble(double, `${major}.0.0`, { latest: true });
      const stable = kind === "sh" ? ["--channel", "stable"] : ["-Channel", "stable"];
      const r = await run(kind, { installed: build, args: ["update", ...stable] });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /older than the installed/);
      assert.equal(r.version, build, "the install it found is untouched");
    });

    test("a next prerelease that names a release is refused", { skip }, async () => {
      const major = freshMajor();
      const release = `${major}.0.2`;
      publishToDouble(double, release);
      publishNext(nextBuild(major), {
        sums: `${sha256(stubTarball(release))}  aiand-cli-${release}.tgz\n`,
      });
      const r = await run(kind, { installed: `${major}.0.0`, args: flag });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /which is not a build of main/);
      assert.equal(r.version, `${major}.0.0`);
    });

    test("a tarball the next SHA256SUMS does not vouch for is refused", { skip }, async () => {
      const major = freshMajor();
      const build = nextBuild(major);
      publishNext(build, { sums: `${"0".repeat(64)}  aiand-cli-${build}.tgz\n` });
      const r = await run(kind, { installed: `${major}.0.0`, args: flag });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /does not match the sha256 in the next prerelease's SHA256SUMS/);
      assert.equal(r.version, `${major}.0.0`);
      assert.deepEqual(r.leftovers, []);
    });

    test("with no next build published, it says so and changes nothing", { skip }, async () => {
      unpublishNext();
      const r = await run(kind, { installed: "10.0.0", args: flag });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no build of main is published yet/);
      assert.equal(r.version, "10.0.0");
    });

    test("the next channel with AIAND_VERSION is refused", { skip }, async () => {
      const r = await run(kind, {
        installed: "10.0.0",
        args: flag,
        env: { AIAND_VERSION: "10.0.0" },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /AIAND_VERSION picks a release/);
      assert.equal(r.version, "10.0.0");
    });

    test("an unknown channel prints usage and changes nothing", { skip }, async () => {
      const bad = kind === "sh" ? ["--channel", "beta"] : ["-Channel", "beta"];
      const r = await run(kind, { installed: "10.0.0", args: bad });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /unknown channel beta/);
      assert.match(
        r.stderr,
        /Usage: (bash install\.sh|install\.ps1) \[update\] \[--channel stable\|next\]/,
      );
      assert.equal(r.version, "10.0.0");
    });

    test("the next channel without Node stops instead of taking a prebuilt", { skip }, async () => {
      const major = freshMajor();
      publishNext(nextBuild(major));
      const c = caseDir();
      try {
        seedInstall(join(c.dir, "home", ".aiand", "cli"), `${major}.0.0`);
        const fixture = controlledNodePath(c.dir);
        const r = await runInstaller(kind, c.dir, {
          args: flag,
          env: { ...doubleEnv(), ...fixture.env },
          path: fixture.path,
        });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /next channel installs builds of main from npm, which needs Node/);
        assert.equal(installedVersion(r.home), `${major}.0.0`);
      } finally {
        c.cleanup();
      }
    });
  });
}
