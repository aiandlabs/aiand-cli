import assert from "node:assert/strict";
import test, { beforeEach, describe } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-secrets-test-", (dir) => {
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_HOME = join(dir, "home");
  delete process.env.AIAND_KEY_STORAGE;
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
});

const secrets = await import("../dist/secrets.js");
const { CliError } = await import("../dist/cli/errors.js");

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");

function resetDir() {
  rmSync(env.dir, { recursive: true, force: true });
  mkdirSync(env.dir, { recursive: true });
}

function useFileTier(key = KEY_A) {
  process.env.AIAND_KEY_STORAGE = "file";
  process.env.AIAND_SECRET_STORE_MASTER_KEY = key;
}

function unuseTier() {
  delete process.env.AIAND_KEY_STORAGE;
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
}

// Wrong key or corrupt bytes must surface as a CliError naming the fix, never
// the raw GCM "Unsupported state or unable to authenticate data" (exit 70).
const decryptFailure = (error) =>
  error instanceof CliError &&
  /cannot be decrypted/.test(error.message) &&
  /secret-store\.json/.test(error.hint ?? "") &&
  /secret-store\.key/.test(error.hint ?? "");

describe("encrypted file tier failures", () => {
  beforeEach(() => resetDir());

  test("missing store reads as empty, not an error", async () => {
    useFileTier();
    try {
      assert.equal(await secrets.loadSecret("nobody"), null);
    } finally {
      unuseTier();
    }
  });

  test("valid round-trip is unchanged", async () => {
    useFileTier();
    try {
      assert.equal(await secrets.storeSecret("p1", '{"access_token":"sk-roundtrip"}'), "file");
      assert.equal(await secrets.loadSecret("p1"), '{"access_token":"sk-roundtrip"}');
    } finally {
      unuseTier();
    }
  });

  test("wrong-but-valid master key -> CliError with delete hint", async () => {
    useFileTier(KEY_A);
    try {
      await secrets.storeSecret("p1", "secret-a");
    } finally {
      unuseTier();
    }
    useFileTier(KEY_B);
    try {
      await assert.rejects(() => secrets.loadSecret("p1"), decryptFailure);
      await assert.rejects(() => secrets.storeSecret("p2", "secret-b"), decryptFailure);
    } finally {
      unuseTier();
    }
  });

  test("bit-flipped store file -> CliError with delete hint", async () => {
    useFileTier();
    try {
      await secrets.storeSecret("p1", "secret-a");
      const storePath = join(env.dir, "secret-store.json");
      const good = readFileSync(storePath);
      // Flip bytes in the ciphertext tail: the version parses, GCM auth fails.
      good[good.length - 1] ^= 0xff;
      good[good.length - 2] ^= 0xff;
      writeFileSync(storePath, good);
      await assert.rejects(() => secrets.loadSecret("p1"), decryptFailure);
    } finally {
      unuseTier();
    }
  });

  test("garbage store file -> CliError with delete hint", async () => {
    useFileTier();
    try {
      writeFileSync(join(env.dir, "secret-store.json"), "not a store");
      await assert.rejects(() => secrets.loadSecret("p1"), decryptFailure);
    } finally {
      unuseTier();
    }
  });

  test("short key file -> CliError with delete hint", async () => {
    process.env.AIAND_KEY_STORAGE = "file";
    delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
    try {
      writeFileSync(join(env.dir, "secret-store.key"), Buffer.alloc(16));
      writeFileSync(join(env.dir, "secret-store.json"), Buffer.from([1, ...randomBytes(30)]));
      await assert.rejects(
        () => secrets.loadSecret("p1"),
        (error) =>
          error instanceof CliError &&
          /exactly 32 bytes/.test(error.message) &&
          /secret-store\.key/.test(error.hint ?? "")
      );
    } finally {
      unuseTier();
    }
  });
});

describe("keychain spawn", () => {
  beforeEach(() => resetDir());

  test(
    "fast-exiting tool shim does not crash stdin with EPIPE; falls back to file",
    { skip: process.platform === "win32" },
    async () => {
      // The shim exits before the parent's write lands; without a stdin error
      // listener that EPIPE is an unhandled crash. A 1MB blob keeps the parent
      // writing well past the shim's exit so the race is deterministic.
      const bin = mkdtempSync(join(tmpdir(), "aiand-secrets-shim-"));
      const tool = process.platform === "darwin" ? "security" : "secret-tool";
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, tool), 0o755);
      const realPath = process.env.PATH;
      process.env.PATH = realPath ? `${bin}:${realPath}` : bin;
      process.env.AIAND_KEY_STORAGE = "keychain";
      process.env.AIAND_SECRET_STORE_MASTER_KEY = KEY_A;
      const blob = `{"access_token":"${"sk-epipe-".padEnd(1024 * 1024, "x")}"}`;
      try {
        assert.equal(await secrets.storeSecret("epipe", blob), "file");
        assert.equal(await secrets.loadSecret("epipe", "file"), blob);
      } finally {
        if (realPath === undefined) delete process.env.PATH;
        else process.env.PATH = realPath;
        unuseTier();
        rmSync(bin, { recursive: true, force: true });
      }
    }
  );
});
