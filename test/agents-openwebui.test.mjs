// Open WebUI adapter: the built CLI against a loopback double of Open WebUI's
// admin API (backend/open_webui/routers/openai.py, v0.13.x): GET
// /openai/config and POST /openai/config/update, admin bearer auth,
// index-keyed per-connection settings, keys padded/truncated to the URL
// count, settings outside the URL range dropped.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  CLOSED_URL,
  captureStdio,
  cliEnv,
  hermeticPath,
  runCli,
  seedCatalogCache,
  withEnv,
  withOpener,
  withTestEnv,
} from "./helpers.mjs";

const ADMIN = "sk-test-owui-admin";
const K1 = "sk-test-aiand-one";
const K2 = "sk-test-aiand-two";
// AIAND_BASE_URL is CLOSED_URL, so the connection `on` writes is its /v1.
const OURS_URL = `${CLOSED_URL}/v1`;
const sha = (value) => createHash("sha256").update(value).digest("hex");

const box = withTestEnv("aiand-openwebui-test-", () => {});

const connections = await import("../dist/agents/openwebui/connections.js");

/** The double's state; tests seed and inspect it directly. */
const owui = { config: null, requests: [], dropNextUpdateResponse: false };
let owuiUrl;
let server;

function seed({ enable = true, urls = [], keys = [], configs = {} } = {}) {
  owui.config = structuredClone({
    ENABLE_OPENAI_API: enable,
    OPENAI_API_BASE_URLS: urls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  });
  owui.requests = [];
}

/** POST /openai/config/update, as Open WebUI applies it. */
function applyUpdate(form) {
  const urls = form.OPENAI_API_BASE_URLS;
  let keys = form.OPENAI_API_KEYS;
  if (keys.length > urls.length) keys = keys.slice(0, urls.length);
  while (keys.length < urls.length) keys.push("");
  const inRange = new Set(urls.map((_, index) => String(index)));
  const configs = Object.fromEntries(
    Object.entries(form.OPENAI_API_CONFIGS).filter(([index]) => inRange.has(index)),
  );
  owui.config = {
    ENABLE_OPENAI_API: form.ENABLE_OPENAI_API,
    OPENAI_API_BASE_URLS: urls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  };
  return owui.config;
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      owui.requests.push({ method: req.method, url: req.url });
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${ADMIN}`) {
        return send(401, { detail: "Not authenticated" });
      }
      if (req.method === "GET" && req.url === "/openai/config") return send(200, owui.config);
      if (req.method === "POST" && req.url === "/openai/config/update") {
        const applied = applyUpdate(JSON.parse(body));
        if (owui.dropNextUpdateResponse) {
          // Applied, but the answer never arrives (a proxy timeout, a reset).
          owui.dropNextUpdateResponse = false;
          return req.socket.destroy();
        }
        return send(200, applied);
      }
      return send(404, { detail: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  owuiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function freshState() {
  const dir = mkdtempSync(join(box.dir, "state-"));
  const cfg = join(dir, "cfg");
  seedCatalogCache(cfg);
  return { home: join(dir, "home"), cfg };
}

/** The env a CLI child runs under: the double, an admin key, the ai& env key. */
function envFor(state, overrides = {}) {
  return cliEnv({
    AIAND_HOME: state.home,
    AIAND_CONFIG_DIR: state.cfg,
    AIAND_API_KEY: K1,
    AIAND_BASE_URL: CLOSED_URL,
    OPENWEBUI_URL: owuiUrl,
    OPENWEBUI_API_KEY: ADMIN,
    PATH: hermeticPath(dirname(process.execPath)),
    ...overrides,
  });
}

const cli = (args, state, overrides) => runCli(args, { env: envFor(state, overrides) });

const snapshotDir = (state) => join(state.cfg, "snapshots", "openwebui");
const addedPath = (state) => join(snapshotDir(state), "added.json");
const added = (state) => JSON.parse(readFileSync(addedPath(state), "utf8"));

const USER_A = "https://api.example-a.com/v1";
const USER_B = "http://localhost:11434/v1";
const CONFIG_A = { enable: true, tags: [{ name: "a" }], prefix_id: "a", model_ids: ["m1"] };
const CONFIG_B = { enable: false, tags: [], prefix_id: "", model_ids: [] };

function seedTwoUserConnections(enable = false) {
  seed({
    enable,
    urls: [USER_A, USER_B],
    keys: ["sk-user-a", ""],
    configs: { 0: CONFIG_A, 1: CONFIG_B },
  });
}

describe("openwebui connection list helpers", () => {
  test("removing a connection shifts later settings down one index", () => {
    const config = {
      ENABLE_OPENAI_API: true,
      OPENAI_API_BASE_URLS: ["a", "b", "c", "d"],
      OPENAI_API_KEYS: ["ka", "kb", "kc", "kd"],
      OPENAI_API_CONFIGS: { 0: { n: "a" }, 1: { n: "b" }, 3: { n: "d" } },
    };
    const next = connections.removeConnection(config, 1);
    assert.deepEqual(next.OPENAI_API_BASE_URLS, ["a", "c", "d"]);
    assert.deepEqual(next.OPENAI_API_KEYS, ["ka", "kc", "kd"]);
    assert.deepEqual(next.OPENAI_API_CONFIGS, { 0: { n: "a" }, 2: { n: "d" } });
    assert.deepEqual(config.OPENAI_API_BASE_URLS, ["a", "b", "c", "d"], "input untouched");
  });

  test("secret-bearing settings are split from the rest; auth_type is not a secret", () => {
    const settings = { enable: true, auth_type: "bearer", headers: { "X-Key": "h" }, api_key: "x" };
    assert.deepEqual(connections.withoutSecrets(settings), { enable: true, auth_type: "bearer" });
    assert.deepEqual(connections.secretsOf(settings), { headers: { "X-Key": "h" }, api_key: "x" });
  });
});

describe("aiand openwebui on", () => {
  test("adds the ai& connection after the user's, keeping their order, keys and settings", async () => {
    const state = freshState();
    seedTwoUserConnections(false);
    const { code, stdout, stderr } = await cli(["openwebui", "on", "--json"], state);
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.state, "on");
    assert.deepEqual(result.files, [`${owuiUrl} (OpenAI connections)`]);
    assert.ok(result.warnings.some((w) => /spends this org's ai& credit/.test(w)));

    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B, OURS_URL]);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", K1]);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS["0"], CONFIG_A);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS["1"], CONFIG_B);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS["2"], {
      enable: true,
      tags: [],
      prefix_id: "",
      model_ids: [],
      connection_type: "external",
      auth_type: "bearer",
    });
    assert.equal(owui.config.ENABLE_OPENAI_API, true, "on turns the OpenAI API on");

    const record = added(state);
    assert.equal(record.instanceUrl, owuiUrl);
    assert.equal(record.baseUrl, OURS_URL);
    assert.equal(record.keySha256, sha(K1));
    assert.equal(record.enabledApi, true);
    const onDisk = readFileSync(addedPath(state), "utf8");
    assert.ok(!onDisk.includes(K1) && !onDisk.includes(ADMIN), "no key literal recorded");
    if (process.platform !== "win32") {
      assert.equal(statSync(addedPath(state)).mode & 0o777, 0o600);
    }
  });

  test("refuses a connection to ai& that aiand did not add", async () => {
    const state = freshState();
    seed({ urls: [USER_A, OURS_URL], keys: ["sk-user-a", "sk-user-own-aiand"] });
    const before = structuredClone(owui.config);
    const { code, stderr } = await cli(["openwebui", "on"], state);
    assert.equal(code, 1);
    assert.match(stderr, /already has a connection to/);
    assert.match(stderr, /already routes to ai&/);
    assert.match(stderr, /Admin › Settings › Connections/);
    assert.deepEqual(owui.config, before, "nothing written");
    assert.equal(existsSync(addedPath(state)), false);
    assert.equal(existsSync(snapshotDir(state)), false, "the fresh snapshot is discarded");
  });

  test("re-on is idempotent, and a new session key replaces ours in place", async () => {
    const state = freshState();
    seedTwoUserConnections(true);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    // The user adds a connection after ours.
    owui.config.OPENAI_API_BASE_URLS.push("https://api.example-c.com/v1");
    owui.config.OPENAI_API_KEYS.push("sk-user-c");
    owui.config.OPENAI_API_CONFIGS["3"] = { enable: true, prefix_id: "c" };
    const capture = () =>
      JSON.parse(readFileSync(join(snapshotDir(state), "latest.json"), "utf8")).remote;
    const firstSnapshot = capture();

    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", K1, "sk-user-c"]);

    const { code, stderr } = await cli(["openwebui", "on"], state, { AIAND_API_KEY: K2 });
    assert.equal(code, 0, stderr);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [
      USER_A,
      USER_B,
      OURS_URL,
      "https://api.example-c.com/v1",
    ]);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", K2, "sk-user-c"]);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS["3"], { enable: true, prefix_id: "c" });
    assert.equal(added(state).keySha256, sha(K2));
    assert.equal(added(state).enabledApi, false, "the API was already on");
    assert.deepEqual(capture(), firstSnapshot, "the first capture stays authoritative");
  });

  test("a non-loopback http OPENWEBUI_URL is refused before any request", async () => {
    const state = freshState();
    seed();
    const { code, stderr } = await cli(["openwebui", "on"], state, {
      OPENWEBUI_URL: "http://chat.example.com",
    });
    assert.equal(code, 1);
    assert.match(stderr, /OPENWEBUI_URL must use https/);
    assert.equal(owui.requests.length, 0);
  });

  test("on without OPENWEBUI_API_KEY says how to get one", async () => {
    const state = freshState();
    seed();
    const { code, stderr } = await cli(["openwebui", "on"], state, {
      OPENWEBUI_API_KEY: undefined,
    });
    assert.equal(code, 1);
    assert.match(stderr, /Set OPENWEBUI_API_KEY to wire Open WebUI/);
    assert.match(stderr, /Settings › Account/);
    assert.equal(owui.requests.length, 0);
  });

  test("a rejected admin key gets the API-key hint and never leaks the key", async () => {
    const state = freshState();
    seed();
    const { code, stderr } = await cli(["openwebui", "on"], state, {
      OPENWEBUI_API_KEY: "sk-not-an-admin",
    });
    assert.equal(code, 1);
    assert.match(stderr, /refused OPENWEBUI_API_KEY \(HTTP 401\)/);
    assert.match(stderr, /belongs to an admin/);
    assert.match(stderr, /Admin › Settings › General/);
    assert.doesNotMatch(stderr, /sk-not-an-admin/);
  });

  test("an unreachable instance names its URL", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["openwebui", "on"], state, { OPENWEBUI_URL: CLOSED_URL });
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`Could not reach Open WebUI at ${CLOSED_URL}`));
  });
});

describe("aiand openwebui status", () => {
  test("no record: off, with no request to the instance", async () => {
    const state = freshState();
    seed({ urls: [OURS_URL], keys: [K1] });
    const { code, stdout } = await cli(["openwebui", "status", "--json"], state);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).state, "off");
    const all = await cli(["status", "--json"], state);
    const row = JSON.parse(all.stdout).agents.find((a) => a.agent === "openwebui");
    assert.equal(row.state, "off");
    assert.equal(row.installed, true, "OPENWEBUI_URL names an instance");
    assert.equal(owui.requests.length, 0, "probe makes no network call without a record");
  });

  test("on, then off, read from the live instance", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    const on = JSON.parse((await cli(["openwebui", "status", "--json"], state)).stdout);
    assert.equal(on.state, "on");
    assert.equal(on.model, null);
    // Removed by hand on the instance: status reads the live list, not the record.
    owui.config.OPENAI_API_BASE_URLS.pop();
    owui.config.OPENAI_API_KEYS.pop();
    const gone = JSON.parse((await cli(["openwebui", "status", "--json"], state)).stdout);
    assert.equal(gone.state, "off");
  });

  test("a record but no OPENWEBUI_API_KEY: status says it cannot check", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    const noKey = { OPENWEBUI_API_KEY: undefined, OPENWEBUI_URL: undefined };
    const one = await cli(["openwebui", "status"], state, noKey);
    assert.equal(one.code, 1);
    assert.match(one.stderr, /Set OPENWEBUI_API_KEY to check Open WebUI at/);

    const all = await cli(["status", "--json"], state, noKey);
    assert.equal(all.code, 0, all.stderr);
    const row = JSON.parse(all.stdout).agents.find((a) => a.agent === "openwebui");
    assert.equal(row.state, "unknown");
    assert.equal(row.binary, owuiUrl, "the recorded instance counts as installed");
    assert.match(row.error, /OPENWEBUI_API_KEY/);
    const text = await cli(["status"], state, { ...noKey, NO_COLOR: "1" });
    assert.equal(text.code, 0);
    assert.match(text.stdout, /openwebui\s+unknown/);
    assert.match(text.stderr, /openwebui: Set OPENWEBUI_API_KEY/);
  });
});

describe("aiand openwebui off", () => {
  test("hands the API flag back when on turned it on and nothing was added", async () => {
    const state = freshState();
    seedTwoUserConnections(false);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.equal(owui.config.ENABLE_OPENAI_API, true);
    assert.deepEqual(added(state).previousUrls, [USER_A, USER_B], "URLs only, never keys");
    assert.doesNotMatch(readFileSync(addedPath(state), "utf8"), /sk-/);
    assert.equal((await cli(["openwebui", "off"], state)).code, 0);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B]);
    assert.equal(owui.config.ENABLE_OPENAI_API, false, "on flipped it, so off hands it back");
  });

  test("removes only ours, re-indexes later settings, and keeps the API on for a connection added since", async () => {
    const state = freshState();
    seedTwoUserConnections(false);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    owui.config.OPENAI_API_BASE_URLS.push("https://api.example-c.com/v1");
    owui.config.OPENAI_API_KEYS.push("sk-user-c");
    owui.config.OPENAI_API_CONFIGS["3"] = { enable: true, prefix_id: "c" };

    const { code, stdout } = await cli(["openwebui", "off"], state);
    assert.equal(code, 0);
    assert.match(
      stdout,
      /left the OpenAI API on because connections were added after aiand turned it on/,
    );
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [
      USER_A,
      USER_B,
      "https://api.example-c.com/v1",
    ]);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", "sk-user-c"]);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS, {
      0: CONFIG_A,
      1: CONFIG_B,
      2: { enable: true, prefix_id: "c" },
    });
    assert.equal(owui.config.ENABLE_OPENAI_API, true, "the connection added since stays live");
    assert.equal(existsSync(addedPath(state)), false);
  });

  test("leaves the API flag on when it was on before", async () => {
    const state = freshState();
    seedTwoUserConnections(true);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.equal((await cli(["openwebui", "off"], state)).code, 0);
    assert.equal(owui.config.ENABLE_OPENAI_API, true);
  });

  test("a connection whose key the user changed is theirs: off leaves it", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    owui.config.OPENAI_API_KEYS[2] = "sk-user-replaced";
    const { code, stdout } = await cli(["openwebui", "off"], state);
    assert.equal(code, 0);
    assert.match(stdout, /Left the ai& connection in Open WebUI because you edited it/);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B, OURS_URL]);
    assert.equal(owui.config.OPENAI_API_KEYS[2], "sk-user-replaced");
    assert.equal(existsSync(addedPath(state)), false);
  });

  test("without OPENWEBUI_API_KEY, off fails and keeps the record", async () => {
    // A live key on a shared server must stop `off` (and so uninstall),
    // never pass as done.
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    owui.requests = [];
    const { code, stderr } = await cli(["openwebui", "off"], state, {
      OPENWEBUI_API_KEY: undefined,
    });
    assert.equal(code, 1);
    assert.match(stderr, /OPENWEBUI_API_KEY is not set, so aiand cannot remove the ai& key/);
    assert.match(stderr, /aiand openwebui off --force/);
    assert.equal(owui.requests.length, 0);
    assert.equal(added(state).keySha256, sha(K1), "the record stays for a later off");
    assert.equal(owui.config.OPENAI_API_KEYS[2], K1);

    // With the key, the recorded instance is reached even without OPENWEBUI_URL.
    const later = await cli(["openwebui", "off"], state, { OPENWEBUI_URL: undefined });
    assert.equal(later.code, 0);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B]);
  });

  test("off --force without OPENWEBUI_API_KEY forgets the instance and says the key is still there", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    owui.requests = [];
    const { code, stdout } = await cli(["openwebui", "off", "--force"], state, {
      OPENWEBUI_API_KEY: undefined,
    });
    assert.equal(code, 0);
    assert.match(stdout, /the ai& key is still on Open WebUI/);
    assert.match(stdout, /revoke the key/);
    assert.equal(owui.requests.length, 0);
    assert.equal(existsSync(addedPath(state)), false);
    assert.equal(owui.config.OPENAI_API_KEYS[2], K1, "nothing reached the instance");
  });
});

describe("aiand restore openwebui --force", () => {
  test("puts back URLs, settings and the API flag with live keys; no key ever on disk", async () => {
    const state = freshState();
    const headers = { "X-Custom-Auth": "hdr-secret-value" };
    seed({
      enable: false,
      urls: [USER_A, USER_B, "https://gone.example.com/v1"],
      keys: ["sk-user-a", "", "sk-user-gone"],
      configs: { 0: { ...CONFIG_A, headers }, 1: CONFIG_B },
    });
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);

    const snapshotText = readdirSync(snapshotDir(state), { recursive: true })
      .map((name) => join(snapshotDir(state), name))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    assert.doesNotMatch(snapshotText, /sk-/, "no key literal in the snapshot");
    assert.doesNotMatch(snapshotText, /hdr-secret-value/, "no secret header in the snapshot");
    assert.match(snapshotText, /api\.example-a\.com/);

    // Since `on`: the user rotated A's key, dropped one connection, reordered.
    owui.config = {
      ENABLE_OPENAI_API: true,
      OPENAI_API_BASE_URLS: [OURS_URL, USER_B, USER_A],
      OPENAI_API_KEYS: [K1, "", "sk-user-a-rotated"],
      OPENAI_API_CONFIGS: { 2: { enable: true, headers } },
    };
    added(state); // still recorded
    const { code, stdout, stderr } = await cli(["restore", "openwebui", "--force"], state);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Open WebUI config restored from snapshot/);
    assert.match(stderr, /no longer holds a key for https:\/\/gone\.example\.com\/v1/);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [
      USER_A,
      USER_B,
      "https://gone.example.com/v1",
    ]);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a-rotated", "", ""]);
    assert.deepEqual(owui.config.OPENAI_API_CONFIGS, { 0: { ...CONFIG_A, headers }, 1: CONFIG_B });
    assert.equal(owui.config.ENABLE_OPENAI_API, false);
    assert.equal(existsSync(snapshotDir(state)), false);

    const again = await cli(["restore", "openwebui", "--force"], state);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /No snapshot found for Open WebUI/);
  });

  test("on against another instance replaces the snapshot, so restore targets it", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.equal((await cli(["openwebui", "off"], state)).code, 0);
    // The same double under another name is another instance to aiand.
    const other = owuiUrl.replace("127.0.0.1", "localhost");
    seed({ enable: true, urls: [USER_B], keys: [""], configs: { 0: CONFIG_B } });
    assert.equal((await cli(["openwebui", "on"], state, { OPENWEBUI_URL: other })).code, 0);
    const manifest = JSON.parse(readFileSync(join(snapshotDir(state), "latest.json"), "utf8"));
    assert.equal(manifest.remote.instanceUrl, other);
    assert.deepEqual(manifest.remote.urls, [USER_B]);
  });
});

const { rebakeAgentKeys } = await import("../dist/agents/rebake.js");
const config = await import("../dist/config.js");

describe("rebake and logout", () => {
  /** In-process env for a state dir (rebake and saveCredential run here). */
  const inState = (state, overrides, fn) =>
    withEnv(
      {
        AIAND_HOME: state.home,
        AIAND_CONFIG_DIR: state.cfg,
        AIAND_API_KEY: undefined,
        OPENWEBUI_URL: undefined,
        OPENWEBUI_API_KEY: ADMIN,
        ...overrides,
      },
      fn,
    );

  async function quietly(fn) {
    await new Promise((resolve) => setImmediate(resolve));
    const muted = captureStdio({ mute: true });
    try {
      return await fn();
    } finally {
      muted.restore();
    }
  }

  test("rebake swaps our key on the instance and updates the fingerprint", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    const notes = await inState(state, {}, () => quietly(() => rebakeAgentKeys(K2)));
    const note = notes.find((n) => n.agent === "openwebui");
    assert.equal(note?.state, "refreshed", JSON.stringify(notes));
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", K2]);
    assert.equal(added(state).keySha256, sha(K2));

    // A rotation of some other key leaves ours alone, with no network call.
    owui.requests = [];
    const rotated = await inState(state, {}, () =>
      quietly(() => rebakeAgentKeys("sk-other-new", { previousKey: "sk-other-old" })),
    );
    assert.equal(
      rotated.find((n) => n.agent === "openwebui"),
      undefined,
    );
    assert.equal(owui.config.OPENAI_API_KEYS[2], K2);
  });

  test("rebake without OPENWEBUI_API_KEY tells the user to re-run on", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    const notes = await inState(state, { OPENWEBUI_API_KEY: undefined }, () =>
      quietly(() => rebakeAgentKeys(K2)),
    );
    const note = notes.find((n) => n.agent === "openwebui");
    assert.equal(note?.state, "failed");
    assert.match(note.note, /aiand openwebui on/);
    assert.equal(owui.config.OPENAI_API_KEYS[2], K1);
  });

  test("logout strips our connection from the instance", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    await inState(state, {}, () =>
      config.saveCredential("default", {
        access_token: K1,
        origin: "paste",
        storage: "plaintext",
      }),
    );
    const { code, stderr } = await cli(["logout"], state, {
      AIAND_API_KEY: undefined,
      OPENWEBUI_URL: undefined,
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B]);
    assert.equal(existsSync(addedPath(state)), false);
  });

  test("logout without OPENWEBUI_API_KEY says the key is still on the instance", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    await inState(state, {}, () =>
      config.saveCredential("default", {
        access_token: K1,
        origin: "paste",
        storage: "plaintext",
      }),
    );
    const { code, stderr } = await cli(["logout"], state, {
      AIAND_API_KEY: undefined,
      OPENWEBUI_API_KEY: undefined,
    });
    assert.equal(code, 0);
    assert.match(stderr, /\[openwebui\] Could not strip its key: OPENWEBUI_API_KEY is not set/);
    assert.match(stderr, /aiand openwebui off/);
    assert.equal(owui.config.OPENAI_API_KEYS[2], K1);
  });
});

describe("aiand openwebui (open)", () => {
  test("wires the instance, then prints its URL under AIAND_NO_BROWSER", async () => {
    const state = freshState();
    seedTwoUserConnections();
    const { code, stdout, stderr } = await cli(["openwebui"], state);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /Open WebUI is now using ai&\./);
    assert.match(stdout, new RegExp(`Open Open WebUI at ${owuiUrl}`));
    assert.match(stderr, /choose an ai& model/);
    assert.doesNotMatch(stdout + stderr, /Copilot/);
    assert.deepEqual(owui.config.OPENAI_API_KEYS, ["sk-user-a", "", K1]);

    // Already wired: opens again without another write.
    owui.requests = [];
    const again = await cli(["openwebui"], state);
    assert.equal(again.code, 0);
    assert.doesNotMatch(again.stderr, /now using ai&/);
    assert.ok(owui.requests.every((r) => r.method === "GET"));
  });

  test("opens the instance URL in the browser", {
    skip: process.platform === "win32",
  }, async () => {
    const state = freshState();
    seedTwoUserConnections();
    await withOpener(
      (dir) => `printf '%s' "$1" > "${join(dir, "opened")}"`,
      async () => {
        const { code, stdout } = await cli(["openwebui"], state, {
          PATH: `${process.env.PATH}${delimiter}${hermeticPath(dirname(process.execPath))}`,
          AIAND_NO_BROWSER: undefined,
        });
        assert.equal(code, 0);
        assert.match(stdout, new RegExp(`Opened Open WebUI at ${owuiUrl}`));
        const opener = process.env.PATH.split(delimiter)[0];
        assert.equal(readFileSync(join(opener, "opened"), "utf8"), owuiUrl);
      },
    );
  });

  test("passthrough args are refused", async () => {
    const state = freshState();
    seedTwoUserConnections();
    const { code, stderr } = await cli(["openwebui", "serve"], state);
    assert.equal(code, 1);
    assert.match(stderr, /takes no arguments/);
  });

  test("nothing named or recorded: the pip install hint, with no offer", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["openwebui"], state, {
      OPENWEBUI_URL: undefined,
      OPENWEBUI_API_KEY: undefined,
    });
    assert.equal(code, 127);
    assert.match(stderr, /Open WebUI is not installed/);
    assert.match(stderr, /pip install open-webui/);
    assert.match(stderr, /docs\.openwebui\.com/);
  });

  test("help documents the variables and never mentions the Copilot app", async () => {
    const state = freshState();
    const { code, stdout } = await cli(["openwebui", "--help"], state);
    assert.equal(code, 0);
    assert.match(stdout, /OPENWEBUI_URL/);
    assert.match(stdout, /OPENWEBUI_API_KEY/);
    assert.match(stdout, /opens Open WebUI in your browser/);
    assert.match(stdout, /third-party software that ai& does not\s+control/);
    assert.doesNotMatch(stdout, /Copilot/);
    assert.doesNotMatch(stdout, /recommended|verified|tested|secure\b|\bsafe\b/i);
  });

  test("run-agent refuses: there is no session launch", async () => {
    const state = freshState();
    const { code, stderr } = await cli(["run-agent", "openwebui"], state);
    assert.equal(code, 1);
    assert.match(stderr, /does not support session launches/);
  });
});

describe("review follow-ups", () => {
  test("status reads off while Open WebUI's OpenAI API or our connection is switched off", async () => {
    const state = freshState();
    seedTwoUserConnections(true);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    const status = async () =>
      JSON.parse((await cli(["openwebui", "status", "--json"], state)).stdout);
    assert.equal((await status()).state, "on");
    owui.config.ENABLE_OPENAI_API = false;
    assert.equal((await status()).state, "off", "API off: nothing routes");
    owui.config.ENABLE_OPENAI_API = true;
    owui.config.OPENAI_API_CONFIGS["2"] = { ...owui.config.OPENAI_API_CONFIGS["2"], enable: false };
    assert.equal((await status()).state, "off", "our connection off: nothing routes");
    // on turns ours back on, in place.
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.equal(owui.config.OPENAI_API_CONFIGS["2"].enable, true);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B, OURS_URL]);
    assert.equal((await status()).state, "on");
  });

  test("a write the instance applies but never answers still leaves off able to remove it", async () => {
    const state = freshState();
    seedTwoUserConnections(false);
    owui.dropNextUpdateResponse = true;
    const on = await cli(["openwebui", "on"], state);
    assert.notEqual(on.code, 0, "the lost response is an error");
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B, OURS_URL], "but it landed");
    assert.equal(added(state).keySha256, sha(K1), "and the record names it");
    const off = await cli(["openwebui", "off"], state);
    assert.equal(off.code, 0, off.stderr);
    assert.deepEqual(owui.config.OPENAI_API_BASE_URLS, [USER_A, USER_B]);
    assert.equal(owui.config.ENABLE_OPENAI_API, false, "the API flag on turned on goes back off");
  });

  test("a re-on never records our own URL as one that was there before", async () => {
    const state = freshState();
    seedTwoUserConnections(true);
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    owui.config.ENABLE_OPENAI_API = false; // an admin switched the API off
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.deepEqual(added(state).previousUrls, [USER_A, USER_B]);
  });

  test("off --force forgets an instance it cannot reach, even with the admin key set", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    // The instance went away (the record still names it): CLOSED_URL is loopback, refused.
    const record = added(state);
    record.instanceUrl = CLOSED_URL;
    writeFileSync(addedPath(state), JSON.stringify(record));
    const plain = await cli(["openwebui", "off"], state, { OPENWEBUI_URL: undefined });
    assert.equal(plain.code, 1, "without --force an unreachable instance stops off");
    assert.ok(existsSync(addedPath(state)));
    const forced = await cli(["openwebui", "off", "--force"], state, { OPENWEBUI_URL: undefined });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /could not reach Open WebUI .* the ai& key is still there/);
    assert.equal(existsSync(addedPath(state)), false);
  });

  test("status and URL errors never print credentials from OPENWEBUI_URL", async () => {
    const state = freshState();
    seed();
    const status = await cli(["openwebui", "status", "--json"], state, {
      OPENWEBUI_URL: "https://admin:hunter2@chat.example.com/?api_key=sk-leak",
      OPENWEBUI_API_KEY: undefined,
    });
    assert.doesNotMatch(status.stdout + status.stderr, /hunter2|sk-leak|admin:/);
    for (const url of [
      "https://chat.example.com/?api_key=sk-leak",
      "not a url sk-leak",
      "http://chat.example.com/sk-x?k=sk-leak",
    ]) {
      const on = await cli(["openwebui", "on"], state, { OPENWEBUI_URL: url });
      assert.equal(on.code, 1, url);
      assert.doesNotMatch(on.stdout + on.stderr, /sk-leak/, url);
    }
  });

  test("stray arguments are refused before anything is wired", async () => {
    const state = freshState();
    seedTwoUserConnections();
    const result = await cli(["openwebui", "unexpected"], state);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /takes no arguments/);
    assert.equal(owui.requests.length, 0, "no request reached the instance");
    assert.equal(existsSync(addedPath(state)), false);
  });

  test("a snapshot of a new instance replaces the old one, leaving one copy", async () => {
    const state = freshState();
    seedTwoUserConnections();
    assert.equal((await cli(["openwebui", "on"], state)).code, 0);
    assert.equal((await cli(["openwebui", "off"], state)).code, 0);
    const other = owuiUrl.replace("127.0.0.1", "localhost");
    assert.equal((await cli(["openwebui", "on"], state, { OPENWEBUI_URL: other })).code, 0);
    const dirs = readdirSync(snapshotDir(state)).filter((name) =>
      statSync(join(snapshotDir(state), name)).isDirectory(),
    );
    assert.equal(dirs.length, 1, dirs.join(", "));
    assert.equal(
      JSON.parse(readFileSync(join(snapshotDir(state), "latest.json"), "utf8")).remote.instanceUrl,
      other,
    );
  });
});
