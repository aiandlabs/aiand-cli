import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test, { beforeEach, describe } from "node:test";
import { plantStub, withEnv, withTestEnv } from "./helpers.mjs";

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
          /secret-store\.key/.test(error.hint ?? ""),
      );
    } finally {
      unuseTier();
    }
  });

  test("directory-as-store is not a GCM decrypt failure", async () => {
    useFileTier();
    try {
      mkdirSync(join(env.dir, "secret-store.json"));
      await assert.rejects(
        () => secrets.loadSecret("p1"),
        (error) =>
          error instanceof CliError &&
          /secret-store\.json/.test(error.message) &&
          !/cannot be decrypted/.test(error.message),
      );
    } finally {
      unuseTier();
    }
  });
});

describe("keychain spawn", () => {
  beforeEach(() => resetDir());

  test("fast-exiting tool shim does not crash stdin with EPIPE; falls back to file", {
    skip: process.platform === "win32",
  }, async () => {
    // The shim exits before the parent's write lands; without a stdin error
    // listener that EPIPE is an unhandled crash. A 1MB blob keeps the parent
    // writing well past the shim's exit so the race is deterministic.
    const bin = mkdtempSync(join(env.dir, "shim-"));
    plantStub(bin, process.platform === "darwin" ? "security" : "secret-tool", "exit 1");
    const blob = `{"access_token":"${"sk-epipe-".padEnd(1024 * 1024, "x")}"}`;
    await withEnv(
      {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        AIAND_KEY_STORAGE: "keychain",
        AIAND_SECRET_STORE_MASTER_KEY: KEY_A,
      },
      async () => {
        assert.equal(await secrets.storeSecret("epipe", blob), "file");
        assert.equal(await secrets.loadSecret("epipe", "file"), blob);
      },
    );
  });
});

describe("securityInteractiveSetCommand quoting", () => {
  test("profile with spaces stays one -a token", () => {
    const command = secrets.securityInteractiveSetCommand("my work", "s3cret");
    assert.match(command, /-a 'my work' /);
  });

  test("injection-shaped profile cannot add a second -w", () => {
    const command = secrets.securityInteractiveSetCommand("x -w other", "s3cret");
    assert.match(command, /-a 'x -w other' /);
  });

  test("single quote in profile is POSIX-escaped", () => {
    const command = secrets.securityInteractiveSetCommand("o'brien", "s3cret");
    assert.match(command, /-a 'o'\\''brien' /);
  });
});

test("concurrent first runs agree on one encrypted-file key", async () => {
  const { spawn } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const cfg = mkdtempSync(join(env.dir, "race-"));
  const script = `
    const secrets = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "dist", "secrets.js")).href)});
    await secrets.storeSecret("p", "blob-" + process.pid);
  `;
  const childEnv = { ...process.env, AIAND_CONFIG_DIR: cfg, AIAND_KEY_STORAGE: "file" };
  delete childEnv.AIAND_SECRET_STORE_MASTER_KEY;
  const codes = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            env: childEnv,
            stdio: "ignore",
          });
          child.on("exit", resolve);
        }),
    ),
  );
  assert.deepEqual(codes, Array(8).fill(0), "every racing process stored its secret");
  assert.equal(readFileSync(join(cfg, "secret-store.key")).length, 32);
  assert.deepEqual(
    readdirSync(cfg).filter((name) => name.endsWith(".tmp")),
    [],
    "no staged key left behind",
  );
  // Whichever store won, it decrypts under the one key on disk.
  await withEnv({ AIAND_CONFIG_DIR: cfg, AIAND_KEY_STORAGE: "file" }, async () => {
    assert.match(await secrets.loadSecret("p", "file"), /^blob-\d+$/);
  });
});
