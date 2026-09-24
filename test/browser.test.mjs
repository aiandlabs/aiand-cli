import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openBrowser } from "../dist/cli/browser.js";

const skip = process.platform === "win32";

/**
 * Run `fn(dir)` with a hermetic opener stub (body `script`) first on PATH so
 * no real browser launches, and AIAND_NO_BROWSER cleared so openBrowser
 * reaches the opener at all (test/setup.mjs sets it for the rest of the run).
 */
async function withOpener(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiand-browser-test-"));
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  writeFileSync(join(dir, opener), `#!/bin/sh\n${script(dir)}\n`);
  chmodSync(join(dir, opener), 0o755);
  const realPath = process.env.PATH;
  const noBrowser = process.env.AIAND_NO_BROWSER;
  process.env.PATH = realPath ? `${dir}:${realPath}` : dir;
  delete process.env.AIAND_NO_BROWSER;
  try {
    await fn(dir);
  } finally {
    if (realPath === undefined) delete process.env.PATH;
    else process.env.PATH = realPath;
    if (noBrowser !== undefined) process.env.AIAND_NO_BROWSER = noBrowser;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Signature contract: async, resolves boolean, never throws.
test("browser: openBrowser spawns the platform opener", { skip }, () =>
  withOpener(() => "exit 0", async () => {
    assert.equal(await openBrowser("https://example.com"), true);
  }));

test("browser: openBrowser reports a nonzero opener exit as failure", { skip }, () =>
  withOpener(() => "exit 1", async () => {
    assert.equal(await openBrowser("https://example.com"), false);
  }));

test("browser: openBrowser treats a slow exit 0 as success", { skip }, () =>
  withOpener(() => "sleep 0.1\nexit 0", async () => {
    assert.equal(await openBrowser("https://example.com"), true);
  }));

test("browser: openBrowser treats a slow exit 1 as failure", { skip }, () =>
  withOpener(() => "sleep 0.1\nexit 1", async () => {
    assert.equal(await openBrowser("https://example.com"), false);
  }));

test("browser: openBrowser does not wait for a long-lived opener", { skip }, () =>
  withOpener((dir) => `echo $$ > "${join(dir, "opener.pid")}"\nsleep 30`, async (dir) => {
    const pidfile = join(dir, "opener.pid");
    try {
      const started = Date.now();
      assert.equal(await openBrowser("https://example.com"), true);
      // LAUNCH_OK_MS is 2000; the bound only has to prove we did not wait
      // out the 30s opener, so leave headroom for a loaded runner.
      assert.ok(Date.now() - started < 10_000, "openBrowser waited for the opener lifetime");
    } finally {
      try {
        if (existsSync(pidfile)) process.kill(Number(readFileSync(pidfile, "utf8").trim()), "SIGTERM");
      } catch {
        // opener may already have exited
      }
    }
  }));

test("browser: AIAND_NO_BROWSER=1 never spawns the opener", { skip }, () =>
  withOpener((dir) => `touch "${join(dir, "ran")}"\nexit 0`, async (dir) => {
    process.env.AIAND_NO_BROWSER = "1";
    assert.equal(await openBrowser("https://example.com"), false);
    assert.equal(existsSync(join(dir, "ran")), false, "opener must not run");
  }));
