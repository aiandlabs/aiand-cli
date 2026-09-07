
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
const originalEnv = { ...process.env };

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aiand-cli-test-"));
  process.env.AIAND_CONFIG_DIR = dir;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = originalEnv;
});

const config = await import("../dist/config.js");

describe("endpoint resolution", () => {
  test("defaults to the documented public endpoint", () => {
    const profile = config.resolveProfile();
    assert.equal(profile.apiUrl, config.DEFAULT_BASE_URL);
    assert.equal(profile.authUrl, config.DEFAULT_BASE_URL);
  });

  test("a stored profile overrides the default", () => {
    config.updateProfile("default", { apiUrl: "https://stored.example" });
    assert.equal(config.resolveProfile().apiUrl, "https://stored.example");
  });

  test("AIAND_BASE_URL overrides the stored profile", () => {
    process.env.AIAND_BASE_URL = "https://env.example";
    assert.equal(config.resolveProfile().apiUrl, "https://env.example");
    delete process.env.AIAND_BASE_URL;
  });

  test("AIAND_AUTH_URL narrows to the auth endpoint only", () => {
    process.env.AIAND_BASE_URL = "https://both.example";
    process.env.AIAND_AUTH_URL = "https://auth.example";
    const profile = config.resolveProfile();
    assert.equal(profile.authUrl, "https://auth.example");
    assert.equal(profile.apiUrl, "https://both.example");
    delete process.env.AIAND_BASE_URL;
    delete process.env.AIAND_AUTH_URL;
  });

  test("strips a trailing slash so paths do not double up", () => {
    process.env.AIAND_BASE_URL = "https://slash.example/";
    assert.equal(config.resolveProfile().apiUrl, "https://slash.example");
    delete process.env.AIAND_BASE_URL;
  });
});

describe("profiles", () => {
  test("keep separate credentials", () => {
    config.saveCredential("work", {
      access_token: "sk-work",
      refresh_token: "rt-work",
      expires_at: 1,
    });
    config.saveCredential("home", {
      access_token: "sk-home",
      refresh_token: "rt-home",
      expires_at: 2,
    });
    assert.equal(config.loadCredential("work").access_token, "sk-work");
    assert.equal(config.loadCredential("home").access_token, "sk-home");
  });

  test("clearing one leaves the other intact", () => {
    config.clearCredential("work");
    assert.equal(config.loadCredential("work"), null);
    assert.equal(config.loadCredential("home").access_token, "sk-home");
  });

  test("clearing the last one removes the file rather than leaving an empty object", () => {
    config.clearCredential("home");
    assert.throws(() => statSync(config.credentialsPath()), { code: "ENOENT" });
  });
});

describe("credential file permissions", () => {
  test("is created 0600", () => {
    config.saveCredential("p", { access_token: "sk-a", refresh_token: "r", expires_at: 1 });
    assert.equal(statSync(config.credentialsPath()).mode & 0o777, 0o600);
  });

  test("is re-tightened on rewrite, not left at whatever it was", () => {
    const path = config.credentialsPath();
    chmodSync(path, 0o644);
    config.saveCredential("p", { access_token: "sk-b", refresh_token: "r", expires_at: 2 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("maskKey", () => {
  test("keeps a recognizable prefix and suffix, and nothing between", () => {
    const masked = config.maskKey("sk-0123456789abcdef0123456789abcdef");
    assert.match(masked, /^sk-\w{4}\.\.\.\w{4}$/);
    assert.doesNotMatch(masked, /0123456789abcdef0123456789/);
  });

  test("does not leak a short or malformed key", () => {
    assert.equal(config.maskKey("sk-short"), "sk-***");
  });
});

describe("malformed config", () => {
  test("fails with a readable message instead of a JSON parse trace", () => {
    writeFileSync(config.configPath(), "{ not json", { mode: 0o600 });
    assert.throws(() => config.loadConfig(), /not valid JSON/);
  });
});
