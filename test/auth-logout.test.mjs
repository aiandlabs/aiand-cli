import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureOutput, cliStdout, registerAuthStub, state } from "./auth-stub.mjs";

// Behavioral tests through the real src/auth modules (dist build), against
// the localhost stub server in ./auth-stub.mjs.
// Sign-out: revoke, local clear, and baked-key teardown.

const authLogout = await import("../dist/auth/logout.js");
const config = await import("../dist/config.js");

registerAuthStub();

describe("auth logout integration (serial)", { concurrency: 1 }, () => {
describe("logout (real modules, stub server)", () => {
  test("device-minted key is revoked through the real revoke endpoint", async () => {
    await config.saveCredential("default", {
      access_token: "sk-device",
      refresh_token: "rt-device",
      origin: "device",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default" });
    } finally {
      captured.restore();
    }

    assert.deepEqual(state.revocations, ["rt-device"]);
    assert.equal(await config.loadCredential("default"), null);
  });

  test("pasted key is cleared locally and never revoked", async () => {
    await config.saveCredential("default", {
      access_token: "sk-paste",
      origin: "paste",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default" });
    } finally {
      captured.restore();
    }
    assert.deepEqual(state.revocations, []);
    assert.equal(await config.loadCredential("default"), null);
  });

  test("a pasted key with --revoke is refused and the credential survives", async () => {
    await config.saveCredential("default", {
      access_token: "sk-paste",
      origin: "paste",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await assert.rejects(
        authLogout.logout({ profile: "default", revoke: true }),
        /refusing to revoke/,
      );
    } finally {
      captured.restore();
    }
    assert.ok(await config.loadCredential("default"));
  });

  test("logout of a non-active profile warns the baked key was left in place", async () => {
    // The pasted key is baked under "other" while "default" stays active.
    const home = process.env.AIAND_HOME;
    const configPath = join(home, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-other", "x-aiand": true } },
        },
        model: "aiand/m-default",
      }) + "\n",
    );
    await config.saveCredential("other", {
      access_token: "sk-other",
      origin: "paste",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "other" });
      assert.match(
        captured.log.err.join(""),
        /not the active profile.*left in place/,
      );
    } finally {
      captured.restore();
    }

    assert.equal(await config.loadCredential("other"), null);
    assert.deepEqual(state.revocations, []);
    // The strip was skipped: the baked key is still on disk, still valid.
    assert.ok(readFileSync(configPath, "utf8").includes("sk-other"));
  });

  test("logout of the active profile still strips baked keys", async () => {
    const home = process.env.AIAND_HOME;
    const configPath = join(home, ".config", "opencode", "opencode.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: "sk-device", "x-aiand": true } },
        },
        model: "aiand/m-default",
      }) + "\n",
    );
    await config.saveCredential("default", {
      access_token: "sk-device",
      refresh_token: "rt-device",
      origin: "device",
      storage: "plaintext",
    });

    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default" });
      assert.ok(
        !captured.log.err.join("").includes("left in place"),
        "active-profile logout strips instead of warning",
      );
    } finally {
      captured.restore();
    }

    assert.deepEqual(state.revocations, ["rt-device"]);
    assert.equal(await config.loadCredential("default"), null);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.ok(!("aiand" in (cfg.provider ?? {})));
    assert.ok(!readFileSync(configPath, "utf8").includes("sk-device"));
  });

  test("stored credential + AIAND_API_KEY still clears, then warns the Env key session remains", async () => {
    await config.saveCredential("default", {
      access_token: "sk-paste",
      origin: "paste",
      storage: "plaintext",
    });
    process.env.AIAND_API_KEY = "sk-env-12345";

    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default" });
      assert.match(
        captured.log.err.join(""),
        /AIAND_API_KEY.*still applies until it is unset/,
      );
      assert.match(captured.log.out.join(""), /Signed out/);
    } finally {
      captured.restore();
      delete process.env.AIAND_API_KEY;
    }

    assert.equal(await config.loadCredential("default"), null);
  });

  test("json not-signed-in emits JSON with no prose", async () => {
    delete process.env.AIAND_API_KEY;
    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default", json: true });
      // Throws on any leading prose — the --json stdout contract.
      const parsed = JSON.parse(cliStdout(captured));
      assert.equal(parsed.profile, "default");
      assert.equal(parsed.revoked, false);
      assert.equal(parsed.signed_in, false);
      assert.ok(!("note" in parsed), "no Env-key note without the env var");
    } finally {
      captured.restore();
    }
  });

  test("json not-signed-in with AIAND_API_KEY includes the Env-key note", async () => {
    process.env.AIAND_API_KEY = "sk-env-12345";
    const captured = captureOutput();
    try {
      await authLogout.logout({ profile: "default", json: true });
      const parsed = JSON.parse(cliStdout(captured));
      assert.equal(parsed.profile, "default");
      assert.equal(parsed.revoked, false);
      assert.match(parsed.note ?? "", /AIAND_API_KEY.*unset/);
    } finally {
      captured.restore();
      delete process.env.AIAND_API_KEY;
    }
  });
});
});
