import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const binName = "aiand";
const binPath = pkg.bin?.[binName];
assert.ok(binPath, `package.json must declare bin.${binName} (npm links the CLI from it)`);

const binUrl = new URL(`../${binPath}`, import.meta.url);
const stats = statSync(binUrl);
assert.ok(stats.isFile(), `${binPath} is missing — run npm run build`);

const firstLine = readFileSync(binUrl, "utf8").split("\n", 1)[0];
assert.equal(
  firstLine,
  "#!/usr/bin/env node",
  `${binPath} must start with a node shebang, got: ${firstLine}`,
);
assert.ok(stats.mode & 0o111, `${binPath} is not executable (mode ${stats.mode.toString(8)})`);

const reported = execFileSync(process.execPath, [fileURLToPath(binUrl), "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
assert.equal(
  reported,
  pkg.version,
  `${binName} --version printed "${reported}" but package.json says "${pkg.version}"`,
);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { COMMANDS } = await import(
  pathToFileURL(join(repoRoot, "dist", "commands", "index.js")).href
);
assert.ok(Array.isArray(COMMANDS), "dist/commands/index.js must export COMMANDS");
assert.ok(COMMANDS.length >= 15, `expected at least 15 commands, got ${COMMANDS.length}`);
for (const command of COMMANDS) {
  assert.ok(command.name, "each command needs a name");
  assert.ok(command.summary, `command ${command.name} needs a summary`);
  assert.equal(typeof command.run, "function", `command ${command.name} needs a run function`);
}

// CI installs a pinned OpenCode and a pinned Pi for the live tests; each
// must be the release the CLI's install hint names, or the two drift
// apart silently.
const { OPENCODE_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "opencode", "adapter.js")).href
);
const { PI_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "pi", "adapter.js")).href
);
const { OMP_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "omp", "install.js")).href
);
const { COPILOT_VERSION } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "copilot", "adapter.js")).href
);
const ciYml = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
// One entry per pinned agent install in ci.yml: `regex` captures the pin,
// `expected` is the version the adapter exports, `label` is the
// pin-not-found message, `message` builds the mismatch text from the pin.
const PINS = [
  {
    label: "ci.yml should install a pinned opencode-ai",
    regex: /opencode-ai@([0-9A-Za-z.+-]+)/g,
    expected: OPENCODE_VERSION,
    message: (pin) =>
      `ci.yml installs opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned pi-coding-agent",
    regex: /pi-coding-agent@([0-9A-Za-z.+-]+)/g,
    expected: PI_VERSION,
    message: (pin) =>
      `ci.yml installs pi-coding-agent@${pin} but src/agents/pi/adapter.ts pins ${PI_VERSION}`,
  },
  // omp installs as a pinned release asset (omp-linux-x64 /
  // omp-windows-x64.exe) from the vX.Y.Z release, digest-checked in
  // ci.yml. Each platform is checked separately so one losing its pin
  // can't hide behind the other's.
  {
    label: "ci.yml should install a pinned omp on Linux via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-linux-x64/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-linux-x64 asset at v${pin} on Linux but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned omp on Windows via the release asset",
    regex: /oh-my-pi\/releases\/download\/v([0-9.]+)\/omp-windows-x64\.exe/g,
    expected: OMP_VERSION,
    message: (pin) =>
      `ci.yml pins the omp-windows-x64.exe asset at v${pin} on Windows but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label: "ci.yml should install a pinned @github/copilot",
    regex: /@github\/copilot@([0-9A-Za-z.+-]+)/g,
    expected: COPILOT_VERSION,
    message: (pin) =>
      `ci.yml pins @github/copilot@${pin} but the install hint names ${COPILOT_VERSION}`,
  },
];
for (const { label, regex, expected, message } of PINS) {
  const pins = [...ciYml.matchAll(regex)].map((m) => m[1]);
  assert.ok(pins.length > 0, label);
  for (const pin of pins) {
    assert.equal(pin, expected, message(pin));
  }
}

// The live matrix installs a pinned Hermes the same way; every `--commit`
// pin in ci.yml or scripts/contree-e2e.sh must match
// src/agents/hermes/install.ts or the copies drift apart silently. The
// user-facing install hint carries the same pin, so a missing binary never
// installs unaudited bytes. The pin is imported here rather than beside the
// version PINS above: the hash lives outside src/agents/hermes/adapter.ts,
// and the cross-file sweep below reads surfaces PINS has no entry for.
const { HERMES_COMMIT, HERMES_INSTALL_SHA256 } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "hermes", "install.js")).href
);
const hermesPinFiles = [
  [".github/workflows/ci.yml", ciYml],
  ["scripts/contree-e2e.sh", readFileSync(join(repoRoot, "scripts", "contree-e2e.sh"), "utf8")],
];
const hermesPins = hermesPinFiles.flatMap(([file, text]) =>
  [...text.matchAll(/--commit ([0-9a-f]{7,40})/g)].map((m) => [file, m[1]]),
);
assert.ok(
  hermesPins.length > 0,
  "ci.yml or scripts/contree-e2e.sh should install a Hermes pinned with --commit",
);
for (const [file, pin] of hermesPins) {
  assert.equal(
    pin,
    HERMES_COMMIT,
    `${file} installs hermes --commit ${pin} but src/agents/hermes/install.ts pins ${HERMES_COMMIT}`,
  );
}
// The same installer is checked by digest before it runs, in both files: a
// stale literal passes sha256sum only as long as the downloaded bytes match,
// so the digest drifts from HERMES_INSTALL_SHA256 whenever the pinned commit
// moves and nobody re-records it.
const hermesDigests = hermesPinFiles.flatMap(([file, text]) =>
  [...text.matchAll(/echo "([0-9a-f]{64})\s+\S*install\.sh"\s*\|\s*sha256sum -c/g)].map((m) => [
    file,
    m[1],
  ]),
);
assert.ok(
  hermesDigests.length > 0,
  "ci.yml or scripts/contree-e2e.sh should verify the hermes installer with its sha256",
);
for (const [file, digest] of hermesDigests) {
  assert.equal(
    digest,
    HERMES_INSTALL_SHA256,
    `${file} verifies the hermes installer against ${digest} but src/agents/hermes/install.ts pins ${HERMES_INSTALL_SHA256}`,
  );
}
const { hermesAdapter } = await import(
  pathToFileURL(join(repoRoot, "dist", "agents", "hermes", "adapter.js")).href
);
assert.ok(
  hermesAdapter.install.command.includes(`--commit ${HERMES_COMMIT}`),
  `the hermes install hint must carry --commit ${HERMES_COMMIT}, got: ${hermesAdapter.install.command}`,
);

// The installers run on the user's machine, where dist/ is not built yet, so
// their agent-summary hints are literal command lines in the shell script and
// the PowerShell script. They carry the same pins as the adapters; check-dist
// is the only gate that runs where both exist.
const installSh = readFileSync(join(repoRoot, "install.sh"), "utf8");
const installPs1 = readFileSync(join(repoRoot, "install.ps1"), "utf8");
// One entry per agent whose installer hint names a pinned version: `regex`
// captures the pin from the hint command, `expected` is the version the
// adapter exports. The hint must exist in both installers or the pin has no
// downstream to trip on.
const INSTALLER_PINS = [
  {
    label:
      "install.sh / install.ps1 should hint a pinned opencode-ai, and both scripts must carry the hint",
    regex: /npm install -g opencode-ai@([0-9A-Za-z.+-]+)/g,
    expected: OPENCODE_VERSION,
    message: (pin, script) =>
      `${script} hints opencode-ai@${pin} but src/agents/opencode/adapter.ts pins ${OPENCODE_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned pi-coding-agent, and both scripts must carry the hint",
    regex: /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent@([0-9A-Za-z.+-]+)/g,
    expected: PI_VERSION,
    message: (pin, script) =>
      `${script} hints pi-coding-agent@${pin} but src/agents/pi/adapter.ts pins ${PI_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned omp release asset, and both scripts must carry the hint",
    // The hint names the asset, so the version rides the release URL rather
    // than a package@version pair. The regex matches any omp- asset, so
    // install.sh's omp-linux-x64 and install.ps1's omp-windows-x64.exe both
    // satisfy it while a lost pin in either one trips.
    regex: /oh-my-pi\/releases\/download\/v([0-9A-Za-z.+-]+)\/omp-/g,
    expected: OMP_VERSION,
    message: (pin, script) =>
      `${script} hints the omp release asset at v${pin} but src/agents/omp/install.ts pins ${OMP_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint a pinned @github/copilot, and both scripts must carry the hint",
    regex: /npm install -g --ignore-scripts @github\/copilot@([0-9A-Za-z.+-]+)/g,
    expected: COPILOT_VERSION,
    message: (pin, script) =>
      `${script} hints @github/copilot@${pin} but src/agents/copilot/adapter.ts pins ${COPILOT_VERSION}`,
  },
  {
    label:
      "install.sh / install.ps1 should hint the pinned Hermes commit, and both scripts must carry the hint",
    // Hermes pins a commit, not a semver: the hint is the same
    // `curl | bash -s -- --commit <sha>` line ci.yml and contree-e2e.sh run,
    // so the pin below is the one imported from dist/agents/hermes/install.js.
    // PowerShell spells the same flag `-Commit`, so both forms are matched.
    regex: /-{1,2}[Cc]ommit ([0-9a-f]{7,40})/g,
    expected: HERMES_COMMIT,
    message: (pin, script) =>
      `${script} hints hermes --commit ${pin} but src/agents/hermes/install.ts pins ${HERMES_COMMIT}`,
  },
];
// claude and codex hints are unpinned upstream commands (npm tracks latest),
// so they carry no version pin to drift. Only the versioned hints are gated
// here.
for (const { label, regex, expected, message } of INSTALLER_PINS) {
  for (const [script, text] of [
    ["install.sh", installSh],
    ["install.ps1", installPs1],
  ]) {
    const pins = [...text.matchAll(regex)].map((m) => m[1]);
    assert.ok(pins.length > 0, `${label}: none in ${script}`);
    for (const pin of pins) {
      assert.equal(pin, expected, message(pin, script));
    }
  }
}

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
assert.deepEqual(
  runtimeDeps,
  [],
  `the CLI ships no runtime dependencies; found: ${runtimeDeps.join(", ")}`,
);

// Exact versions only: a range lets a fresh install pick up a release nobody
// reviewed. `.npmrc` sets save-exact so `npm install <pkg>` pins by default.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ranged = Object.entries(pkg.devDependencies ?? {}).filter(([, v]) => !EXACT_VERSION.test(v));
assert.deepEqual(
  ranged,
  [],
  `pin devDependencies to exact versions; found: ${ranged.map(([n, v]) => `${n}@${v}`).join(", ")}`,
);

console.log(`check-dist ok: ${binName} v${pkg.version}, 0 runtime deps`);
