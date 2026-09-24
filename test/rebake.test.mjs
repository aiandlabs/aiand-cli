import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { captureStdio, withEnv, withFetch, withTestEnv } from "./helpers.mjs";

const K1 = "sk-test-sync-key-1";
const K2 = "sk-test-sync-key-2";

let home;
const box = withTestEnv("aiand-sync-test-", (dir) => {
  home = join(dir, "home");
  const cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
  delete process.env.AIAND_API_KEY;
});

/** Run `fn` with AIAND_HOME on a fresh `<tmp>/<name>` dir (created), restored after. */
function inHome(name, fn) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return withEnv({ AIAND_HOME: dir }, () => fn(dir));
}

const { opencodeAdapter } = await import("../dist/agents/opencode.js");
const { rebakeAgentKeys } = await import("../dist/agents/rebake.js");
const { registerAgent, AGENTS } = await import("../dist/agents/registry.js");

// Resolved from the live AIAND_HOME: tests switch homes mid-file and the seed
// must land where the adapter under test actually reads.
const opencodeConfig = () => join(process.env.AIAND_HOME, ".config", "opencode", "opencode.json");

function seedOpencodeConfig(key = K1, model = "m-default") {
  mkdirSync(dirname(opencodeConfig()), { recursive: true });
  writeFileSync(
    opencodeConfig(),
    `${JSON.stringify({
      provider: {
        aiand: { options: { baseURL: "https://api.aiand.com/v1", apiKey: key, "x-aiand": true } },
      },
      model: `aiand/${model}`,
    })}\n`,
  );
}

// The test reporter prints results asynchronously: a result line queued by the
// previous test can land inside this test's suppression window and get eaten
// (undercounted suites, swallowed failures). Yield first so pending reporter
// output flushes before stdout is muted.
async function muteCliOutput() {
  await new Promise((resolve) => setImmediate(resolve));
  const muted = captureStdio({ mute: true });
  return () => muted.restore();
}

describe("rebakeAgentKeys", () => {
  test("refreshes the opencode key literal, leaves the model ref untouched, skips active-no-refresh adapters, no notes for inactive", async () => {
    // Enable opencode with K1, plus a fixture adapter that is active but
    // persists no refreshable key (the "re-run on" skip path).
    seedOpencodeConfig(K1, "m-default");

    const fixtureTag = "__sync_no_refresh__";
    const fixtureFile = join(home, ".sync-fixture", "state");
    mkdirSync(join(home, ".sync-fixture"), { recursive: true });
    writeFileSync(fixtureFile, "active\n");
    registerAgent({
      id: fixtureTag,
      label: "Sync Fixture",
      bin: fixtureTag,
      install: { command: "", url: "" },
      detect: () => ({ installed: true, path: fixtureFile }),
      managedFiles: () => [fixtureFile],
      probe: async () => ({
        // Active only when the marker lives under the CURRENT home, so the
        // fixture never leaks into tests that switch AIAND_HOME.
        active: existsSync(join(process.env.AIAND_HOME, ".sync-fixture", "state")),
        model: "fixture",
      }),
      enable: async () => ({ model: "fixture", filesWritten: [fixtureFile] }),
      disable: async () => undefined,
    });

    const before = readFileSync(opencodeConfig(), "utf8");

    const notes = await rebakeAgentKeys(K2);

    // opencode key swapped; model ref + unrelated bytes untouched.
    assert.equal(
      readFileSync(opencodeConfig(), "utf8") !== before,
      true,
      "opencode file rewritten",
    );
    const wired = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
    assert.equal(wired.provider.aiand.options.apiKey, K2);
    assert.equal(wired.model, "aiand/m-default", "model ref untouched");

    // opencode refreshed; fixture adapter skipped with the re-run guidance.
    const opencodeNote = notes.find((n) => n.agent === "opencode");
    const skipNote = notes.find((n) => n.agent === fixtureTag);
    assert.equal(opencodeNote?.state, "refreshed");
    assert.equal(skipNote?.state, "skipped");
    assert.match(skipNote.note, /Re-run `aiand __sync_no_refresh__ on`/);

    // No other agent produced a note: the rest of the registry is inactive here.
    for (const adapter of AGENTS) {
      if (adapter.id === "opencode" || adapter.id === fixtureTag) continue;
      assert.equal(
        notes.some((n) => n.agent === adapter.id),
        false,
        `${adapter.id} should have no note (inactive)`,
      );
    }
  });

  test("produces no notes on a fresh home with nothing active", () =>
    inHome("fresh", async () => {
      assert.deepEqual(await rebakeAgentKeys(K2), []);
    }));

  test("is idempotent: a second rebake with the same key leaves files untouched", () =>
    inHome("idempotent", async () => {
      seedOpencodeConfig(K2, "m-default");
      const first = readFileSync(opencodeConfig(), "utf8");
      const notes = await rebakeAgentKeys(K2);
      assert.equal(
        notes.some((n) => n.agent === "opencode" && n.state === "refreshed"),
        true,
      );
      assert.equal(readFileSync(opencodeConfig(), "utf8"), first, "same key is a no-op");
    }));

  test("swaps the key in a marked config whose baseURL reads inactive", async () => {
    // A marked config with a non-loopback http: URL probes inactive, but it
    // still holds our baked key: rebake must swap it, not skip it.
    await inHome("rebake-bad-url", async () => {
      mkdirSync(dirname(opencodeConfig()), { recursive: true });
      writeFileSync(
        opencodeConfig(),
        `${JSON.stringify({
          provider: {
            aiand: { options: { baseURL: "http://example.com/v1", apiKey: K1, "x-aiand": true } },
          },
          model: "aiand/m-default",
        })}\n`,
      );
      assert.equal((await opencodeAdapter.probe()).active, false, "bad URL must read inactive");
      const notes = await rebakeAgentKeys(K2);
      const wired = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
      assert.equal(wired.provider.aiand.options.apiKey, K2);
      assert.equal(notes.find((n) => n.agent === "opencode")?.state, "refreshed");
    });
  });

  test("a throwing probe yields a failed note and still attempts refreshKey", async () => {
    const stubId = "__rebake_probe_throw__";
    registerAgent({
      id: stubId,
      label: "Probe Throw Fixture",
      bin: stubId,
      install: { command: "", url: "" },
      detect: () => ({ installed: true, path: null }),
      managedFiles: () => [],
      probe: async () => {
        // Armed only under the throwing home, so the stub never leaks into
        // other tests that switch AIAND_HOME.
        if (existsSync(join(process.env.AIAND_HOME, ".probe-throw", "armed"))) {
          throw new Error("probe blew up");
        }
        return { active: false, model: null };
      },
      enable: async () => ({ model: "fixture", filesWritten: [] }),
      disable: async () => undefined,
      refreshKey: async () => {
        writeFileSync(join(process.env.AIAND_HOME, ".probe-throw", "refresh-attempted"), "yes");
      },
    });

    await inHome("rebake-probe-throw", async (throwHome) => {
      mkdirSync(join(throwHome, ".probe-throw"), { recursive: true });
      writeFileSync(join(throwHome, ".probe-throw", "armed"), "yes");
      const notes = await rebakeAgentKeys(K2);
      const note = notes.find((n) => n.agent === stubId);
      assert.equal(note?.state, "failed", "throwing probe must not silently skip");
      assert.match(note.note, /probe blew up/);
      assert.equal(
        existsSync(join(throwHome, ".probe-throw", "refresh-attempted")),
        true,
        "refreshKey still attempted after a probe throw",
      );
    });
  });
});

/**
 * Run `fn` on a fresh home + credential store (plaintext tier) with CLI
 * output muted. The runner is non-TTY, so isInteractive() is false and
 * logout never prompts. `extraEnv` layers more overrides on top.
 */
async function withLogoutEnv(tag, fn, extraEnv = {}) {
  const logoutHome = join(box.dir, tag);
  const logoutCfg = join(box.dir, `${tag}-cfg`);
  mkdirSync(logoutHome, { recursive: true });
  mkdirSync(logoutCfg, { recursive: true });
  await withEnv(
    {
      AIAND_HOME: logoutHome,
      AIAND_CONFIG_DIR: logoutCfg,
      AIAND_KEY_STORAGE: "plaintext",
      ...extraEnv,
    },
    async () => {
      // logout announces on stdout; keep the test output clean.
      const unmute = await muteCliOutput();
      try {
        const config = await import("../dist/config.js");
        const { logout } = await import("../dist/auth/logout.js");
        await fn({ config, logout, logoutHome });
      } finally {
        unmute();
      }
    },
  );
}

describe("logout strips baked keys", () => {
  test("logout removes the baked key/provider from an active opencode config", async () => {
    await withLogoutEnv("logout-strip", async ({ config, logout }) => {
      seedOpencodeConfig(K1, "m-default");
      await config.saveCredential("logout-strip", {
        access_token: K1,
        origin: "paste",
        storage: "plaintext",
      });
      // Teardown only strips agent configs when the logged-out profile is
      // the active one (its key is the one rebake baked in). Sign-in promotes
      // the profile; mirror that here.
      await config.saveConfig({ profile: "logout-strip", profiles: { "logout-strip": {} } });
      await logout({ profile: "logout-strip" });
      assert.equal(await config.loadCredential("logout-strip"), null);
      // Seeded by the test, not created by enable(): strip the keys, keep the file.
      assert.equal(
        existsSync(opencodeConfig()),
        true,
        "user-created config is not deleted on strip",
      );
      const stripped = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
      assert.equal(stripped.provider, undefined);
      assert.equal(stripped["x-aiand"], undefined);
    });
  });

  test("logout teardown follows config.profile, not AIAND_PROFILE", async () => {
    // AIAND_PROFILE names another profile, yet teardown must still run: the
    // stored active profile is the one whose key is baked into the config.
    await withLogoutEnv(
      "logout-env-override",
      async ({ config, logout }) => {
        seedOpencodeConfig(K1, "m-default");
        await config.saveCredential("logout-strip", {
          access_token: K1,
          origin: "paste",
          storage: "plaintext",
        });
        await config.saveConfig({ profile: "logout-strip", profiles: { "logout-strip": {} } });
        await logout({ profile: "logout-strip" });
        assert.equal(await config.loadCredential("logout-strip"), null);
        const stripped = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
        assert.equal(stripped.provider, undefined);
        assert.equal(stripped["x-aiand"], undefined);
      },
      { AIAND_PROFILE: "other" },
    );
  });

  test("logout strips a marked config whose baseURL reads inactive", async () => {
    // Marked + garbage baseURL probes inactive (status off), but logout must
    // still strip the baked key: disable() gates on the marker, not the probe.
    await withLogoutEnv("logout-bad-url", async ({ config, logout }) => {
      mkdirSync(dirname(opencodeConfig()), { recursive: true });
      writeFileSync(
        opencodeConfig(),
        `${JSON.stringify({
          provider: {
            aiand: { options: { baseURL: "::not a url::", apiKey: K1, "x-aiand": true } },
          },
          model: "aiand/m-default",
        })}\n`,
      );
      assert.equal((await opencodeAdapter.probe()).active, false, "garbage URL must read inactive");
      await config.saveCredential("logout-bad-url", {
        access_token: K1,
        origin: "paste",
        storage: "plaintext",
      });
      await config.saveConfig({ profile: "logout-bad-url", profiles: { "logout-bad-url": {} } });
      await logout({ profile: "logout-bad-url" });
      assert.equal(await config.loadCredential("logout-bad-url"), null);
      assert.equal(
        existsSync(opencodeConfig()),
        true,
        "user-created config is not deleted on strip",
      );
      const raw = readFileSync(opencodeConfig(), "utf8");
      assert.equal(raw.includes(K1), false, "no baked key left on disk");
      const stripped = JSON.parse(raw);
      assert.equal(stripped.provider.aiand.options.apiKey, undefined);
      assert.equal(stripped["x-aiand"], undefined);
      assert.equal(stripped.provider.aiand.options["x-aiand"], undefined);
    });
  });

  test("logout attempts disable even when probe() throws", async () => {
    const stubId = "__logout_probe_throw__";
    registerAgent({
      id: stubId,
      label: "Logout Throw Fixture",
      bin: stubId,
      install: { command: "", url: "" },
      detect: () => ({ installed: true, path: null }),
      managedFiles: () => [],
      probe: async () => {
        if (existsSync(join(process.env.AIAND_HOME, ".logout-throw", "armed"))) {
          throw new Error("probe blew up");
        }
        return { active: false, model: null };
      },
      enable: async () => ({ model: "fixture", filesWritten: [] }),
      disable: async () => {
        writeFileSync(join(process.env.AIAND_HOME, ".logout-throw", "stripped"), "yes");
      },
    });

    await withLogoutEnv("logout-probe-throw", async ({ config, logout, logoutHome }) => {
      mkdirSync(join(logoutHome, ".logout-throw"), { recursive: true });
      writeFileSync(join(logoutHome, ".logout-throw", "armed"), "yes");
      await config.saveCredential("logout-probe-throw", {
        access_token: K1,
        origin: "paste",
        storage: "plaintext",
      });
      await config.saveConfig({
        profile: "logout-probe-throw",
        profiles: { "logout-probe-throw": {} },
      });
      await logout({ profile: "logout-probe-throw" });
      assert.equal(await config.loadCredential("logout-probe-throw"), null);
      assert.equal(
        existsSync(join(logoutHome, ".logout-throw", "stripped")),
        true,
        "disable() attempted despite the probe throw",
      );
    });
  });
});

describe("automatic key rotation rebakes", () => {
  const client = () => import("../dist/api/client.js");
  const config = () => import("../dist/config.js");

  /** A device credential for `default` inside the rotation window. */
  function seedExpiringCredential(accessToken) {
    const cfg = process.env.AIAND_CONFIG_DIR;
    writeFileSync(
      join(cfg, "credentials.json"),
      `${JSON.stringify({
        default: {
          origin: "device",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          storage: "plaintext",
        },
      })}\n`,
    );
    writeFileSync(
      join(cfg, "credentials-plaintext.json"),
      `${JSON.stringify({
        default: JSON.stringify({ access_token: accessToken, refresh_token: "rt-old" }),
      })}\n`,
    );
  }

  const rotateTo = (next) => async (url) => {
    assert.equal(new URL(url).pathname, "/auth/device/token", `unexpected fetch ${url}`);
    return new Response(
      JSON.stringify({
        access_token: next,
        refresh_token: "rt-new",
        token_type: "Bearer",
        expires_in: 2592000,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const rotationEnv = {
    AIAND_AUTH_URL: "https://auth.example.test",
    AIAND_KEY_STORAGE: "plaintext",
  };

  test("a rotated key replaces the old one in opencode's config", () =>
    inHome("rotate-swap", () =>
      withEnv(rotationEnv, async () => {
        seedOpencodeConfig(K1);
        seedExpiringCredential(K1);
        const { openSession } = await client();
        const { resolveProfile } = await config();
        const muted = captureStdio();
        let session;
        try {
          session = await withFetch(rotateTo(K2), () => openSession(resolveProfile("default")));
        } finally {
          muted.restore();
        }
        assert.equal(session.token, K2);
        const baked = JSON.parse(readFileSync(opencodeConfig(), "utf8"));
        assert.equal(baked.provider.aiand.options.apiKey, K2);
        assert.match(muted.log.err.join(""), /\[opencode\] Key refreshed\./);
      }),
    ));

  test("a config baked from another profile's key is left alone", () =>
    inHome("rotate-other-profile", () =>
      withEnv(rotationEnv, async () => {
        seedOpencodeConfig("sk-test-other-profile");
        seedExpiringCredential(K1);
        const before = readFileSync(opencodeConfig(), "utf8");
        const { openSession } = await client();
        const { resolveProfile } = await config();
        const muted = captureStdio();
        try {
          await withFetch(rotateTo(K2), () => openSession(resolveProfile("default")));
        } finally {
          muted.restore();
        }
        assert.equal(readFileSync(opencodeConfig(), "utf8"), before);
        assert.doesNotMatch(muted.log.err.join(""), /\[opencode\]/);
      }),
    ));
});
