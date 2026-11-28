// Installs on a network that reaches neither GitHub nor registry.npmjs.org:
// through company mirrors (the npm config's registry, and --mirror), and from
// an offline bundle (--from) with no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { buildOfflineBundles } from "../scripts/offline-bundle.mjs";
import { CLOSED_URL } from "./helpers.mjs";
import {
  caseDir,
  controlledNodePath,
  HAS_BASH,
  hostPrebuiltAssetName,
  INSTALLER_DIR,
  leftovers,
  newReleaseDouble,
  PWSH,
  prebuiltFixtureBytes,
  publishToDouble,
  runInstaller,
  seedInstall,
  sha256,
  stubTarball,
} from "./installer-fixtures.mjs";

// Constrained Language Mode support for the rest of install.ps1 (its stderr
// writer, temp folder and file writes) is the managed-Windows change; until
// that is in this checkout, only this file's own code could be held to it.
const PS1_CLM_READY = readFileSync(join(INSTALLER_DIR, "install.ps1"), "utf8").includes(
  "$script:FullLanguage",
);
const HOSTS = [
  ["install.sh", "sh", HAS_BASH ? false : "no bash on PATH"],
  ["install.ps1", "ps1", PWSH ? false : "no pwsh on PATH"],
  // How AppLocker and App Control for Business run a script they have not approved.
  [
    "install.ps1 (Constrained Language Mode)",
    "ps1-clm",
    !PWSH
      ? "no pwsh on PATH"
      : PS1_CLM_READY
        ? false
        : "install.ps1 here predates its Constrained Language Mode support",
  ],
];

let double;
before(async () => {
  double = await newReleaseDouble();
});
after(() => double.close());

let counter = 0;
const nextVersion = () => `20.${++counter}.0`;
const installDir = (home) => join(home, ".aiand", "cli");
const installedVersion = (home) =>
  JSON.parse(readFileSync(join(installDir(home), "package.json"), "utf8")).version;
const HOST_PLATFORM = `${process.platform}-${process.arch}`;

// Any request an offline install makes would land on the double and be counted.
const watchedEnv = () => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
});

/** A release directory as publish.yml stages it, plus the host's prebuilt. */
function stageRelease(dir, version, { prebuilt = true } = {}) {
  const release = join(dir, `release-${version}`);
  mkdirSync(release, { recursive: true });
  const files = {
    [`aiand-cli-${version}.tgz`]: stubTarball(version),
    "install.sh": readFileSync(join(INSTALLER_DIR, "install.sh")),
    "install.ps1": readFileSync(join(INSTALLER_DIR, "install.ps1")),
  };
  if (prebuilt) files[hostPrebuiltAssetName()] = prebuiltFixtureBytes(version);
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(release, name), bytes);
  writeFileSync(
    join(release, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
      .join(""),
  );
  return release;
}

/** Unpack a bundle the way an administrator would: unzip for a .zip, tar otherwise. */
function extract(archive, destination) {
  const zip = archive.endsWith(".zip");
  const hasUnzip = zip && !spawnSync("unzip", ["-v"], { encoding: "utf8" }).error;
  const [command, args] = hasUnzip
    ? ["unzip", ["-q", archive, "-d", destination]]
    : ["tar", ["-xf", archive, "-C", destination]];
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${archive}: ${result.stderr}`);
}

/** Build every bundle for `version`; returns the host's archive and its unpacked copy. */
function hostBundle(dir, version, options) {
  const out = join(dir, `bundles-${version}`);
  const built = buildOfflineBundles(stageRelease(dir, version, options), out);
  const archive = built.find(({ name }) => name.includes(HOST_PLATFORM));
  assert.ok(archive, `a bundle for ${HOST_PLATFORM}`);
  const unpacked = join(dir, `unpacked-${version}`);
  mkdirSync(unpacked, { recursive: true });
  extract(join(out, archive.name), unpacked);
  const top = archive.name.replace(/\.(tar\.gz|zip)$/, "");
  return { archive: join(out, archive.name), directory: join(unpacked, top) };
}

for (const [file, kind, skip] of HOSTS) {
  test(`${file} --from installs an offline bundle with Node and makes no request`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      const bundle = hostBundle(c.dir, version);
      const before = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        args: ["--from", bundle.archive],
        env: watchedEnv(),
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.match(run.stderr, /against the offline bundle's SHA256SUMS/);
      assert.deepEqual(double.requests.slice(before), [], "an offline install makes no request");
      assert.deepEqual(leftovers(run.home), []);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} --from without Node installs the bundle's prebuilt and makes no request`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      const bundle = hostBundle(c.dir, version);
      const fixture = controlledNodePath(c.dir);
      const before = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        args: ["--from", bundle.archive],
        env: { ...watchedEnv(), ...fixture.env },
        path: fixture.path,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.match(run.stderr, /prebuilt @aiand\/cli .* against the offline bundle's SHA256SUMS/);
      assert.deepEqual(double.requests.slice(before), []);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} --from a bundle with no prebuilt says what this machine needs`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      const bundle = hostBundle(c.dir, version, { prebuilt: false });
      const fixture = controlledNodePath(c.dir);
      const run = await runInstaller(kind, c.dir, {
        args: ["--from", bundle.directory],
        env: { ...watchedEnv(), ...fixture.env },
        path: fixture.path,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /has no aiand-.*the prebuilt this machine needs without Node/);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} --from reads the Windows .zip bundle as well as a .tar.gz`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      const out = join(c.dir, "bundles");
      buildOfflineBundles(stageRelease(c.dir, version), out);
      const before = double.requests.length;
      // Any bundle installs where Node 22 or newer is on PATH: the npm tarball is the same.
      const run = await runInstaller(kind, c.dir, {
        args: ["--from", join(out, `aiand-offline-${version}-win32-x64.zip`)],
        env: watchedEnv(),
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.deepEqual(double.requests.slice(before), []);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} --from takes an unpacked bundle, and --sums-sha256 pins its SHA256SUMS`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const old = nextVersion();
      const version = nextVersion();
      const bundle = hostBundle(c.dir, version);
      const sums = sha256(readFileSync(join(bundle.directory, "SHA256SUMS")));
      const home = join(c.dir, "home");
      seedInstall(installDir(home), old);

      const wrong = await runInstaller(kind, c.dir, {
        args: ["--from", bundle.directory, "--sums-sha256", "0".repeat(64)],
        env: watchedEnv(),
      });
      assert.notEqual(wrong.status, 0);
      assert.match(wrong.stderr, new RegExp(`has sha256 ${sums}, not the 0{64}`));
      assert.equal(installedVersion(home), old, "a refused bundle leaves the install in place");
      assert.deepEqual(leftovers(home), []);

      // A trailing separator is trimmed (Windows PowerShell 5.1 would read \" as a quote).
      const pinned = await runInstaller(kind, c.dir, {
        args: ["--from", `${bundle.directory}/`],
        env: { ...watchedEnv(), AIAND_SUMS_SHA256: sums },
      });
      assert.equal(pinned.status, 0, pinned.stderr);
      assert.equal(installedVersion(home), version);
    } finally {
      c.cleanup();
    }
  });

  for (const [route, noNode] of [
    ["Node", false],
    ["prebuilt", true],
  ]) {
    test(`${file} refuses a bundle whose files do not match its SHA256SUMS (${route} route)`, {
      skip,
    }, async () => {
      const c = caseDir();
      try {
        const old = nextVersion();
        const version = nextVersion();
        const bundle = hostBundle(c.dir, version);
        const tampered = noNode ? hostPrebuiltAssetName() : `aiand-cli-${version}.tgz`;
        const path = join(bundle.directory, tampered);
        writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("\n")]));
        const home = join(c.dir, "home");
        seedInstall(installDir(home), old);
        const fixture = noNode ? controlledNodePath(c.dir) : undefined;
        const run = await runInstaller(kind, c.dir, {
          args: ["update", "--from", bundle.directory],
          env: { ...watchedEnv(), ...fixture?.env },
          path: fixture?.path,
        });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /integrity check failed: .*offline bundle's SHA256SUMS/);
        assert.equal(installedVersion(home), old);
        assert.deepEqual(leftovers(home), []);
      } finally {
        c.cleanup();
      }
    });
  }

  test(`${file} installs through the npm config's registry and a download mirror`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version);
      const before = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        args: ["--mirror", `${double.base}/mirror/aiand-cli/releases/`],
        env: {
          // The company registry comes from the npm config, as `npm config set registry` would leave it.
          npm_config_registry: `${double.base}/npm/`,
          npm_config_fetch_retries: "0",
          AIAND_VERSION: version,
        },
      });
      // The double serves the release under /rel; a mirror is any https or loopback base.
      assert.notEqual(run.status, 0, "nothing is served under /mirror yet");
      assert.match(
        run.stderr,
        /has no SHA256SUMS \(http:\/\/127\.0\.0\.1:\d+\/mirror\/aiand-cli\/releases\/download\/v[\d.]+\/SHA256SUMS\)/,
      );
      assert.ok(
        !double.requests.slice(before).some((path) => path.startsWith("/rel/")),
        "a mirror that fails is not replaced by the default release URL",
      );

      const mirrored = await runInstaller(kind, c.dir, {
        args: ["--mirror", `${double.base}/rel`],
        env: {
          npm_config_registry: `${double.base}/npm/`,
          npm_config_fetch_retries: "0",
          AIAND_VERSION: version,
        },
      });
      assert.equal(mirrored.status, 0, mirrored.stderr);
      assert.equal(installedVersion(mirrored.home), version);
      assert.match(
        mirrored.stderr,
        /using the npm registry http:\/\/127\.0\.0\.1:\d+\/npm from your npm config/,
      );
      const requests = double.requests.slice(before);
      assert.ok(requests.includes(`/rel/download/v${version}/SHA256SUMS`), requests.join("\n"));
      assert.ok(requests.includes("/npm/@aiand/cli"), "npm read the package document");
      assert.ok(requests.includes(`/npm/@aiand/cli/-/cli-${version}.tgz`));
    } finally {
      c.cleanup();
    }
  });

  test(`${file} refuses a tarball from the npm config's registry that SHA256SUMS does not list`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const old = nextVersion();
      const version = nextVersion();
      // The registry is consistent with itself: it serves other bytes and
      // lists their sha512. The SHA256SUMS (GitHub's stand-in) lists the real ones.
      const other = stubTarball(version, [], { cli: "// not the release\n" });
      publishToDouble(double, version, { served: other, npmIntegrityOf: other });
      const home = join(c.dir, "home");
      seedInstall(installDir(home), old);
      const run = await runInstaller(kind, c.dir, {
        env: {
          AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
          NPM_CONFIG_REGISTRY: `${double.base}/npm/`,
          npm_config_fetch_retries: "0",
          AIAND_VERSION: version,
        },
      });
      assert.notEqual(run.status, 0);
      assert.match(
        run.stderr,
        /using the npm registry http:\/\/127\.0\.0\.1:\d+\/npm from your npm config/,
      );
      assert.match(
        run.stderr,
        new RegExp(
          `integrity check failed: the tarball does not match the sha256 in the v${version.replaceAll(".", "\\.")} release's SHA256SUMS`,
        ),
      );
      assert.equal(installedVersion(home), old);
      assert.deepEqual(leftovers(home), []);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} gives npm no AIAND_ variable, so no registry sees a key`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version);
      // A Node whose npm records the AIAND_ names it was given, and answers as
      // a company registry would.
      const bin = join(c.dir, "node-with-recording-npm");
      const npmBin = join(bin, "node_modules", "npm", "bin");
      mkdirSync(npmBin, { recursive: true });
      const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
      copyFileSync(process.execPath, node);
      chmodSync(node, 0o755);
      const seen = join(c.dir, "npm-saw");
      writeFileSync(
        join(npmBin, "npm-cli.js"),
        [
          'const fs = require("fs");',
          `fs.appendFileSync(${JSON.stringify(seen)}, process.argv[2] + ":" + Object.keys(process.env).filter((k) => /^aiand_/i.test(k)).join(",") + "\\n");`,
          'if (process.argv[2] === "config") { console.log("registry=https://registry.example.com/"); process.exit(0); }',
          "process.exit(1);",
        ].join("\n"),
      );
      const run = await runInstaller(kind, c.dir, {
        env: {
          AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
          AIAND_API_KEY: "test-session-key-not-real",
          AIAND_SECRET_STORE_MASTER_KEY: "test-master-key-not-real",
          AIAND_VERSION: version,
        },
        path: `${bin}${delimiter}${process.env.PATH}`,
      });
      assert.notEqual(run.status, 0, "the recording npm fetches nothing");
      const calls = readFileSync(seen, "utf8").trim().split("\n");
      assert.deepEqual(
        calls,
        ["config:", "pack:"],
        "npm ran for config get and pack, seeing no AIAND_ name",
      );
    } finally {
      c.cleanup();
    }
  });

  test(`${file} stops when the npm config's registry fails, with no public fallback`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const old = nextVersion();
      const version = nextVersion();
      publishToDouble(double, version);
      const home = join(c.dir, "home");
      seedInstall(installDir(home), old);
      const run = await runInstaller(kind, c.dir, {
        args: ["--mirror", `${double.base}/rel`],
        env: {
          npm_config_registry: `${CLOSED_URL}/npm/`,
          npm_config_fetch_retries: "0",
          AIAND_VERSION: version,
        },
      });
      assert.notEqual(run.status, 0);
      assert.match(
        run.stderr,
        /npm could not fetch @aiand\/cli@[\d.]+ from http:\/\/127\.0\.0\.1:9\/npm/,
      );
      assert.match(run.stderr, /Nothing falls back to the public registry/);
      assert.equal(installedVersion(home), old);
      assert.deepEqual(leftovers(home), []);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} without Node downloads the prebuilt from --mirror`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version, { prebuilt: prebuiltFixtureBytes(version) });
      const fixture = controlledNodePath(c.dir);
      const before = double.requests.length;
      const run = await runInstaller(kind, c.dir, {
        args: ["--mirror", `${double.base}/rel`],
        env: { ...fixture.env, AIAND_VERSION: version },
        path: fixture.path,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.ok(
        double.requests
          .slice(before)
          .includes(`/rel/download/v${version}/${hostPrebuiltAssetName()}`),
      );
      // Nothing in the install says where it came from.
      assert.equal(existsSync(join(installDir(run.home), ".aiand-download-base")), false);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} update ignores a mirror file in the install and names --mirror when GitHub is out of reach`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const home = join(c.dir, "home");
      seedInstall(installDir(home), nextVersion());
      // A same-user process could write this; the installers never read it.
      writeFileSync(
        join(installDir(home), ".aiand-download-base"),
        "https://mirror.example.com/releases\n",
      );
      const run = await runInstaller(kind, c.dir, { args: ["update"] });
      assert.notEqual(run.status, 0);
      assert.doesNotMatch(run.stderr + run.stdout, /mirror\.example\.com/);
      assert.match(
        run.stderr,
        /could not reach https:\/\/github\.com\/aiandlabs\/aiand-cli\/releases/,
      );
      assert.match(
        run.stderr,
        /--mirror <url>, or ask IT to set the downloadMirror managed policy/,
      );
    } finally {
      c.cleanup();
    }
  });

  test(`${file} takes the mirror from the downloadMirror managed policy`, { skip }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      publishToDouble(double, version);
      const policy = join(c.dir, "policy.json");
      writeFileSync(
        policy,
        JSON.stringify({ baseUrl: "https://api.example", downloadMirror: `${double.base}/rel` }),
      );
      const env = {
        AIAND_INSTALL_POLICY_PATH: policy,
        AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
        AIAND_VERSION: version,
      };
      const before = double.requests.length;
      const run = await runInstaller(kind, c.dir, { args: ["update"], env });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.match(run.stderr, /the downloadMirror managed policy/);
      assert.ok(double.requests.slice(before).includes(`/rel/download/v${version}/SHA256SUMS`));

      const other = await runInstaller(kind, c.dir, {
        args: ["--mirror", `${double.base}/elsewhere`],
        env,
      });
      assert.notEqual(other.status, 0);
      assert.match(other.stderr, /managed policy sets downloadMirror to .*--mirror names/);

      // The tests' stand-in skips the root-owner check, so it may only name loopback.
      writeFileSync(policy, JSON.stringify({ downloadMirror: "https://mirror.example.com/r" }));
      const outside = await runInstaller(kind, c.dir, { env });
      assert.notEqual(outside.status, 0);
      assert.match(outside.stderr, /AIAND_INSTALL_POLICY_PATH is for the installer tests/);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} ignores AIAND_DOWNLOAD_BASE and AIAND_FROM: only flags choose the source`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const version = nextVersion();
      const bundle = hostBundle(c.dir, version);
      const other = hostBundle(c.dir, nextVersion());
      const before = double.requests.length;
      // A directory's .envrc could set these; neither redirects an install,
      // and neither stops an explicit --from.
      const run = await runInstaller(kind, c.dir, {
        args: ["--from", bundle.archive],
        env: {
          ...watchedEnv(),
          AIAND_DOWNLOAD_BASE: "https://mirror.example.com/releases",
          AIAND_FROM: other.directory,
        },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(installedVersion(run.home), version);
      assert.doesNotMatch(run.stderr + run.stdout, /mirror\.example\.com/);
      assert.deepEqual(double.requests.slice(before), []);
      assert.equal(existsSync(join(installDir(run.home), ".aiand-download-base")), false);
    } finally {
      c.cleanup();
    }
  });

  test(`${file} prints no terminal escapes from a --mirror or --from value`, { skip }, async () => {
    const c = caseDir();
    try {
      const osc = "\x1b]52;c;dGVzdA==\x07";
      const mirror = await runInstaller(kind, c.dir, {
        args: ["--mirror", `https://mirror.example.com/${osc}/releases`],
      });
      assert.notEqual(mirror.status, 0);
      const bundle = join(c.dir, `bundle-${osc}.tar.gz`);
      writeFileSync(bundle, "not a bundle\n");
      const from = await runInstaller(kind, c.dir, { args: ["--from", bundle] });
      assert.notEqual(from.status, 0);
      for (const run of [mirror, from]) {
        assert.doesNotMatch(run.stderr + run.stdout, /\x1b\]|\x07/);
      }
      assert.match(from.stderr, /could not unpack the offline bundle|not an offline bundle/);
    } finally {
      c.cleanup();
    }
  });

  for (const base of [
    "http://mirror.example.com/aiand-cli/releases",
    "https://user:secret@mirror.example.com/aiand-cli/releases",
    "https://mirror.example.com/aiand-cli/releases?token=1",
  ]) {
    test(`${file} refuses the download base ${base}`, { skip }, async () => {
      const c = caseDir();
      try {
        const run = await runInstaller(kind, c.dir, { args: ["--mirror", base] });
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /is not allowed; use an https:\/\/ URL with no user name/);
        assert.doesNotMatch(run.stdout + run.stderr, /Verified/);
      } finally {
        c.cleanup();
      }
    });
  }

  test(`${file} refuses --from together with --mirror, and unknown arguments`, {
    skip,
  }, async () => {
    const c = caseDir();
    try {
      const both = await runInstaller(kind, c.dir, {
        args: ["--from", c.dir, "--mirror", `${double.base}/rel`],
      });
      assert.notEqual(both.status, 0);
      assert.match(both.stderr, /use one of them/);
      const unknown = await runInstaller(kind, c.dir, { args: ["--registry", "x"] });
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.stderr, /Usage: .*--from <bundle>/);
    } finally {
      c.cleanup();
    }
  });
}

test("offline bundles: one per platform, each checked against the release", () => {
  const c = caseDir();
  try {
    const version = "9.8.7";
    const release = stageRelease(c.dir, version);
    const out = join(c.dir, "out");
    const built = buildOfflineBundles(release, out);
    assert.deepEqual(
      built.map(({ name }) => name),
      [
        `aiand-offline-${version}-darwin-arm64.tar.gz`,
        `aiand-offline-${version}-darwin-x64.tar.gz`,
        `aiand-offline-${version}-linux-x64.tar.gz`,
        `aiand-offline-${version}-linux-arm64.tar.gz`,
        `aiand-offline-${version}-win32-x64.zip`,
      ],
    );
    assert.deepEqual(
      built.filter(({ prebuilt }) => prebuilt).map(({ name }) => name),
      built.filter(({ name }) => name.includes(HOST_PLATFORM)).map(({ name }) => name),
    );
    assert.equal(
      readFileSync(join(out, "SHA256SUMS.offline"), "utf8"),
      built.map(({ name }) => `${sha256(readFileSync(join(out, name)))}  ${name}\n`).join(""),
    );
    // Rebuilding gives the same bytes, so a published digest can be re-derived.
    const again = buildOfflineBundles(release, join(c.dir, "again"));
    assert.deepEqual(again, built);

    for (const { name } of built) {
      const unpacked = join(c.dir, `x-${name}`);
      mkdirSync(unpacked);
      extract(join(out, name), unpacked);
      const top = join(unpacked, name.replace(/\.(tar\.gz|zip)$/, ""));
      assert.ok(
        readFileSync(join(top, "SHA256SUMS")).equals(readFileSync(join(release, "SHA256SUMS"))),
      );
      for (const file of [`aiand-cli-${version}.tgz`, "install.sh", "install.ps1"]) {
        assert.ok(readFileSync(join(top, file)).equals(readFileSync(join(release, file))), file);
      }
    }
  } finally {
    c.cleanup();
  }
});

test("offline bundles start from an empty output directory", () => {
  const c = caseDir();
  try {
    const release = stageRelease(c.dir, "9.8.5");
    const out = join(c.dir, "out");
    mkdirSync(join(out, "nested"), { recursive: true });
    writeFileSync(join(out, "left-behind.txt"), "not part of the release\n");
    writeFileSync(join(out, "nested", "file"), "x\n");
    const outside = join(c.dir, "outside.txt");
    writeFileSync(outside, "kept\n");
    symlinkSync(outside, join(out, "link"));
    const built = buildOfflineBundles(release, out);
    // Only what this run wrote is there to publish; a link's target is untouched.
    assert.deepEqual(
      readdirSync(out).sort(),
      [...built.map(({ name }) => name), "SHA256SUMS.offline"].sort(),
    );
    assert.equal(readFileSync(outside, "utf8"), "kept\n");
    // Never the release directory itself, or a directory holding it.
    const refused = /must not be, or contain, or sit inside the release directory/;
    assert.throws(() => buildOfflineBundles(release, release), refused);
    assert.throws(() => buildOfflineBundles(release, c.dir), refused);
    // Inside it, whether named directly, not yet created, or reached through a link.
    mkdirSync(join(release, "offline"));
    writeFileSync(join(release, "offline", "keep"), "x\n");
    assert.throws(() => buildOfflineBundles(release, join(release, "offline")), refused);
    assert.throws(() => buildOfflineBundles(release, join(release, "new", "offline")), refused);
    symlinkSync(release, join(c.dir, "via-link"));
    assert.throws(() => buildOfflineBundles(release, join(c.dir, "via-link", "offline")), refused);
    assert.ok(existsSync(join(release, "offline", "keep")), "nothing in the release is touched");
    assert.equal(existsSync(join(release, "new")), false);
    rmSync(join(release, "offline"), { recursive: true });
    assert.ok(existsSync(join(release, "SHA256SUMS")));
  } finally {
    c.cleanup();
  }
});

test("offline bundles refuse a release whose files do not match its SHA256SUMS", () => {
  const c = caseDir();
  try {
    const release = stageRelease(c.dir, "9.8.6");
    writeFileSync(join(release, "install.ps1"), "changed\n");
    assert.throws(
      () => buildOfflineBundles(release, join(c.dir, "out")),
      /install\.ps1 does not match its sha256 in SHA256SUMS/,
    );
    writeFileSync(join(release, "SHA256SUMS"), `${"a".repeat(64)}  install.sh\n`);
    assert.throws(
      () => buildOfflineBundles(release, join(c.dir, "out")),
      /exactly one aiand-cli-<version>\.tgz/,
    );
  } finally {
    c.cleanup();
  }
});

// install.sh cleans flag values itself, in pure bash, under whatever locale and
// bash the machine has: macOS ships bash 3.2 as /bin/bash, Linux bash 5.
const BASHES = [...new Set(["/bin/bash", "bash"])].filter(
  (bash) => !spawnSync(bash, ["-c", "true"]).error,
);
const UTF8_LOCALE = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
for (const bash of BASHES) {
  const version = spawnSync(bash, ["-c", "echo $BASH_VERSION"], { encoding: "utf8" }).stdout.trim();
  for (const locale of ["C", UTF8_LOCALE]) {
    test(`install.sh (${bash} ${version}, LC_ALL=${locale}) drops C1 and ESC controls from flag values`, {
      skip: HAS_BASH ? false : "no bash on PATH",
    }, async () => {
      const c = caseDir();
      try {
        const env = { LC_ALL: locale, LANG: locale };
        // U+009B is the one-character CSI; UTF-8 sends it as C2 9B.
        const mirror = await runInstaller("sh", c.dir, {
          bash,
          env,
          // U+00AD and U+034F are invisible, and hide text in any locale.
          args: ["--mirror", "https://mirror.example.com/\u009b[2J\x1b[2J/\u00ad\u034f/releases"],
        });
        const missing = join(c.dir, "共有", "バンドル-\u009b[2J\u0085.tar.gz");
        const from = await runInstaller("sh", c.dir, { bash, env, args: ["--from", missing] });
        for (const run of [mirror, from]) {
          assert.notEqual(run.status, 0);
          const text = run.stderr + run.stdout;
          for (const control of ["\u009b", "\u0085", "\x1b", "\u00ad", "\u034f"]) {
            assert.equal(text.includes(control), false, JSON.stringify(text.slice(0, 400)));
          }
        }
        assert.match(
          mirror.stderr,
          /Downloading release files from https:\/\/mirror\.example\.com\//,
        );
        if (locale !== "C") {
          // Valid UTF-8 around the controls is kept, so a Japanese path reads as written.
          assert.match(from.stderr, /共有\/バンドル- +\[2J +\.tar\.gz/);
        }
      } finally {
        c.cleanup();
      }
    });
  }
}
