import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { withTestEnv } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const BIN = join(dirname(import.meta.dirname), "dist", "index.js");

// Env-key Sessions (credential: null) must not borrow the stored Credential:
// orgs marks no Org active, whoami reports no expiry. Stored-only Sessions
// keep the old behavior. The CLI runs as a child process against a local
// identity stub; no live Gateway.
const env = withTestEnv("aiand-orgs-whoami-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = dir;
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_BASE_URL;
  delete process.env.AIAND_AUTH_URL;
  delete process.env.AIAND_PROFILE;
  process.env.CI = "1"; // keep housekeeping lines off the stderr path
  process.env.NO_COLOR = "1";
});

const ORGS = [
  { id: "org_1", name: "First Org" },
  { id: "org_2", name: "Second Org" },
];
// 2030-01-01T00:00:00.000Z — far future so nothing rotates it.
const EXPIRES_AT = 1893456000;

let server;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/user") return reply(200, { id: "u1", email: "dev@example.com" });
    if (req.url === "/api/orgs") return reply(200, ORGS);
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Seed a leftover pasted-key credential (no refresh_token, so openSession
 * never rotates over the network) with a stored Org that is NOT first in the
 * stub list, so order-guessing and stored-marking stay distinguishable.
 */
function seedCredential() {
  writeFileSync(
    join(env.dir, "credentials.json"),
    JSON.stringify({
      default: {
        origin: "paste",
        storage: "plaintext",
        expires_at: EXPIRES_AT,
        user: { id: "u1", email: "dev@example.com" },
        org: { id: "org_2", name: "Second Org" },
      },
    }) + "\n"
  );
  writeFileSync(
    join(env.dir, "credentials-plaintext.json"),
    JSON.stringify({ default: JSON.stringify({ access_token: "sk-stored-leftover" }) }) + "\n"
  );
}

const runCli = async (args, extraEnv = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, AIAND_BASE_URL: baseUrl, ...extraEnv },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

describe("orgs under an Env-key Session", () => {
  test("no Org is marked active despite a leftover stored Credential", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["orgs", "--json"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    const orgs = JSON.parse(stdout);
    assert.equal(orgs.length, 2);
    assert.deepEqual(
      orgs.map((o) => o.active),
      [false, false]
    );
  });

  test("text mode explains the scope is unknown", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["orgs"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    assert.match(stdout, /unknown under AIAND_API_KEY/);
    assert.doesNotMatch(stdout, /\*/);
  });
});

describe("orgs under a stored Credential Session", () => {
  test("the stored Org is still marked active", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["orgs", "--json"]);
    assert.equal(code, 0);
    const orgs = JSON.parse(stdout);
    assert.deepEqual(
      orgs.map((o) => [o.id, o.active]),
      [
        ["org_1", false],
        ["org_2", true],
      ]
    );
  });
});

describe("whoami under an Env-key Session", () => {
  test("key_expires_at is null and source is env despite leftover Credential", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["whoami", "--json"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    const identity = JSON.parse(stdout);
    assert.equal(identity.key_expires_at, null);
    assert.equal(identity.source, "AIAND_API_KEY");
    assert.equal(identity.storage, null);
  });

  test("text mode reads expiry from AIAND_API_KEY", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["whoami"], { AIAND_API_KEY: "sk-env-key" });
    assert.equal(code, 0);
    assert.match(stdout, /from AIAND_API_KEY/);
    assert.doesNotMatch(stdout, /rotated automatically/);
  });
});

describe("whoami under a stored Credential Session", () => {
  test("stored-only still shows the stored expiry", async () => {
    seedCredential();
    const { code, stdout } = await runCli(["whoami", "--json"]);
    assert.equal(code, 0);
    const identity = JSON.parse(stdout);
    assert.equal(identity.key_expires_at, new Date(EXPIRES_AT * 1000).toISOString());
    assert.equal(identity.source, "pasted-key");
  });
});
