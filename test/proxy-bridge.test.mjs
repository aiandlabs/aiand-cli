import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { bridgeRelaunchPlan, wantsSystemProxy } from "../dist/cli/proxy.js";
import { startBridge } from "../dist/net/forwarder.js";
import { systemCurl } from "../dist/net/proxy-auth.js";
import { loadPac, ProxyResolver } from "../dist/net/resolver.js";
import { proxyCredentials, startSystemBridge } from "../dist/net/system-bridge.js";
import { NEGOTIATE_TOKEN, startAuthProxy } from "./auth-proxy.mjs";
import { BIN, cliEnv, FAKE_API_KEY, lf, writeConfigMarker } from "./helpers.mjs";

const USER = { username: "alice", password: "correct horse" };
let root;
let api;
let apiPort;
let pacServer;
let pacOrigin;
const pacScripts = new Map();
const pacHits = [];

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aiand-proxy-bridge-"));
  api = createServer((req, res) => {
    res.writeHead(req.url === "/v1/models" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: [] } : { error: "stub" }));
    req.resume();
  });
  pacServer = createServer((req, res) => {
    pacHits.push(req.url);
    const script = pacScripts.get(req.url);
    res.writeHead(script === undefined ? 404 : 200, {
      "Content-Type": "application/x-ns-proxy-autoconfig",
    });
    res.end(script ?? "");
  });
  apiPort = await listen(api);
  pacOrigin = `http://127.0.0.1:${await listen(pacServer)}`;
});

after(async () => {
  api.closeAllConnections();
  pacServer.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => api.close(resolve)),
    new Promise((resolve) => pacServer.close(resolve)),
  ]);
  rmSync(root, { recursive: true, force: true });
});

/** GET the stub API's /v1/models through a proxy URL (with its userinfo), via CONNECT. */
async function getThrough(proxyUrl, targetPort = apiPort) {
  const proxy = new URL(proxyUrl);
  const headers = {};
  if (proxy.username) {
    const pair = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers["proxy-authorization"] = `Basic ${Buffer.from(pair).toString("base64")}`;
  }
  const connectReq = request({
    host: proxy.hostname,
    port: proxy.port,
    method: "CONNECT",
    path: `127.0.0.1:${targetPort}`,
    headers,
  });
  connectReq.end();
  const [response, socket] = await once(connectReq, "connect");
  if (response.statusCode !== 200) {
    socket.destroy();
    return { status: response.statusCode };
  }
  const get = request({
    path: "/v1/models",
    host: "127.0.0.1",
    createConnection: () => socket,
  });
  get.end();
  const [res] = await once(get, "response");
  let body = "";
  for await (const chunk of res) body += chunk;
  socket.destroy();
  return { status: res.statusCode, body };
}

const noCurl = { platform: process.platform, curl: null, credentials: null };

test("the bridge refuses a client without its password", async () => {
  const bridge = await startBridge({ routes: async () => [{ kind: "direct" }], auth: noCurl });
  try {
    const url = new URL(bridge.url);
    url.password = "wrong";
    assert.equal((await getThrough(url.href)).status, 407);
    url.username = "";
    url.password = "";
    assert.equal((await getThrough(url.href)).status, 407);
    assert.equal((await getThrough(bridge.url)).status, 200);
  } finally {
    await bridge.close();
  }
});

test("the bridge signs in with Basic, reconnecting when the proxy closes on 407", async () => {
  for (const closeOn407 of [false, true]) {
    const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, closeOn407 });
    const bridge = await startBridge({
      routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
      auth: { ...noCurl, credentials: USER },
    });
    try {
      const result = await getThrough(bridge.url);
      assert.equal(result.status, 200, `closeOn407=${closeOn407}`);
      assert.equal(result.body, '{"data":[]}');
      assert.deepEqual(proxy.tunnels, [`127.0.0.1:${apiPort}`]);
      assert.deepEqual(proxy.signIns, ["Basic"]);
    } finally {
      await bridge.close();
      await proxy.close();
    }
  }
});

test("a wrong password, or a scheme aiand cannot answer, is reported and fails the tunnel", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  const wrong = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { ...noCurl, credentials: { username: "alice", password: "nope" } },
  });
  const digest = await startAuthProxy({ schemes: ["Digest"] });
  const unsupported = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: digest.port }],
    auth: noCurl,
  });
  try {
    assert.equal((await getThrough(wrong.url)).status, 502);
    assert.match(
      wrong.failures().join("\n"),
      /signing in to the proxy 127\.0\.0\.1:\d+ failed \(tried Basic; last answer HTTP 407\)/,
    );
    assert.doesNotMatch(wrong.failures().join("\n"), /nope/);
    assert.equal((await getThrough(unsupported.url)).status, 502);
    assert.match(
      unsupported.failures().join("\n"),
      /asks for sign-in aiand cannot give \(offered: Digest\)/,
    );
  } finally {
    await Promise.all([wrong.close(), unsupported.close(), proxy.close(), digest.close()]);
  }
});

test("routes are tried in order: a dead proxy falls through to the next, then DIRECT", async () => {
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  const lines = [];
  const bridge = await startBridge({
    routes: async (url) =>
      url.port === String(apiPort)
        ? [
            { kind: "proxy", host: "127.0.0.1", port: deadPort },
            { kind: "proxy", host: "127.0.0.1", port: proxy.port },
          ]
        : [{ kind: "direct" }],
    auth: { ...noCurl, credentials: USER },
    log: (line) => lines.push(line),
  });
  const other = createServer((_req, res) => res.end("direct")).listen(0, "127.0.0.1");
  await once(other, "listening");
  try {
    assert.equal((await getThrough(bridge.url)).status, 200);
    assert.deepEqual(proxy.tunnels, [`127.0.0.1:${apiPort}`]);
    const direct = await getThrough(bridge.url, other.address().port);
    assert.equal(direct.body, "direct");
    assert.ok(
      lines.some((line) => line.endsWith(": DIRECT")),
      lines.join("\n"),
    );
  } finally {
    other.close();
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("plain http requests in absolute form go through the bridge too", async () => {
  const bridge = await startBridge({ routes: async () => [{ kind: "direct" }], auth: noCurl });
  try {
    const proxy = new URL(bridge.url);
    const req = request({
      host: "127.0.0.1",
      port: proxy.port,
      path: `http://127.0.0.1:${apiPort}/v1/models`,
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`aiand:${proxy.password}`).toString("base64")}`,
      },
    });
    req.end();
    const [res] = await once(req, "response");
    let body = "";
    for await (const chunk of res) body += chunk;
    assert.equal(res.statusCode, 200);
    assert.equal(body, '{"data":[]}');
  } finally {
    await bridge.close();
  }
});

function curlFeatures(curl) {
  try {
    return execFileSync(curl, ["-V"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

const curl = systemCurl();
const curlNtlm = curl !== null && /\bNTLM\b/.test(curlFeatures(curl));

test("NTLM: the system curl computes each token and aiand relays it, the proxy checking NTLMv2", {
  skip: curlNtlm ? false : "no system curl with NTLM",
}, async () => {
  const proxy = await startAuthProxy({ schemes: ["NTLM"], ...USER });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl, credentials: USER },
  });
  try {
    const result = await getThrough(bridge.url);
    assert.equal(result.status, 200, bridge.failures().join("\n"));
    assert.deepEqual(proxy.signIns, ["NTLM"]);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("NTLM with a wrong password fails at the proxy, not before", {
  skip: curlNtlm ? false : "no system curl with NTLM",
}, async () => {
  const proxy = await startAuthProxy({ schemes: ["NTLM"], ...USER });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl, credentials: { username: "alice", password: "x" } },
  });
  try {
    assert.equal((await getThrough(bridge.url)).status, 502);
    assert.deepEqual(proxy.signIns, []);
    assert.match(bridge.failures().join("\n"), /tried NTLM/);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

/** A stand-in for curl's Negotiate: speaks SOCKS5 to aiand and sends a fixed token. */
function plantNegotiateCurl(dir) {
  const path = join(dir, "curl");
  const record = join(dir, "curl-config.txt");
  writeFileSync(
    path,
    `#!${process.execPath}
const net = require("node:net");
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, fs.readFileSync(0, "utf8") + args.join(" "));
const socks = new URL(args[args.indexOf("--preproxy") + 1]);
const proxy = new URL(args[args.indexOf("--proxy") + 1]);
const s = net.connect(Number(socks.port), socks.hostname, () => s.write(Buffer.from([5, 1, 0])));
let stage = 0;
let buf = Buffer.alloc(0);
s.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (stage === 0 && buf.length >= 2) {
    buf = buf.subarray(2);
    const host = Buffer.from(proxy.hostname);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(Number(proxy.port));
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, port]));
    stage = 1;
  }
  if (stage === 1 && buf.length >= 10) {
    buf = buf.subarray(10);
    s.write("GET http://aiand.invalid/ HTTP/1.1\\r\\nHost: aiand.invalid\\r\\n\\r\\n");
    stage = 2;
  }
  if (stage === 2 && buf.includes("\\r\\n\\r\\n")) {
    const head = buf.toString("latin1");
    buf = Buffer.alloc(0);
    if (/Proxy-Authenticate: Negotiate\\r\\n/.test(head)) {
      s.write("GET http://aiand.invalid/ HTTP/1.1\\r\\nHost: aiand.invalid\\r\\nProxy-Authorization: Negotiate ${NEGOTIATE_TOKEN}\\r\\n\\r\\n");
      stage = 3;
    }
  }
});
s.on("close", () => process.exit(0));
`,
  );
  chmodSync(path, 0o755);
  return { path, record };
}

test("Negotiate: curl's token is relayed, the proxy host is what curl names, and no password reaches curl", {
  skip: process.platform === "win32" ? "the stand-in curl is a script" : false,
}, async () => {
  const dir = mkdtempSync(join(root, "curl-"));
  const stub = plantNegotiateCurl(dir);
  const proxy = await startAuthProxy({ schemes: ["Negotiate", "NTLM"] });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "localhost", port: proxy.port }],
    auth: { platform: process.platform, curl: stub.path, credentials: null },
  });
  try {
    const result = await getThrough(bridge.url);
    assert.equal(result.status, 200, bridge.failures().join("\n"));
    assert.deepEqual(proxy.signIns, ["Negotiate"]);
    const record = readFileSync(stub.record, "utf8");
    assert.match(record, /^proxy-user = ":"\n/);
    assert.match(record, /--proxy http:\/\/localhost:\d+ --proxy-negotiate/);
    assert.match(record, /^-q /m);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("WPAD (lookup mocked) finds a PAC served locally; its proxies are trusted only inside the domain", async () => {
  pacScripts.set(
    "/wpad.dat",
    `function FindProxyForURL(url, host) {
      if (isPlainHostName(host)) return "DIRECT";
      if (host === "far.example") return "PROXY proxy.elsewhere.example:8080";
      if (host === "ip.example") return "PROXY 203.0.113.9:8080; PROXY 10.0.0.9:8080; PROXY bare:3128";
      return isResolvable("intranet.corp.example") ? "PROXY proxy.corp.example:8080; DIRECT" : "DIRECT";
    }`,
  );
  const lookups = [];
  const resolver = new ProxyResolver(
    { source: "test", autoDetect: true, wpadDomains: ["eng.corp.example"], wpadDhcp: [] },
    {
      loadPac: (url) => loadPac(url.replace("http://wpad.corp.example", pacOrigin)),
      resolve: async (host) => {
        lookups.push(host);
        return host === "wpad.corp.example" || host === "intranet.corp.example" ? "10.0.0.1" : null;
      },
      localAddress: async () => "10.0.0.2",
      now: Date.now,
    },
  );
  try {
    assert.equal(await resolver.prepare(), true);
    assert.equal(resolver.pacUrl, "http://wpad.corp.example/wpad.dat");
    assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
      { kind: "proxy", host: "proxy.corp.example", port: 8080, trust: "intranet" },
      { kind: "direct" },
    ]);
    assert.deepEqual(await resolver.routes(new URL("http://intranet/")), [{ kind: "direct" }]);
    assert.deepEqual(await resolver.routes(new URL("https://far.example/")), [
      { kind: "proxy", host: "proxy.elsewhere.example", port: 8080, trust: "none" },
    ]);
    assert.deepEqual(await resolver.routes(new URL("https://ip.example/")), [
      { kind: "proxy", host: "203.0.113.9", port: 8080, trust: "none" },
      { kind: "proxy", host: "10.0.0.9", port: 8080, trust: "intranet" },
      { kind: "proxy", host: "bare", port: 3128, trust: "intranet" },
    ]);
    assert.deepEqual(lookups.slice(0, 2), ["wpad.eng.corp.example", "wpad.corp.example"]);
    assert.ok(lookups.includes("intranet.corp.example"));
    assert.equal(resolver.state.myIp, "10.0.0.2");
  } finally {
    resolver.close();
  }
});

test("a PAC that will not load falls back to the fixed proxy; with neither, nothing is started", async () => {
  const fixed = { https: { host: "proxy", port: 3128 }, bypass: [], bypassPlain: false };
  const resolver = new ProxyResolver({
    source: "test",
    autoDetect: false,
    pacUrl: `${pacOrigin}/missing.pac`,
    fixed,
  });
  assert.equal(await resolver.prepare(), true);
  assert.match(resolver.notes.join("\n"), /answered 404/);
  assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
    { kind: "proxy", host: "proxy", port: 3128 },
  ]);
  const empty = await startSystemBridge({
    cache: null,
    env: { AIAND_PROXY_PAC: `${pacOrigin}/missing.pac` },
    platform: "linux",
    discovery: {
      platform: "linux",
      env: { AIAND_PROXY_PAC: `${pacOrigin}/missing.pac` },
      run: async () => ({ code: 1, stdout: "" }),
      readFile: () => null,
      exists: () => false,
      policy: async () => ({ settings: {}, sources: {} }),
    },
  });
  assert.equal(empty, null);
});

test("a PAC file over 1 MB is refused", async () => {
  pacScripts.set(
    "/huge.pac",
    `// ${"x".repeat(1024 * 1024)}\nfunction FindProxyForURL() { return "DIRECT"; }`,
  );
  await assert.rejects(loadPac(`${pacOrigin}/huge.pac`), /larger than 1 MB/);
  await assert.rejects(loadPac("ftp://example.invalid/p.pac"), /http or https/);
});

test("proxy credentials come only from AIAND_PROXY_USERNAME and AIAND_PROXY_PASSWORD", () => {
  assert.equal(proxyCredentials({}), null);
  assert.deepEqual(
    proxyCredentials({ AIAND_PROXY_USERNAME: "CORP\\alice", AIAND_PROXY_PASSWORD: "pw" }),
    {
      username: "CORP\\alice",
      password: "pw",
    },
  );
});

test("only a process with no proxy variable, not yet relaunched, looks at system settings", () => {
  assert.equal(wantsSystemProxy({}), true);
  assert.equal(wantsSystemProxy({ https_proxy: "http://p:1" }), false);
  assert.equal(wantsSystemProxy({ AIAND_PROXY_RELAUNCHED: "1" }), false);
});

test("the bridge relaunch points every proxy variable at the bridge and drops the proxy credentials", () => {
  const base = {
    execPath: "/usr/bin/node",
    execArgv: [],
    argv: ["/usr/bin/node", "/opt/aiand/dist/index.js", "models"],
    bridgeUrl: "http://aiand:pw@127.0.0.1:4000",
    bridgeMarker: "AIAND_PROXY_BRIDGE",
    dropVars: ["AIAND_PROXY_USERNAME", "AIAND_PROXY_PASSWORD"],
  };
  const env = {
    PATH: "/bin",
    AIAND_PROXY_USERNAME: "alice",
    AIAND_PROXY_PASSWORD: "pw",
    NO_PROXY: ".corp",
  };
  const unix = bridgeRelaunchPlan({ ...base, env, sea: false, platform: "linux" });
  assert.deepEqual(unix.args, [
    "--disable-warning=UNDICI-EHPA",
    "/opt/aiand/dist/index.js",
    "models",
  ]);
  assert.deepEqual(unix.env, {
    PATH: "/bin",
    NO_PROXY: ".corp",
    HTTPS_PROXY: base.bridgeUrl,
    https_proxy: base.bridgeUrl,
    HTTP_PROXY: base.bridgeUrl,
    http_proxy: base.bridgeUrl,
    NODE_USE_ENV_PROXY: "1",
    AIAND_PROXY_RELAUNCHED: "1",
    AIAND_PROXY_BRIDGE: "1",
  });
  const windows = bridgeRelaunchPlan({
    ...base,
    env: { Path: "C:\\bin", aiand_proxy_password: "pw" },
    sea: true,
    platform: "win32",
    // A single executable's argv as Node builds it: path, the name it was run as, then the arguments.
    argv: ["C:\\aiand\\aiand.exe", "aiand", "models"],
    argv0: "aiand",
  });
  assert.deepEqual(windows.args, ["models"]);
  const bare = bridgeRelaunchPlan({
    ...base,
    env: {},
    sea: true,
    platform: "linux",
    argv: ["/opt/aiand", "models", "--json"],
  });
  assert.deepEqual(bare.args, ["models", "--json"]);
  assert.deepEqual(Object.keys(windows.env).sort(), [
    "AIAND_PROXY_BRIDGE",
    "AIAND_PROXY_RELAUNCHED",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NODE_USE_ENV_PROXY",
    "Path",
  ]);
});

// --- The CLI end to end: a locally served PAC, a proxy that wants sign-in ---

async function runCli(env, args = ["models", "--json"], home = mkdtempSync(join(root, "home-"))) {
  if (!existsSync(join(home, "config"))) {
    mkdirSync(join(home, "config"), { recursive: true });
    // A config dir from an earlier sign-in, as the discovery cache needs.
    writeConfigMarker(join(home, "config"));
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    env: cliEnv({
      HOME: home,
      USERPROFILE: home,
      AIAND_HOME: home,
      AIAND_CONFIG_DIR: join(home, "config"),
      AIAND_API_KEY: FAKE_API_KEY,
      AIAND_BASE_URL: `http://127.0.0.1:${apiPort}`,
      AIAND_AUTH_URL: undefined,
      AIAND_ALLOW_KEY_TO: `http://127.0.0.1:${apiPort}`,
      AIAND_SYSTEM_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      NO_PROXY: undefined,
      no_proxy: undefined,
      NODE_USE_ENV_PROXY: undefined,
      AIAND_PROXY_RELAUNCHED: undefined,
      ...env,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  return { code, stdout: lf(stdout), stderr: lf(stderr) };
}

// A gateway the CLI reaches over plain http must be on loopback, and loopback
// never goes through a proxy, so these end-to-end runs check routing and the
// bridge; signing in through a proxy is covered at the bridge above.
test("with no proxy variable, aiand follows AIAND_PROXY_PAC through its bridge, keeping loopback direct", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  pacScripts.set(
    "/basic.pac",
    `function FindProxyForURL() { return "PROXY 127.0.0.1:${proxy.port}"; }`,
  );
  try {
    const result = await runCli({
      AIAND_PROXY_PAC: `${pacOrigin}/basic.pac`,
      AIAND_PROXY_USERNAME: USER.username,
      AIAND_PROXY_PASSWORD: USER.password,
      AIAND_DEBUG: "1",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "[]\n");
    assert.match(
      result.stderr,
      /Proxy: AIAND_PROXY_PAC \(PAC http:\/\/127\.0\.0\.1:\d+\/basic\.pac\)/,
    );
    assert.match(result.stderr, new RegExp(`127\\.0\\.0\\.1:${apiPort}: DIRECT`));
    assert.doesNotMatch(result.stderr, /correct horse|aiand:[A-Za-z0-9_-]{20,}@/);
    assert.deepEqual(proxy.tunnels, []);
    assert.deepEqual(proxy.requests, []);
  } finally {
    await proxy.close();
  }
});

test("a PAC that answers DIRECT: the bridge connects to the gateway directly", async () => {
  pacScripts.set("/direct.pac", 'function FindProxyForURL() { return "DIRECT"; }');
  const result = await runCli({ AIAND_PROXY_PAC: `${pacOrigin}/direct.pac`, AIAND_DEBUG: "1" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /: DIRECT/);
});

test("version, help and local-only commands never read the proxy settings", async () => {
  pacScripts.set("/count.pac", 'function FindProxyForURL() { return "DIRECT"; }');
  const env = { AIAND_PROXY_PAC: `${pacOrigin}/count.pac` };
  const before = pacHits.length;
  for (const args of [
    ["--version"],
    ["-v"],
    ["help"],
    ["--help"],
    ["models", "--help"],
    ["config", "path"],
    ["opencode", "status"],
  ]) {
    const result = await runCli(env, args);
    assert.notEqual(result.code, null, args.join(" "));
  }
  assert.equal(pacHits.length, before);
  await runCli(env);
  assert.equal(pacHits.length, before + 1);
});

test("a second command within minutes reuses the discovered settings instead of fetching the PAC again", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  pacScripts.set(
    "/cached.pac",
    `function FindProxyForURL() { return "PROXY 127.0.0.1:${proxy.port}"; }`,
  );
  const home = mkdtempSync(join(root, "home-"));
  const env = {
    AIAND_PROXY_PAC: `${pacOrigin}/cached.pac`,
    AIAND_PROXY_USERNAME: USER.username,
    AIAND_PROXY_PASSWORD: USER.password,
  };
  try {
    const first = await runCli(env, undefined, home);
    const hits = pacHits.filter((url) => url === "/cached.pac").length;
    const second = await runCli(env, undefined, home);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(pacHits.filter((url) => url === "/cached.pac").length, hits);
    const cached = readFileSync(join(home, "config", "proxy-discovery.json"), "utf8");
    assert.doesNotMatch(cached, /correct horse|alice/);
  } finally {
    await proxy.close();
  }
});

test("a PAC file that cannot be loaded is reported in plain words, once, and the command goes on", async () => {
  const home = mkdtempSync(join(root, "home-"));
  const env = { AIAND_PROXY_PAC: `http://user:secret@127.0.0.1:${apiPort}/missing.pac?t=1` };
  const first = await runCli(env, undefined, home);
  assert.equal(first.code, 0, first.stderr);
  assert.match(
    first.stderr,
    new RegExp(
      `aiand could not load the proxy configuration file from http://127\\.0\\.0\\.1:${apiPort}/missing\\.pac \\(the server answered \\d+\\), so it connects directly\\.`,
    ),
  );
  assert.doesNotMatch(first.stderr, /secret|t=1/);
  const second = await runCli(env, undefined, home);
  assert.equal(second.stderr, "");
});

test("the relaunch through the bridge keeps the trusted roots the CLI started with", async () => {
  pacScripts.set("/roots.pac", 'function FindProxyForURL() { return "DIRECT"; }');
  const record = join(root, "execargv.txt");
  const preload = join(root, "record-execargv.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";\nif (process.env.AIAND_PROXY_RELAUNCHED === "1") appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.execArgv) + "\\n");\n`,
  );
  const result = await runCli({
    AIAND_PROXY_PAC: `${pacOrigin}/roots.pac`,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
  });
  assert.equal(result.code, 0, result.stderr);
  const execArgv = JSON.parse(readFileSync(record, "utf8").trim().split("\n")[0]);
  assert.ok(!execArgv.includes("--use-system-ca"), JSON.stringify(execArgv));
});
