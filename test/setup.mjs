// Preloaded by `npm test` (node --import) in the runner process before any
// test file spawns, so every test file and every CLI subprocess inherits it.
// Keeps a test run off the developer's machine:
// - AIAND_NO_BROWSER=1: device/browser sign-in never launches a real browser.
// - Stub `security` / `secret-tool` first on PATH, exiting 1: the keychain
//   probe and the logout sweep (deleteSecret clears every tier) never reach
//   the real login keychain. Tests that exercise the keychain plant their own
//   stub ahead of this one; hermetic PATHs include AIAND_TEST_STUB_BIN.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

if (!process.env.AIAND_TEST_STUB_BIN) {
  const bin = mkdtempSync(join(tmpdir(), "aiand-test-stubs-"));
  for (const tool of ["security", "secret-tool"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, tool), 0o755);
  }
  process.env.AIAND_TEST_STUB_BIN = bin;
  process.env.PATH = process.env.PATH ? `${bin}${delimiter}${process.env.PATH}` : bin;
  process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
}
process.env.AIAND_NO_BROWSER = "1";
