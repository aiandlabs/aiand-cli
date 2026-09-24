import assert from "node:assert/strict";
import { test } from "node:test";
import { cmdShimArgv, escapeCmdArgument } from "../dist/cli/win-spawn.js";

// The end-to-end proof is scripts/e2e.mjs on the windows-latest runner, which
// round-trips metacharacters through a real .cmd shim. These pin the shape.

test("win-spawn: a plain argument is quoted and caret-escaped", () => {
  assert.equal(escapeCmdArgument("--version", false), '^"--version^"');
});

test("win-spawn: shim arguments are escaped twice for the %* re-parse", () => {
  assert.equal(escapeCmdArgument("a&b", true), '^^^"a^^^&b^^^"');
});

test("win-spawn: embedded quotes and trailing backslashes survive MSVCRT parsing", () => {
  assert.equal(escapeCmdArgument('q"t', false), '^"q\\^"t^"');
  assert.equal(escapeCmdArgument("trail\\", false), '^"trail\\\\^"');
});

test("win-spawn: every cmd.exe metacharacter is neutralized", () => {
  const escaped = escapeCmdArgument('()[]%!^"`<>&|;, *?', false);
  // Strip escaped pairs; no bare metacharacter may remain.
  assert.equal(escaped.replace(/\^./g, "").match(/[()\][%!^"`<>&|;, *?]/), null);
});

test("win-spawn: cmdShimArgv wraps one /d /s /c command line", () => {
  const argv = cmdShimArgv("C:\\npm\\opencode.cmd", ["run", "x y"]);
  assert.deepEqual(argv.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(argv[3].startsWith('"C:\\npm\\opencode.cmd '), argv[3]);
  assert.ok(argv[3].endsWith('"'), argv[3]);
});
