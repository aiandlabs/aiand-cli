import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openBrowser } from "../dist/cli/browser.js";
import { withOpener } from "./helpers.mjs";

const skip = process.platform === "win32";

// Signature contract: async, resolves boolean, never throws.
test("browser: openBrowser spawns the platform opener", { skip }, () =>
  withOpener(
    () => "exit 0",
    async () => {
      assert.equal(await openBrowser("https://example.com"), true);
    },
  ),
);

test("browser: openBrowser reports a nonzero opener exit as failure", { skip }, () =>
  withOpener(
    () => "exit 1",
    async () => {
      assert.equal(await openBrowser("https://example.com"), false);
    },
  ),
);

test("browser: openBrowser treats a slow exit 0 as success", { skip }, () =>
  withOpener(
    () => "sleep 0.1\nexit 0",
    async () => {
      assert.equal(await openBrowser("https://example.com"), true);
    },
  ),
);

test("browser: openBrowser treats a slow exit 1 as failure", { skip }, () =>
  withOpener(
    () => "sleep 0.1\nexit 1",
    async () => {
      assert.equal(await openBrowser("https://example.com"), false);
    },
  ),
);

test("browser: openBrowser does not wait for a long-lived opener", { skip }, () =>
  withOpener(
    (dir) => `echo $$ > "${join(dir, "opener.pid")}"\nsleep 30`,
    async (dir) => {
      const pidfile = join(dir, "opener.pid");
      try {
        const started = Date.now();
        assert.equal(await openBrowser("https://example.com"), true);
        // LAUNCH_OK_MS is 2000; the bound only has to prove we did not wait
        // out the 30s opener, so leave headroom for a loaded runner.
        assert.ok(Date.now() - started < 10_000, "openBrowser waited for the opener lifetime");
      } finally {
        try {
          if (existsSync(pidfile))
            process.kill(Number(readFileSync(pidfile, "utf8").trim()), "SIGTERM");
        } catch {
          // opener may already have exited
        }
      }
    },
  ),
);

test("browser: AIAND_NO_BROWSER=1 never spawns the opener", { skip }, () =>
  withOpener(
    (dir) => `touch "${join(dir, "ran")}"\nexit 0`,
    async (dir) => {
      process.env.AIAND_NO_BROWSER = "1";
      assert.equal(await openBrowser("https://example.com"), false);
      assert.equal(existsSync(join(dir, "ran")), false, "opener must not run");
    },
  ),
);
