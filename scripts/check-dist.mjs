// Checks the built CLI in dist/ before it can be published. Guards the
// constraints an npm-installed command line tool has to satisfy, none of which
// a passing `tsc` proves:
//
//   1. `bin` points at a real compiled file that starts with a shebang and is
//      executable — npm links it directly, so a missing shebang ships a binary
//      the shell cannot run.
//   2. The binary actually starts, and reports the version in package.json —
//      catching a broken import or a bad entry that only fails at runtime.
//   3. Every registered command loads and exposes `help` and `run`, so a
//      command added to the registry but not importable fails here rather than
//      on a user's first invocation.
//   4. The package still has no runtime dependencies, which is a property we
//      advertise and would otherwise lose silently to one stray `npm install`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// --- 1. the bin entry -------------------------------------------------------
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
  `${binPath} must start with a node shebang, got: ${firstLine}`
);
assert.ok(stats.mode & 0o111, `${binPath} is not executable (mode ${stats.mode.toString(8)})`);

// --- 2. it runs, and agrees about its version -------------------------------
const reported = execFileSync(process.execPath, [binUrl.pathname, "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
assert.equal(
  reported,
  pkg.version,
  `${binName} --version printed "${reported}" but package.json says "${pkg.version}"`
);

// --- 3. every registered command is loadable --------------------------------
const registry = await import(pathToFileURL(new URL("../dist/commands/index.js", import.meta.url).pathname));
assert.ok(Array.isArray(registry.COMMANDS) && registry.COMMANDS.length > 0, "command registry is empty");
for (const command of registry.COMMANDS) {
  assert.equal(typeof command.name, "string", "a command is missing its name");
  assert.equal(typeof command.summary, "string", `${command.name} is missing a summary`);
  assert.equal(typeof command.help, "string", `${command.name} is missing help text`);
  assert.equal(typeof command.run, "function", `${command.name} does not export run()`);
}

// --- 4. still dependency-free ----------------------------------------------
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
assert.deepEqual(
  runtimeDeps,
  [],
  `the CLI ships no runtime dependencies; found: ${runtimeDeps.join(", ")}`
);

console.log(
  `check-dist ok: ${binName} v${pkg.version}, ${registry.COMMANDS.length} commands, 0 runtime deps`
);
