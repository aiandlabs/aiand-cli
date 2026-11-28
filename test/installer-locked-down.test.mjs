// install.ps1 on a locked-down Windows PC: AppLocker or App Control for
// Business runs a script it has not approved, and the `irm … | iex` one-liner,
// in Constrained Language Mode; Group Policy can set an execution policy that
// refuses the file outright; and AppLocker's default script rules refuse a
// .cmd launcher in the user profile. installer-guards, installer-swap and
// prebuilt-install already run every scenario in Constrained Language Mode
// (kind `ps1-clm`); this file covers what only a locked-down PC needs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  caseDir,
  newReleaseDouble,
  PWSH,
  publishToDouble,
  ROOT,
  runInstaller,
  seedInstall,
} from "./installer-fixtures.mjs";

const skip = PWSH ? false : "no pwsh on PATH";
const MODES = [
  ["Full Language", "ps1"],
  ["Constrained Language Mode", "ps1-clm"],
];

let double;
before(async () => {
  double = await newReleaseDouble();
});
after(() => double?.close());

let counter = 0;
const nextVersion = () => `7.${++counter}.0`;
const releaseEnv = (version) => ({
  AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
  AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
  AIAND_VERSION: version,
});
const installDir = (home) => join(home, ".aiand", "cli");
const installedVersion = (home) =>
  JSON.parse(readFileSync(join(installDir(home), "package.json"), "utf8")).version;

describe("the one-liner (irm | iex)", () => {
  for (const [label, kind] of MODES) {
    test(`installs a release in ${label}`, { skip }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        const run = await runInstaller(kind, c.dir, { env: releaseEnv(v), piped: true });
        assert.equal(installedVersion(run.home), v, run.stderr);
        if (kind === "ps1-clm") assert.match(run.stderr, /ConstrainedLanguage mode here/);
      } finally {
        c.cleanup();
      }
    });

    test(`takes its arguments from AIAND_INSTALL_ARGS in ${label}, then clears it`, {
      skip,
    }, async () => {
      const c = caseDir();
      try {
        seedInstall(installDir(join(c.dir, "home")), "7.0.0");
        const run = await runInstaller(kind, c.dir, {
          env: {
            AIAND_INSTALL_ARGS: " uninstall  --force ",
            AIAND_INSTALL_RELEASES_URL: `${double.base}/rel`,
            AIAND_INSTALL_NPM_REGISTRY: `${double.base}/npm`,
          },
          piped: true,
          after: "'left=[' + $env:AIAND_INSTALL_ARGS + ']'",
        });
        assert.equal(existsSync(installDir(run.home)), false, run.stderr);
        assert.match(run.stdout, /Removed launchers and/);
        assert.match(run.stdout, /left=\[\]/);
      } finally {
        c.cleanup();
      }
    });
  }

  test("an argument on the command line wins over AIAND_INSTALL_ARGS", { skip }, async () => {
    const c = caseDir();
    try {
      seedInstall(installDir(join(c.dir, "home")), "7.0.0");
      const run = await runInstaller("ps1", c.dir, {
        args: ["uninstall", "--bogus"],
        env: { AIAND_INSTALL_ARGS: "uninstall --force" },
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /Usage: install\.ps1/);
      assert.equal(existsSync(installDir(run.home)), true);
    } finally {
      c.cleanup();
    }
  });
});

describe("a launcher application control refuses", () => {
  for (const [label, kind] of MODES) {
    test(`still installs, and says how to run aiand without it, in ${label}`, {
      skip,
    }, async () => {
      const c = caseDir();
      try {
        const v = nextVersion();
        publishToDouble(double, v);
        // The launcher runs AIAND_NODE_BIN when it names a file; one that
        // always fails stands in for cmd.exe refusing the launcher, while the
        // Node the installer verified with still runs aiand.
        const refused = join(c.dir, process.platform === "win32" ? "refused.cmd" : "refused");
        writeFileSync(
          refused,
          process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
        );
        chmodSync(refused, 0o755);
        const run = await runInstaller(kind, c.dir, {
          env: { ...releaseEnv(v), AIAND_NODE_BIN: refused },
        });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(installedVersion(run.home), v);
        assert.ok(run.stderr.includes(`aiand ${v} is installed, but its launcher`), run.stderr);
        assert.match(run.stderr, /application control \(AppLocker script rules\)/);
        assert.match(
          run.stderr,
          /run aiand from PowerShell as: {2}& '.*node.*' '--disable-warning=ExperimentalWarning' '.*index\.js' <command>/,
        );
        assert.match(run.stderr, /docs\/it-admin-windows\.md/);
        assert.doesNotMatch(run.stderr, /Log in to ai& now/);
      } finally {
        c.cleanup();
      }
    });
  }
});

// The functions are taken out of install.ps1 by the PowerShell parser and
// defined in the mode under test; the exceptions are built the way
// PowerShell reports a program Windows would not start.
function runInstallerFunctions(language, body) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$tokens = $null; $errors = $null`,
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${join(ROOT, "install.ps1").replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)`,
    "$names = @('Test-AppControlBlock', 'Get-AppControlMessage')",
    "$defs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $n.Name }, $true) | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine",
    "function New-Blocked([int]$code) { $inner = New-Object System.ComponentModel.Win32Exception $code; $outer = New-Object System.Management.Automation.ApplicationFailedException ('Program failed to run', $inner); New-Object System.Management.Automation.ErrorRecord ($outer, 'NativeCommandFailed', 'ResourceUnavailable', $null) }",
    "$blocked1260 = New-Blocked 1260; $blocked4551 = New-Blocked 4551; $other = New-Blocked 2",
    "$AdminGuideUrl = 'https://example.invalid/guide'",
    language ? `$ExecutionContext.SessionState.LanguageMode = '${language}'` : "",
    "Invoke-Expression $defs",
    body,
  ]
    .filter(Boolean)
    .join("\n");
  return spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
}

describe("a program application control would not start", () => {
  for (const [label, language] of [
    ["Full Language", ""],
    ["Constrained Language Mode", "ConstrainedLanguage"],
  ]) {
    test(`is told apart by its Windows error code in ${label}`, { skip }, () => {
      const run = runInstallerFunctions(
        language,
        "'{0} {1} {2}' -f (Test-AppControlBlock $blocked1260), (Test-AppControlBlock $blocked4551), (Test-AppControlBlock $other)",
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), "True True False");
    });
  }

  test("is named in the message, with what to do about it", { skip }, () => {
    const run = runInstallerFunctions(
      "",
      "Get-AppControlMessage -Program 'C:\\x\\aiand.exe' -Prebuilt; Get-AppControlMessage -Program 'C:\\n\\node.exe'",
    );
    assert.equal(run.status, 0, run.stderr);
    const [prebuilt, node] = run.stdout.trim().split(/\r?\n/);
    for (const line of [prebuilt, node]) {
      assert.match(
        line,
        /Windows application control \(AppLocker, App Control for Business, or a Software Restriction Policy\) would not start/,
      );
      assert.match(line, /left unchanged/);
      assert.match(line, /https:\/\/example\.invalid\/guide$/);
    }
    assert.match(prebuilt, /C:\\x\\aiand\.exe.*install Node\.js 22\+ for all users/);
    assert.match(node, /C:\\n\\node\.exe.*Node\.js installed for one user/);
  });
});
