import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "index.js");

function childEnv(dir, extra = {}) {
  return {
    ...process.env,
    AIAND_HOME: join(dir, "home"),
    AIAND_CONFIG_DIR: join(dir, "cfg"),
    AIAND_API_KEY: "sk-test-env-key",
    NO_UPDATE_CHECK: "1",
    CI: "1",
    ...extra,
  };
}

function runCli(args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

describe("login env-key JSON", () => {
  test("--json emits pure JSON with profile and AIAND_API_KEY source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-login-json-"));
    try {
      const r = await runCli(["login", "--json"], { env: childEnv(dir) });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.profile, "default");
      assert.equal(parsed.source, "AIAND_API_KEY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json honors --profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-login-json-"));
    try {
      const r = await runCli(["login", "--json", "--profile", "work"], { env: childEnv(dir) });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).profile, "work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("human path still prints prose, not JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-login-json-"));
    try {
      const r = await runCli(["login"], { env: childEnv(dir) });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.match(r.stdout, /AIAND_API_KEY is set/);
      assert.throws(() => JSON.parse(r.stdout));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
