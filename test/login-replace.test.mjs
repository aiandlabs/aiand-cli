import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  captureOutput,
  dir,
  MINTED_ACCESS_TOKEN,
  MINTED_REFRESH_TOKEN,
  registerAuthStub,
  state,
  stubBinding,
} from "./auth-stub.mjs";

// `aiand login` replacing a profile's sign-in: the old minted key is revoked
// where it was issued, after the new tokens arrive and before they are
// stored, and never when the new sign-in fails. Runs the real command (dist
// build) against the stub server; no TTY here, so the command takes the
// device path and needs --force to replace.

const loginCommand = await import("../dist/commands/login.js");
const config = await import("../dist/config.js");
const replace = await import("../dist/auth/replace.js");
const authLogin = await import("../dist/auth/login.js");
const client = await import("../dist/api/client.js");
const errors = await import("../dist/cli/errors.js");

registerAuthStub();

async function seed(credential) {
  await config.saveCredential("default", { storage: "plaintext", ...credential });
}

/** A pre-0.8 sign-in: saveCredential always records a binding, so drop it. */
async function seedUnbound(credential) {
  await seed(credential);
  const path = join(dir, "credentials.json");
  const all = JSON.parse(readFileSync(path, "utf8"));
  delete all.default.bound_to;
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  assert.equal((await config.loadCredential("default")).bound_to, undefined);
}

async function login(argv) {
  const captured = captureOutput();
  try {
    await loginCommand.run(argv);
  } finally {
    captured.restore();
  }
  const stderr = captured.log.err.join("");
  assert.doesNotMatch(stderr, /aiand\.com\b(?!\/api-keys)/, "a test sign-in reached past the stub");
  return stderr;
}

/** A pre-0.8 agent snapshot holding `key`, as scrubKeyCopies finds them. */
function seedSnapshotCopy(key) {
  const stamp = join(dir, "snapshots", "codex", "20250101T000000Z");
  mkdirSync(stamp, { recursive: true });
  const copy = join(stamp, "config.toml");
  writeFileSync(copy, `api_key = "${key}"\n`);
  return copy;
}

/** A second issuer, to see where a revoke for the old binding is sent. */
async function otherIssuer() {
  const revocations = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/auth/device/logout") {
        revocations.push(JSON.parse(raw || "{}").refresh_token ?? null);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    revocations,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

describe("login replacing a sign-in (serial)", { concurrency: 1 }, () => {
  test("an unbound sign-in in aiand's own config dir is revoked at the issuer config.json names", async () => {
    await seedUnbound({ access_token: "sk-old", refresh_token: "rt-old", origin: "device" });
    // aiand's config.json, no id yet (pre-0.8), naming the stub as the issuer.
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({ profile: "default", profiles: { default: { apiUrl: stubBinding().api_url, authUrl: stubBinding().auth_url } } })}\n`,
    );

    await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"]);
  });

  test("--force revokes the replaced minted key and stores the new one", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const stderr = await login(["--force"]);

    const now = await config.loadCredential("default");
    assert.equal(now.access_token, MINTED_ACCESS_TOKEN);
    assert.equal(now.refresh_token, MINTED_REFRESH_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"], "only the old refresh token is revoked");
    assert.match(stderr, /Revoked the key this profile signed in with before/);
  });

  test("the revoke goes to the issuer the old sign-in recorded, not the new one", async () => {
    const other = await otherIssuer();
    try {
      await seed({
        access_token: "sk-old",
        refresh_token: "rt-old",
        origin: "device",
        bound_to: { auth_url: other.url, api_url: other.url },
      });

      await login(["--force"]);

      assert.deepEqual(other.revocations, ["rt-old"]);
      assert.deepEqual(state.revocations, [], "the new issuer never sees the old refresh token");
    } finally {
      other.close();
    }
  });

  test("--keep-remote replaces the sign-in and leaves the old key valid", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const stderr = await login(["--force", "--keep-remote"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /still valid/);
  });

  test("a failed revoke off a terminal keeps the old sign-in and revokes the new key", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.rejectRefresh.push("rt-old");

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /Kept the existing sign-in/);
    } finally {
      captured.restore();
    }

    const kept = await config.loadCredential("default");
    assert.equal(kept.access_token, "sk-old");
    assert.equal(kept.refresh_token, "rt-old");
    assert.deepEqual(
      state.revocations,
      [MINTED_REFRESH_TOKEN],
      "the new key is revoked, not left orphaned",
    );
    assert.match(captured.log.err.join(""), /HTTP 500/);
  });

  test("the old key is revoked before the new sign-in is stored", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    let storedAtRevoke;
    state.onLogout = () => {
      storedAtRevoke = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).default;
    };
    try {
      await login(["--force"]);
    } finally {
      state.onLogout = null;
    }
    assert.ok(storedAtRevoke, "a revoke was sent");
    assert.notEqual(
      storedAtRevoke.access_token,
      MINTED_ACCESS_TOKEN,
      "the new sign-in was not stored yet",
    );
    assert.deepEqual(state.revocations, ["rt-old"]);
    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
  });

  test("a pasted key is replaced but never revoked", async () => {
    await seed({ access_token: "sk-pasted-old", origin: "paste", bound_to: stubBinding() });

    const stderr = await login(["--force"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
    assert.match(stderr, /was pasted, so this CLI did not revoke it/);
  });

  test("a minted key with no refresh token is kept off a terminal, as a failed revoke is", async () => {
    await seed({ access_token: "sk-old", origin: "device", bound_to: stubBinding() });

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /Kept the existing sign-in/);
    } finally {
      captured.restore();
    }

    assert.equal((await config.loadCredential("default")).access_token, "sk-old");
    assert.deepEqual(state.revocations, [MINTED_REFRESH_TOKEN], "the new key is revoked");
    assert.match(captured.log.err.join(""), /No refresh token was stored/);
  });

  test("--keep-remote replaces a minted key that has no refresh token", async () => {
    await seed({ access_token: "sk-old", origin: "device", bound_to: stubBinding() });

    await login(["--force", "--keep-remote"]);

    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, []);
  });

  test("a failed sign-in keeps the old sign-in and revokes nothing", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    // Denied, not down: the revoke endpoint stays up, so a revoke sent too
    // early would land and show in state.revocations.
    state.tokenError = "access_denied";

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /denied/i);
    } finally {
      captured.restore();
    }

    const kept = await config.loadCredential("default");
    assert.equal(kept.access_token, "sk-old");
    assert.equal(kept.refresh_token, "rt-old");
    assert.deepEqual(state.revocations, []);
  });

  test("an unbound sign-in beside another install's config.json is kept, not revoked", async () => {
    // Pre-0.8 shape: no bound_to, so the issuer would come from config.json,
    // and this one carries an id the marker does not: copied from elsewhere.
    await seedUnbound({ access_token: "sk-old", refresh_token: "rt-old", origin: "device" });
    writeFileSync(
      join(dir, "config.json"),
      `${JSON.stringify({ profile: "default", profiles: { default: { apiUrl: stubBinding().api_url, authUrl: stubBinding().auth_url } }, config_id: "0".repeat(32) })}\n`,
    );

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /Kept the existing sign-in/);
    } finally {
      captured.restore();
    }

    assert.equal((await config.loadCredential("default")).access_token, "sk-old");
    assert.deepEqual(state.revocations, [MINTED_REFRESH_TOKEN], "only the new key is revoked");
    assert.match(captured.log.err.join(""), /does not record where it was issued/);
  });

  test("a step that fails after the new sign-in is stored still revokes and scrubs the old key", async () => {
    const copy = seedSnapshotCopy("sk-test-old-0123456789");
    await seed({
      access_token: "sk-test-old-0123456789",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    // activateProfile writes config.json (an atomic rename) after the credential is saved.
    const original = fsp.rename;
    fsp.rename = async (from, to, ...rest) => {
      if (String(to).endsWith("config.json"))
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return original(from, to, ...rest);
    };
    syncBuiltinESMExports();
    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /no space left/);
    } finally {
      fsp.rename = original;
      syncBuiltinESMExports();
      captured.restore();
    }
    assert.equal((await config.loadCredential("default")).access_token, MINTED_ACCESS_TOKEN);
    assert.deepEqual(state.revocations, ["rt-old"]);
    assert.equal(existsSync(copy), false, "the old key's snapshot copy is scrubbed");
  });

  test("a kept sign-in leaves its key's snapshot copies alone", async () => {
    const copy = seedSnapshotCopy("sk-test-old-0123456789");
    await seed({
      access_token: "sk-test-old-0123456789",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.rejectRefresh.push("rt-old");
    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--force"]), /Kept the existing sign-in/);
    } finally {
      captured.restore();
    }
    assert.equal(existsSync(copy), true);
  });

  test("the re-read, the revoke and the save hold the refresh lock together", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    // A refresh elsewhere asks for the lock while the old key's revoke is in flight.
    let seenByRefresh;
    state.onLogout = () => {
      seenByRefresh ??= client.withRefreshLock(
        "default",
        async () => (await config.loadCredential("default")).access_token,
      );
    };
    try {
      await login(["--force"]);
    } finally {
      state.onLogout = null;
    }
    assert.equal(
      await seenByRefresh,
      MINTED_ACCESS_TOKEN,
      "the refresh got the lock only once the new sign-in was stored",
    );
  });

  test("a failed revoke names the profile without its control characters", async () => {
    const profile = "evil\x1b[2J";
    await config.saveCredential(profile, {
      storage: "plaintext",
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.rejectRefresh.push("rt-old");
    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run(["--profile", profile, "--force"]));
    } finally {
      captured.restore();
    }
    const stderr = captured.log.err.join("");
    assert.match(stderr, /Could not revoke/);
    assert.equal(stderr.includes("\x1b[2J"), false);
  });

  test("a pasted key that is the stored key is saved without revoking it", async () => {
    await seed({
      access_token: "sk-test-same-0123456789",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    const replaced = await replace.noteReplacedSignIn(
      "default",
      await config.loadCredential("default"),
    );
    const captured = captureOutput();
    let result;
    try {
      result = await replace.retireBeforeSave(replaced, {
        accessToken: "sk-test-same-0123456789",
        binding: stubBinding(),
      });
    } finally {
      captured.restore();
    }
    assert.equal(result.outcome, "unchanged");
    assert.equal(result.failed, undefined);
    assert.deepEqual(state.revocations, []);
  });

  test("a token rotated during the sign-in is the one revoked", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    const replaced = await replace.noteReplacedSignIn(
      "default",
      await config.loadCredential("default"),
    );
    // Another process (Codex's key export) rotates the old sign-in while the browser waits.
    await seed({
      access_token: "sk-rotated",
      refresh_token: "rt-rotated",
      origin: "device",
      bound_to: stubBinding(),
    });
    const captured = captureOutput();
    let result;
    try {
      result = await replace.retireBeforeSave(replaced, {
        accessToken: "sk-new",
        refreshToken: "rt-new",
        binding: stubBinding(),
      });
    } finally {
      captured.restore();
    }
    assert.deepEqual(result, { outcome: "revoked", key: "sk-rotated" });
    assert.deepEqual(state.revocations, ["rt-rotated"]);
  });

  test("an unreadable store at revoke time falls back to the sign-in read when login started", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    const replaced = await replace.noteReplacedSignIn(
      "default",
      await config.loadCredential("default"),
    );
    writeFileSync(join(dir, "credentials.json"), "{ not json");
    const captured = captureOutput();
    let result;
    try {
      result = await replace.retireBeforeSave(replaced, {
        accessToken: "sk-new",
        refreshToken: "rt-new",
        binding: stubBinding(),
      });
    } finally {
      captured.restore();
    }
    assert.equal(result.outcome, "revoked");
    assert.deepEqual(state.revocations, ["rt-old"]);
  });

  test("a failed revoke is reported to the caller, not decided where it happens", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });
    state.rejectRefresh.push("rt-old");
    const replaced = await replace.noteReplacedSignIn(
      "default",
      await config.loadCredential("default"),
    );
    const captured = captureOutput();
    let result;
    try {
      result = await replace.retireBeforeSave(replaced, {
        accessToken: "sk-new",
        refreshToken: "rt-new",
        binding: stubBinding(),
      });
    } finally {
      captured.restore();
    }
    assert.equal(result.outcome, "failed");
    assert.match(result.failed.question, /Replace the sign-in anyway/);
    assert.match(result.failed.keep.message, /Kept the existing sign-in/);
    assert.deepEqual(state.revocations, [], "nothing revoked yet: the caller decides");
  });

  describe("replaceAndSave", () => {
    const incoming = () => ({
      accessToken: "sk-test-new-0123456789",
      refreshToken: "rt-new",
      binding: stubBinding(),
    });
    const quiet = async (promise) => {
      const captured = captureOutput();
      try {
        return await promise;
      } finally {
        captured.restore();
      }
    };
    const keep = () => new Error("kept the old sign-in");

    test("asks with the refresh lock released, and saves on yes", async () => {
      let lockFreeWhileAsking = false;
      const saved = await authLogin.replaceAndSave(
        "default",
        incoming(),
        async () => ({
          kind: "ask",
          keep: keep(),
          confirm: async () => {
            lockFreeWhileAsking = await Promise.race([
              client.withRefreshLock("default", async () => true),
              new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
            ]);
            return true;
          },
        }),
        async () => "saved",
      );
      assert.equal(saved, "saved");
      assert.equal(
        lockFreeWhileAsking,
        true,
        "another process could take the lock during the question",
      );
      assert.deepEqual(state.revocations, []);
    });

    test("no to the question keeps the old sign-in and revokes the new key", async () => {
      let saves = 0;
      await assert.rejects(
        authLogin.replaceAndSave(
          "default",
          incoming(),
          async () => ({
            kind: "ask",
            keep: keep(),
            confirm: async () => false,
          }),
          async () => saves++,
        ),
        /kept the old sign-in/,
      );
      assert.equal(saves, 0);
      assert.deepEqual(state.revocations, ["rt-new"]);
    });

    test("keep revokes the new key without asking", async () => {
      await assert.rejects(
        authLogin.replaceAndSave(
          "default",
          incoming(),
          async () => ({ kind: "keep", keep: keep() }),
          async () => "x",
        ),
        /kept the old sign-in/,
      );
      assert.deepEqual(state.revocations, ["rt-new"]);
    });

    test("a save that fails after the old key was retired revokes the new key and says so", async () => {
      const error = await quiet(
        authLogin
          .replaceAndSave(
            "default",
            incoming(),
            async () => ({ kind: "save", retired: true }),
            async () => {
              throw new Error("disk full");
            },
          )
          .then(
            () => assert.fail("the save failure must surface"),
            (e) => e,
          ),
      );
      assert.match(error.message, /disk full/);
      assert.match(error.message, /revoked/);
      assert.match(error.message, /not saved/);
      assert.match(error.hint, /aiand login --force/);
      assert.deepEqual(
        state.revocations,
        ["rt-new"],
        "no key is left live without a local way to revoke it",
      );
    });

    test("a new key that cannot be revoked is named in the error", async () => {
      state.rejectRefresh.push("rt-new");
      const error = await quiet(
        authLogin
          .replaceAndSave(
            "default",
            incoming(),
            async () => ({ kind: "keep", keep: keep() }),
            async () => "x",
          )
          .then(
            () => assert.fail("keep must reject"),
            (e) => e,
          ),
      );
      assert.match(error.message, /kept the old sign-in/);
      const told = `${error.message} ${error.hint ?? ""}`;
      assert.match(told, /new key .*was not revoked/);
      assert.ok(told.includes(config.maskKey("sk-test-new-0123456789")), told);
      assert.ok(told.includes(config.CONSOLE_KEYS_URL), told);
      assert.deepEqual(state.revocations, []);
    });

    test("Ctrl-C at the question revokes the new key and saves nothing", async () => {
      let saves = 0;
      await assert.rejects(
        quiet(
          authLogin.replaceAndSave(
            "default",
            incoming(),
            async () => ({
              kind: "ask",
              keep: keep(),
              confirm: async () => {
                throw errors.loginCancelled();
              },
            }),
            async () => saves++,
          ),
        ),
        /cancelled/i,
      );
      assert.equal(saves, 0);
      assert.deepEqual(state.revocations, ["rt-new"]);
    });

    test("a rotation while the question is open is revoked before the save", async () => {
      await seed({
        access_token: "sk-old",
        refresh_token: "rt-old",
        origin: "device",
        bound_to: stubBinding(),
      });
      const saved = await quiet(
        authLogin.replaceAndSave(
          "default",
          incoming(),
          async () => ({
            kind: "ask",
            keep: keep(),
            confirm: async () => {
              // Codex's key export rotates the old sign-in while the user decides.
              await seed({
                access_token: "sk-rotated",
                refresh_token: "rt-rotated",
                origin: "device",
                bound_to: stubBinding(),
              });
              return true;
            },
          }),
          async () => "saved",
        ),
      );
      assert.equal(saved, "saved");
      assert.deepEqual(state.revocations, ["rt-rotated"]);
    });
  });

  test("without --force and no terminal, an existing sign-in is refused untouched", async () => {
    await seed({
      access_token: "sk-old",
      refresh_token: "rt-old",
      origin: "device",
      bound_to: stubBinding(),
    });

    const captured = captureOutput();
    try {
      await assert.rejects(loginCommand.run([]), /already signed in/);
    } finally {
      captured.restore();
    }
    assert.equal((await config.loadCredential("default")).access_token, "sk-old");
    assert.deepEqual(state.revocations, []);
  });
});
