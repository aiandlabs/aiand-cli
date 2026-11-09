import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { captureStdio, cliEnv, runCli, withEnv, withFetch, withTestEnv } from "./helpers.mjs";

// A stored credential is bound to the endpoints that issued it: a later
// --base-url, AIAND_BASE_URL, AIAND_AUTH_URL or `config set` pointing
// elsewhere must never receive its key or its refresh token. Two recording
// loopback servers stand in for the real gateway (A) and the override (B).

const env = withTestEnv("aiand-binding-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  process.env.CI = "1";
  process.env.NO_COLOR = "1";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
});

const config = await import("../dist/config.js");
const { openSession, request } = await import("../dist/api/client.js");
const { logout } = await import("../dist/auth/logout.js");
const { pasteLogin } = await import("../dist/auth/login.js");

/** A loopback server answering like the gateway and logging every request. */
async function recordingServer() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        path: req.url,
        authorization: req.headers.authorization ?? null,
        body,
      });
      const reply = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/auth/device/token") {
        return reply(200, {
          access_token: "sk-other-host",
          refresh_token: "rt-other-host",
          token_type: "Bearer",
          expires_in: 2592000,
        });
      }
      if (req.url === "/auth/device/logout") return reply(200, {});
      // A 401 on everything else would trigger the refresh path if the key got here.
      if (server.reject401) return reply(401, { error: "unauthorized" });
      if (req.url === "/api/user") return reply(200, { id: "u1", email: "a@example.com" });
      if (req.url === "/api/orgs") return reply(200, [{ id: "org_1", name: "Org" }]);
      return reply(200, { object: "list", data: [] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    set reject401(value) {
      server.reject401 = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let A;
let B;
before(async () => {
  A = await recordingServer();
  B = await recordingServer();
});
after(async () => {
  await A?.close();
  await B?.close();
});

/** A fresh config dir holding one device credential for `default`. */
function seed({ boundTo, expiresInDays = 30, profiles } = {}) {
  const cfg = mkdtempSync(join(env.dir, "cfg-"));
  writeFileSync(
    join(cfg, "credentials.json"),
    `${JSON.stringify({
      default: {
        origin: "device",
        ...(boundTo === undefined ? {} : { bound_to: boundTo }),
        expires_at: Math.floor(Date.now() / 1000) + expiresInDays * 24 * 3600,
        storage: "plaintext",
        user: { id: "u1", email: "a@example.com" },
      },
    })}\n`,
  );
  writeFileSync(
    join(cfg, "credentials-plaintext.json"),
    `${JSON.stringify({
      default: JSON.stringify({ access_token: "sk-real", refresh_token: "rt-real" }),
    })}\n`,
  );
  if (profiles) {
    writeFileSync(
      join(cfg, "config.json"),
      `${JSON.stringify({ profile: "default", profiles })}\n`,
    );
  }
  return cfg;
}

const boundToA = () => ({ auth_url: A.url, api_url: A.url });
const credentialsOf = (cfg) => JSON.parse(readFileSync(join(cfg, "credentials.json"), "utf8"));
const secretOf = (cfg) =>
  JSON.parse(JSON.parse(readFileSync(join(cfg, "credentials-plaintext.json"), "utf8")).default);

function cli(cfg, args, overrides = {}) {
  return runCli(args, {
    env: cliEnv({
      AIAND_CONFIG_DIR: cfg,
      AIAND_HOME: join(cfg, "home"),
      AIAND_API_KEY: undefined,
      AIAND_BASE_URL: undefined,
      AIAND_AUTH_URL: undefined,
      ...overrides,
    }),
  });
}

/**
 * Run `fn`, then assert nothing carrying a credential reached B: no
 * Authorization header, no body (refresh/revoke posts). A bare GET is not
 * checked, since a parallel test file probing a recycled loopback port can
 * land one here.
 */
async function nothingReachesB(fn) {
  const before = B.seen.length;
  await fn();
  const leaked = B.seen.slice(before).filter((r) => r.authorization !== null || r.body !== "");
  assert.deepEqual(leaked, [], "no credential may reach the override origin");
}

describe("a stored credential stays with its issuer", { concurrency: 1 }, () => {
  test("logged in on A, --base-url B: refused, and nothing reaches B", async () => {
    // B answers 401, which before the fix sent the refresh token there too.
    B.reject401 = true;
    try {
      const cfg = seed({ boundTo: boundToA() });
      await nothingReachesB(async () => {
        const { code, stderr } = await cli(cfg, ["whoami", "--base-url", B.url], {
          AIAND_AUTH_URL: B.url,
        });
        assert.equal(code, 2);
        assert.match(stderr, /issued for http:\/\/127\.0\.0\.1:\d+; refusing to send it to/);
        assert.match(stderr, /aiand login --profile <name> --base-url/);
      });
      assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
    } finally {
      B.reject401 = false;
    }
  });

  test("an expiring credential is not rotated against the override", async () => {
    const cfg = seed({ boundTo: boundToA(), expiresInDays: 1 });
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], { AIAND_BASE_URL: B.url });
      assert.equal(code, 2);
    });
    assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
  });

  test("AIAND_AUTH_URL alone pointing elsewhere is refused too", async () => {
    const cfg = seed({ boundTo: boundToA() });
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], {
        AIAND_BASE_URL: undefined,
        AIAND_AUTH_URL: B.url,
        // api-url still points at A through the stored profile
      });
      assert.equal(code, 2);
    });
  });

  test("`config set api-url` to another host is refused at the next request", async () => {
    const cfg = seed({
      boundTo: boundToA(),
      profiles: { default: { apiUrl: A.url, authUrl: A.url } },
    });
    assert.equal((await cli(cfg, ["config", "set", "api-url", B.url])).code, 0);
    await nothingReachesB(async () => {
      const { code, stderr } = await cli(cfg, ["models"]);
      assert.equal(code, 2);
      assert.match(stderr, /refusing to send it/);
    });
  });

  test("`key export` (what agents bake) refuses under --base-url B", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const { code, stdout } = await cli(cfg, ["key", "export", "--base-url", B.url]);
    assert.equal(code, 2);
    assert.doesNotMatch(stdout, /sk-real/);
  });

  test("the issuing endpoint still gets the key", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = A.seen.length;
    const { code } = await cli(cfg, ["whoami", "--json"], {
      AIAND_BASE_URL: A.url,
      AIAND_AUTH_URL: `${A.url}/`,
    });
    assert.equal(code, 0);
    const sent = A.seen.slice(before).map((r) => r.authorization);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((h) => h === "Bearer sk-real"));
  });

  test("AIAND_API_KEY is the user's per-run choice and goes where they point it", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = B.seen.length;
    const { code } = await cli(cfg, ["whoami", "--json"], {
      AIAND_API_KEY: "sk-from-env",
      AIAND_BASE_URL: B.url,
    });
    assert.equal(code, 0);
    const sent = B.seen.slice(before).map((r) => r.authorization);
    assert.ok(sent.length > 0);
    assert.ok(sent.every((h) => h === "Bearer sk-from-env"));
  });
});

describe("credentials saved before binding existed", { concurrency: 1 }, () => {
  test("with no stored URLs they are pinned to production, not to this run's override", async () => {
    const cfg = seed();
    await nothingReachesB(async () => {
      const { code } = await cli(cfg, ["whoami"], { AIAND_BASE_URL: B.url });
      assert.equal(code, 2);
    });
    assert.deepEqual(credentialsOf(cfg).default.bound_to, {
      auth_url: "https://api.aiand.com",
      api_url: "https://api.aiand.com",
    });
  });

  test("with stored profile URLs they are pinned there and keep working", async () => {
    const cfg = seed({ profiles: { default: { apiUrl: A.url, authUrl: A.url } } });
    const { code } = await cli(cfg, ["whoami", "--json"]);
    assert.equal(code, 0);
    assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA());
    // Pinned on first use: a later `config set` cannot move the key.
    await cli(cfg, ["config", "set", "auth-url", B.url]);
    await nothingReachesB(async () => {
      assert.equal((await cli(cfg, ["whoami"])).code, 2);
    });
  });
});

describe("in-process gates", { concurrency: 1 }, () => {
  test("request() refuses a baseUrl the credential is not bound to", async () => {
    const credential = {
      access_token: "sk-real",
      refresh_token: "rt-real",
      origin: "device",
      bound_to: boundToA(),
    };
    const session = {
      profile: { name: "default", apiUrl: A.url, authUrl: A.url },
      token: "sk-real",
      credential,
    };
    let fetched = 0;
    await withFetch(
      async () => {
        fetched += 1;
        return new Response("{}");
      },
      () =>
        assert.rejects(request(session, { path: "/api/user", baseUrl: B.url }), /refusing to send/),
    );
    assert.equal(fetched, 0);
  });

  test("a rotation never replaces a credential re-bound under it", async () => {
    const cfg = seed({ boundTo: boundToA() });
    await withEnv(
      { AIAND_CONFIG_DIR: cfg, AIAND_BASE_URL: A.url, AIAND_AUTH_URL: A.url },
      async () => {
        const session = await openSession(config.resolveProfile("default"));
        // Another process signs in elsewhere while this session is live.
        const all = credentialsOf(cfg);
        all.default.bound_to = { auth_url: B.url, api_url: B.url };
        writeFileSync(join(cfg, "credentials.json"), JSON.stringify(all));
        let refreshPosts = 0;
        await withFetch(
          async (url) => {
            if (new URL(url).pathname === "/auth/device/token") refreshPosts += 1;
            return new Response("{}", { status: 401 });
          },
          () => assert.rejects(request(session, { path: "/api/user" }), /refusing to send/),
        );
        assert.equal(refreshPosts, 0);
        assert.deepEqual(secretOf(cfg), { access_token: "sk-real", refresh_token: "rt-real" });
      },
    );
  });

  test("logout revokes at the issuer even under an override", async () => {
    const cfg = seed({ boundTo: boundToA() });
    const before = A.seen.length;
    await nothingReachesB(() =>
      withEnv(
        { AIAND_CONFIG_DIR: cfg, AIAND_HOME: join(cfg, "home"), AIAND_AUTH_URL: B.url },
        async () => {
          const muted = captureStdio({ mute: true });
          try {
            await logout({ profile: "default", revoke: true });
          } finally {
            muted.restore();
          }
        },
      ),
    );
    const revokes = A.seen.slice(before).filter((r) => r.path === "/auth/device/logout");
    assert.equal(revokes.length, 1);
    assert.match(revokes[0].body, /rt-real/);
  });

  test("a pasted key records the endpoint it was validated against", async () => {
    const cfg = mkdtempSync(join(env.dir, "cfg-paste-"));
    await withEnv(
      {
        AIAND_CONFIG_DIR: cfg,
        AIAND_HOME: join(cfg, "home"),
        AIAND_BASE_URL: A.url,
        AIAND_AUTH_URL: undefined,
      },
      async () => {
        const muted = captureStdio({ mute: true });
        try {
          await pasteLogin({ key: "sk-pasted" });
        } finally {
          muted.restore();
        }
      },
    );
    assert.deepEqual(credentialsOf(cfg).default.bound_to, boundToA());
  });
});
