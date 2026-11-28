import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { DISCOVERY_TTL_MS, DiscoveryCache, discoveryKey } from "../dist/net/discovery-cache.js";
import { startBridge } from "../dist/net/forwarder.js";
import { PacError, PacScript } from "../dist/net/pac.js";
import { curlEnv, systemCurl } from "../dist/net/proxy-auth.js";
import { displayUrl, localAddressFor } from "../dist/net/resolver.js";
import { SocketReader } from "../dist/net/socket-reader.js";
import { bridgeOrWarn } from "../dist/net/system-bridge.js";
import { startAuthProxy } from "./auth-proxy.mjs";
import { writeConfigMarker } from "./helpers.mjs";

const USER = { username: "alice", password: "correct horse" };
let root;
let api;
let apiPort;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aiand-proxy-review-"));
  // The discovery cache is written only into a config dir aiand made.
  writeConfigMarker(root);
  api = createServer((req, res) => {
    if (req.url === "/chunked") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("one,");
      setTimeout(() => res.end("two"), 5);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`${req.method} ${req.url}`);
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  apiPort = api.address().port;
});

after(async () => {
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function bridgeAuth(url) {
  const { password } = new URL(url);
  return `Basic ${Buffer.from(`aiand:${password}`).toString("base64")}`;
}

async function connectThrough(bridge) {
  const { port } = new URL(bridge.url);
  const req = request({
    host: "127.0.0.1",
    port,
    method: "CONNECT",
    path: `127.0.0.1:${apiPort}`,
    headers: { "proxy-authorization": bridgeAuth(bridge.url) },
  });
  req.end();
  const [res, socket] = await once(req, "connect");
  socket.destroy();
  return res.statusCode;
}

async function plainThrough(bridge, path = "/hello?x=1", method = "GET", body) {
  const { port } = new URL(bridge.url);
  const req = request({
    host: "127.0.0.1",
    port,
    method,
    path: `http://127.0.0.1:${apiPort}${path}`,
    headers: { "proxy-authorization": bridgeAuth(bridge.url) },
  });
  req.end(body);
  const [res] = await once(req, "response");
  let text = "";
  for await (const chunk of res) text += chunk;
  return { status: res.statusCode, text };
}

test("the proxy's user name and password go only to a proxy the user or an administrator named", async () => {
  for (const trust of ["intranet", "none"]) {
    const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
    const bridge = await startBridge({
      routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port, trust }],
      auth: { platform: process.platform, curl: null, credentials: USER },
    });
    try {
      assert.equal(await connectThrough(bridge), 502, trust);
      assert.deepEqual(proxy.signIns, []);
      assert.ok(proxy.requests.every((line) => !line.includes("Basic")));
    } finally {
      await Promise.all([bridge.close(), proxy.close()]);
    }
  }
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port, trust: "full" }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.equal(await connectThrough(bridge), 200);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

/** A curl that only records that it ran, and with what environment. */
function plantRecordingCurl() {
  const dir = mkdtempSync(join(root, "curl-"));
  const path = join(dir, "curl");
  const record = join(dir, "env.json");
  writeFileSync(
    path,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(Object.keys(process.env)));\n`,
  );
  chmodSync(path, 0o755);
  return { path, record };
}

test("a proxy named by an automatically found PAC outside the domain gets no sign-in at all", {
  skip: process.platform === "win32" ? "the stand-in curl is a script" : false,
}, async () => {
  const curl = plantRecordingCurl();
  const proxy = await startAuthProxy({ schemes: ["Negotiate", "NTLM"] });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port, trust: "none" }],
    auth: { platform: "win32", curl: curl.path, credentials: null },
  });
  try {
    assert.equal(await connectThrough(bridge), 502);
    assert.throws(() => readFileSync(curl.record), /ENOENT/);
    assert.match(bridge.failures().join("\n"), /automatically found PAC file/);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("curl starts with only what sign-in needs: no key, no proxy password, no proxy variable", {
  skip: process.platform === "win32" ? "the stand-in curl is a script" : false,
}, async () => {
  assert.deepEqual(
    Object.keys(
      curlEnv({
        PATH: "/bin",
        HOME: "/h",
        KRB5CCNAME: "FILE:/tmp/k",
        AIAND_API_KEY: "sk-test-xxxxxxxxxxxxxxxxxxxx",
        AIAND_PROXY_PASSWORD: "pw",
        AIAND_SECRET_STORE_MASTER_KEY: "k",
        HTTPS_PROXY: "http://x",
        CURL_HOME: "/evil",
        SystemRoot: "C:\\Windows",
      }),
    ).sort(),
    ["HOME", "KRB5CCNAME", "PATH", "SystemRoot"],
  );
  const curl = plantRecordingCurl();
  const proxy = await startAuthProxy({ schemes: ["Negotiate"] });
  const saved = { ...process.env };
  process.env.AIAND_PROXY_PASSWORD = "pw";
  process.env.AIAND_API_KEY = "sk-test-xxxxxxxxxxxxxxxxxxxx";
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: curl.path, credentials: null },
  });
  try {
    await connectThrough(bridge);
    const names = JSON.parse(readFileSync(curl.record, "utf8"));
    assert.ok(
      names.every((name) => !/^AIAND_|_PROXY$|^NODE_OPTIONS$/i.test(name)),
      names.join(","),
    );
  } finally {
    process.env = saved;
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("a proxy that took a sign-in once gets it up front on the next tunnel", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.equal(await connectThrough(bridge), 200);
    assert.equal(await connectThrough(bridge), 200);
    assert.equal(await connectThrough(bridge), 200);
    assert.equal(proxy.challenges, 1);
    assert.deepEqual(proxy.signIns, ["Basic", "Basic", "Basic"]);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

const curl = systemCurl();
const curlNtlm =
  curl !== null &&
  /\bNTLM\b/.test(
    (() => {
      try {
        return execFileSync(curl, ["-V"], { encoding: "utf8" });
      } catch {
        return "";
      }
    })(),
  );

test("many tunnels at once through an NTLM proxy all get through", {
  skip: curlNtlm ? false : "no system curl with NTLM",
}, async () => {
  const proxy = await startAuthProxy({ schemes: ["NTLM"], ...USER });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl, credentials: USER },
  });
  try {
    const statuses = await Promise.all(Array.from({ length: 8 }, () => connectThrough(bridge)));
    assert.deepEqual(statuses, Array(8).fill(200));
    assert.equal(proxy.signIns.length, 8);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("plain http goes to the proxy as an ordinary request, not a CONNECT to port 80", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.deepEqual(await plainThrough(bridge), { status: 200, text: "GET /hello?x=1" });
    // A body could carry anything, so it never goes to a proxy in the clear.
    assert.equal((await plainThrough(bridge, "/upload", "POST", "body")).status, 502);
    assert.deepEqual(proxy.plainRequests, [`http://127.0.0.1:${apiPort}/hello?x=1`]);
    assert.ok(proxy.requests.every((line) => !line.startsWith("CONNECT")));
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("plain http through an NTLM proxy signs in on the request itself", {
  skip: curlNtlm ? false : "no system curl with NTLM",
}, async () => {
  const proxy = await startAuthProxy({ schemes: ["NTLM"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl, credentials: USER },
  });
  try {
    assert.deepEqual(await plainThrough(bridge), { status: 200, text: "GET /hello?x=1" });
    assert.deepEqual(proxy.signIns, ["NTLM"]);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("plain http straight to the origin when the route is direct", async () => {
  const bridge = await startBridge({
    routes: async () => [{ kind: "direct" }],
    auth: { platform: process.platform, curl: null, credentials: null },
  });
  try {
    assert.deepEqual(await plainThrough(bridge, "/d"), { status: 200, text: "GET /d" });
  } finally {
    await bridge.close();
  }
});

test("printed PAC URLs carry no user name, password or query; a PAC's syntax error quotes nothing", () => {
  assert.equal(
    displayUrl("https://user:secret@pac.corp.example/p.pac?token=abc#x"),
    "https://pac.corp.example/p.pac",
  );
  assert.equal(displayUrl("file:///etc/aiand/secret-store.key"), "a local file");
  assert.equal(displayUrl("::"), "an invalid URL");
  assert.throws(
    () => new PacScript("sk-test-livekeyvalue1234567890 is not javascript"),
    (error) =>
      error instanceof PacError &&
      !error.message.includes("sk-") &&
      !error.message.includes("livekey"),
  );
});

test("myIpAddress is the address on the route to the PAC server", async () => {
  assert.equal(await localAddressFor("127.0.0.1"), "127.0.0.1");
  assert.equal(typeof (await localAddressFor(null)), "string");
  assert.equal(typeof (await localAddressFor("not an ip")), "string");
});

test("the discovery cache: fresh, keyed, expiring, and tolerant of a damaged file", async () => {
  const path = join(root, "proxy-discovery.json");
  let now = 1_000_000;
  const cache = new DiscoveryCache(path, () => now);
  const value = {
    config: { source: "test", autoDetect: false, pacUrl: "http://pac/p.pac" },
    state: {
      pacUrl: "http://pac/p.pac",
      pacSource: "function FindProxyForURL(){return 'DIRECT'}",
      fromWpad: false,
      myIp: "10.0.0.2",
      pacFailure: "x",
    },
  };
  await cache.write("k1", value);
  assert.deepEqual(await cache.read("k1"), {
    config: value.config,
    state: { ...value.state, pacFailure: null },
  });
  assert.equal(await cache.read("k2"), undefined);
  now += DISCOVERY_TTL_MS + 1;
  assert.equal(await cache.read("k1"), undefined);
  await cache.write("k1", { config: null, state: null });
  assert.deepEqual(await cache.read("k1"), { config: null, state: null });
  writeFileSync(path, "{not json");
  assert.equal(await cache.read("k1"), undefined);
  writeFileSync(path, JSON.stringify({ key: "k1", at: now, config: { source: 1 }, state: null }));
  assert.equal(await cache.read("k1"), undefined);
  assert.doesNotMatch(readFileSync(path, "utf8"), /pw|password/i);
  assert.notEqual(discoveryKey({}, "linux"), discoveryKey({ AIAND_PROXY_PAC: "auto" }, "linux"));
  assert.notEqual(discoveryKey({}, "linux"), discoveryKey({}, "win32"));
  assert.equal(discoveryKey({}, "linux"), discoveryKey({}, "linux"));
});

test("a failure starting the bridge is one plain line, and the command goes on without it", async () => {
  const lines = [];
  assert.equal(
    await bridgeOrWarn(
      async () => {
        throw new Error("listen EADDRINUSE");
      },
      (line) => lines.push(line),
    ),
    false,
  );
  assert.deepEqual(lines, [
    "aiand could not use the proxy from your system settings (listen EADDRINUSE); continuing without it.",
  ]);
  assert.equal(
    await bridgeOrWarn(
      async () => true,
      () => {},
    ),
    true,
  );
});

test("chunked and bodiless answers to plain http pass through whole", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.deepEqual(await plainThrough(bridge, "/chunked"), { status: 200, text: "one,two" });
    assert.deepEqual(await plainThrough(bridge, "/h", "HEAD"), { status: 200, text: "" });
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("an https PAC is fetched with certificate checks on, and a plain http server fails them", async () => {
  const { loadPac } = await import("../dist/net/resolver.js");
  await assert.rejects(loadPac(`https://127.0.0.1:${apiPort}/p.pac`));
});

test("the current addresses come from the machine's interfaces", async () => {
  const { defaultDiscoveryDeps } = await import("../dist/net/system-proxy.js");
  const addresses = defaultDiscoveryDeps({}, "linux").addresses();
  assert.ok(Array.isArray(addresses));
  assert.ok(addresses.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)));
});

test("a proxy that stops taking the remembered sign-in is asked afresh, then reported", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, acceptAtMost: 1 });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.equal(await connectThrough(bridge), 200);
    assert.equal(await connectThrough(bridge), 502);
    assert.match(bridge.failures().join("\n"), /tried Basic/);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

/** A stand-in curl that speaks `script` (a function body over a socket to aiand's SOCKS port). */
function plantCurl(body) {
  const dir = mkdtempSync(join(root, "curl-"));
  const path = join(dir, "curl");
  writeFileSync(
    path,
    `#!${process.execPath}
const net = require("node:net");
const args = process.argv.slice(2);
const socks = new URL(args[args.indexOf("--preproxy") + 1]);
const s = net.connect(Number(socks.port), socks.hostname, () => { ${body} });
s.on("error", () => process.exit(0));
s.on("close", () => process.exit(0));
process.stdin.resume();
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("curl that does not speak SOCKS, names another host, or answers in another scheme gives no token", {
  skip: process.platform === "win32" ? "the stand-in curl is a script" : false,
}, async () => {
  const { CurlHandshake } = await import("../dist/net/proxy-auth.js");
  const cases = [
    's.write("GET / HTTP/1.1\\r\\n\\r\\n");',
    `s.write(Buffer.from([5, 1, 0]));
       s.once("data", () => { const h = Buffer.from("evil.example"); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0, 80])])); });`,
    `s.write(Buffer.from([5, 1, 0]));
       let n = 0;
       s.on("data", () => { n += 1;
         if (n === 1) { const h = Buffer.from("proxy.example"); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0, 80])])); }
         if (n === 2) s.write("GET http://x/ HTTP/1.1\\r\\nProxy-Authorization: Basic eDp5\\r\\n\\r\\n");
       });`,
  ];
  for (const body of cases) {
    const handshake = await CurlHandshake.start({
      curl: plantCurl(body),
      scheme: "Negotiate",
      proxy: { host: "proxy.example", port: 80 },
      credentials: null,
    });
    assert.equal(await handshake.next(null), null, body);
    handshake.close();
  }
});

test("a second command's bridge comes from the cached discovery, logged as such", async () => {
  const pac = createServer((_req, res) =>
    res.end('function FindProxyForURL() { return "PROXY 127.0.0.1:1"; }'),
  );
  pac.listen(0, "127.0.0.1");
  await once(pac, "listening");
  const env = { AIAND_PROXY_PAC: `http://127.0.0.1:${pac.address().port}/p.pac` };
  const cache = new DiscoveryCache(join(root, "bridge-cache.json"));
  const discovery = {
    platform: "linux",
    env,
    run: async () => ({ code: 1, stdout: "" }),
    readFile: () => null,
    exists: () => false,
    policy: async () => ({ settings: {}, sources: {} }),
    addresses: () => [],
  };
  const { startSystemBridge } = await import("../dist/net/system-bridge.js");
  try {
    const lines = [];
    const first = await startSystemBridge({
      env,
      platform: "linux",
      discovery,
      cache,
      curl: null,
      log: (l) => lines.push(l),
    });
    assert.ok(first);
    await first.close();
    const second = await startSystemBridge({
      env,
      platform: "linux",
      discovery,
      cache,
      curl: null,
      log: (l) => lines.push(l),
    });
    assert.ok(second);
    assert.match(second.describe, /PAC http:\/\/127\.0\.0\.1:\d+\/p\.pac/);
    await second.close();
    assert.ok(
      lines.includes("using the proxy settings read in the last few minutes"),
      lines.join("\n"),
    );
  } finally {
    pac.close();
  }
});

test("plain http: an oversized body, an unreachable origin, and an answer that ends with the connection", async () => {
  const { createServer: createNetServer } = await import("node:net");
  const raw = createNetServer((socket) => {
    socket.once("data", () =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nuntil close"),
    );
  });
  raw.listen(0, "127.0.0.1");
  await once(raw, "listening");
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async (url) =>
      url.port === "9"
        ? [{ kind: "direct" }]
        : [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  const { port } = new URL(bridge.url);
  const send = async (path, body) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: body ? "POST" : "GET",
      path,
      headers: { "proxy-authorization": bridgeAuth(bridge.url) },
    });
    req.on("error", () => {});
    req.end(body);
    const [res] = await once(req, "response");
    let text = "";
    for await (const chunk of res) text += chunk;
    return { status: res.statusCode, text };
  };
  try {
    assert.deepEqual(await send(`http://127.0.0.1:${raw.address().port}/r`), {
      status: 200,
      text: "until close",
    });
    assert.equal((await send("http://127.0.0.1:9/dead")).status, 502);
    assert.equal(
      (await send(`http://127.0.0.1:${apiPort}/big`, Buffer.alloc(8 * 1024 * 1024 + 1))).status,
      413,
    );
  } finally {
    raw.close();
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("the socket reader reports a socket error to whoever is waiting", async () => {
  const { createServer: createNetServer, connect } = await import("node:net");
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = connect(server.address().port, "127.0.0.1");
  const [accepted] = await once(server, "connection");
  server.close();
  const reader = new SocketReader(accepted);
  const waiting = reader.head(true);
  accepted.destroy(new Error("reset by peer"));
  await assert.rejects(waiting, /reset by peer/);
  client.destroy();
});

test("curl's SOCKS request may name the proxy by IPv4 or IPv6 address", {
  skip: process.platform === "win32" ? "the stand-in curl is a script" : false,
}, async () => {
  const { CurlHandshake } = await import("../dist/net/proxy-auth.js");
  for (const address of [
    "Buffer.from([1, 10, 0, 0, 9])",
    "Buffer.concat([Buffer.from([4]), Buffer.alloc(15), Buffer.from([1])])",
  ]) {
    const body = `s.write(Buffer.from([5, 1, 0]));
        let n = 0;
        s.on("data", () => { n += 1;
          if (n === 1) s.write(Buffer.concat([Buffer.from([5, 1, 0]), ${address}, Buffer.from([0, 80])]));
          if (n === 2) s.write("GET http://x/ HTTP/1.1\\r\\nProxy-Authorization: Negotiate abc\\r\\n\\r\\n");
        });`;
    const handshake = await CurlHandshake.start({
      curl: plantCurl(body),
      scheme: "Negotiate",
      proxy: { host: "10.0.0.9", port: 80 },
      credentials: null,
    });
    assert.equal(await handshake.next(null), "Negotiate abc");
    handshake.close();
  }
});

test("an unusable config folder only turns the discovery cache off", async () => {
  const file = join(root, "not-a-dir");
  writeFileSync(file, "");
  const saved = process.env.AIAND_CONFIG_DIR;
  process.env.AIAND_CONFIG_DIR = file;
  const { startSystemBridge } = await import("../dist/net/system-bridge.js");
  try {
    const env = { AIAND_PROXY_PAC: "http://127.0.0.1:9/p.pac" };
    const result = await startSystemBridge({
      env,
      platform: "linux",
      curl: null,
      discovery: {
        platform: "linux",
        env,
        run: async () => ({ code: 1, stdout: "" }),
        readFile: () => null,
        exists: () => false,
        policy: async () => ({ settings: {}, sources: {} }),
        addresses: () => [],
      },
    });
    assert.equal(result, null);
  } finally {
    if (saved === undefined) delete process.env.AIAND_CONFIG_DIR;
    else process.env.AIAND_CONFIG_DIR = saved;
  }
});

test("NO_PROXY wins over the PAC and the fixed proxy, read as Node and curl read it", async () => {
  const { matchesNoProxy } = await import("../dist/net/proxy-config.js");
  const { ProxyResolver } = await import("../dist/net/resolver.js");
  const list = "internal.example, .corp.example *.lab.example 10.0.0.0/8 api.aiand.com:8443 [::1]";
  for (const [host, port, expected] of [
    ["internal.example", 443, true],
    ["svc.internal.example", 443, true],
    ["notinternal.example", 443, false],
    ["corp.example", 443, true],
    ["a.corp.example", 443, true],
    ["x.lab.example", 443, true],
    ["10.2.3.4", 443, true],
    ["11.2.3.4", 443, false],
    ["api.aiand.com", 443, false],
    ["api.aiand.com", 8443, true],
    ["::1", 443, true],
  ]) {
    assert.equal(matchesNoProxy(host, port, list), expected, `${host}:${port}`);
  }
  assert.equal(matchesNoProxy("anything.example", 443, "*"), true);
  assert.equal(matchesNoProxy("anything.example", 443, ""), false);
  const fixed = { https: { host: "proxy", port: 8080 }, bypass: [], bypassPlain: false };
  const resolver = new ProxyResolver({ source: "test", autoDetect: false, fixed }, undefined, {
    no_proxy: "internal.example",
  });
  assert.deepEqual(await resolver.routes(new URL("https://svc.internal.example/")), [
    { kind: "direct" },
  ]);
  assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
    { kind: "proxy", host: "proxy", port: 8080 },
  ]);
});

test("a CONNECT or plain http target carrying userinfo is refused", async () => {
  const bridge = await startBridge({
    routes: async () => [{ kind: "direct" }],
    auth: { platform: process.platform, curl: null, credentials: null },
  });
  const { port } = new URL(bridge.url);
  const send = async (options) => {
    const req = request({
      host: "127.0.0.1",
      port,
      headers: { "proxy-authorization": bridgeAuth(bridge.url) },
      ...options,
    });
    req.end();
    const [event] = await Promise.race([once(req, "response"), once(req, "connect")]);
    event.resume?.();
    return event.statusCode;
  };
  try {
    for (const path of [
      `evil.example@127.0.0.1:${apiPort}`,
      `127.0.0.1%2f:${apiPort}`,
      `a/b:${apiPort}`,
      `[not:v6:x]:${apiPort}`,
    ]) {
      assert.equal(await send({ method: "CONNECT", path }), 400, path);
    }
    assert.equal(await send({ path: `http://evil.example@127.0.0.1:${apiPort}/` }), 400);
    assert.equal(await send({ method: "CONNECT", path: `127.0.0.1:${apiPort}` }), 200);
  } finally {
    await bridge.close();
  }
});

test("the discovery cache never proves a config dir, and is written only into one aiand made", async () => {
  const { mayMarkConfigDir, CONFIG_FILES, UNPROVING_CACHE_FILES } = await import(
    "../dist/config-files.js"
  );
  assert.equal(CONFIG_FILES.has("proxy-discovery.json"), false);
  assert.equal(UNPROVING_CACHE_FILES.has("proxy-discovery.json"), true);
  const { mkdirSync } = await import("node:fs");
  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "proxy-discovery.json"), "{}");
  assert.equal(await mayMarkConfigDir(foreign), false);
  writeFileSync(join(foreign, "model-catalog.json"), "{}");
  assert.equal(await mayMarkConfigDir(foreign), true);

  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  const cache = new DiscoveryCache(join(fresh, "proxy-discovery.json"));
  await cache.write("k", { config: null, state: null });
  assert.equal(await cache.read("k"), undefined);
  writeFileSync(join(fresh, ".aiand-config"), "id\n");
  await cache.write("k", { config: null, state: null });
  assert.deepEqual(await cache.read("k"), { config: null, state: null });
  const missing = new DiscoveryCache(join(root, "no-such-dir", "proxy-discovery.json"));
  await missing.write("k", { config: null, state: null });
  assert.throws(() => readFileSync(join(root, "no-such-dir", "proxy-discovery.json")), /ENOENT/);
});

test("no PAC can send loopback through a proxy", async () => {
  const { ProxyResolver } = await import("../dist/net/resolver.js");
  const { isLoopback } = await import("../dist/net/proxy-config.js");
  const resolver = new ProxyResolver(
    { source: "test", autoDetect: false, pacUrl: "http://pac.example/p.pac" },
    {
      loadPac: async () => 'function FindProxyForURL() { return "PROXY evil.example:8080"; }',
      resolve: async () => null,
      localAddress: async () => "10.0.0.1",
      now: Date.now,
    },
  );
  try {
    await resolver.prepare();
    for (const url of [
      "http://127.0.0.1:9999/callback",
      "http://localhost:1/",
      "https://[::1]:2/",
      "http://app.localhost/",
      "http://127.8.9.10/",
    ]) {
      assert.deepEqual(await resolver.routes(new URL(url)), [{ kind: "direct" }], url);
    }
    assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
      { kind: "proxy", host: "evil.example", port: 8080, trust: "full" },
    ]);
  } finally {
    resolver.close();
  }
  assert.equal(isLoopback("[::ffff:127.0.0.1]"), true);
  assert.equal(isLoopback("localhost."), true);
  assert.equal(isLoopback("notlocalhost"), false);
});

test("the unspecified address is not loopback, so a PAC still decides it", async () => {
  const { isLoopback } = await import("../dist/net/proxy-config.js");
  for (const host of ["0.0.0.0", "::", "[::]"]) assert.equal(isLoopback(host), false, host);
});

test("the discovery cache is not written into a config dir inside a git work tree", async () => {
  const { mkdirSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(root, "dotfiles-"));
  writeConfigMarker(dir);
  mkdirSync(join(dir, ".git"));
  const cache = new DiscoveryCache(join(dir, "proxy-discovery.json"));
  await cache.write("k", { config: null, state: null });
  assert.equal(existsSync(join(dir, "proxy-discovery.json")), false);
});

test("an https PAC on Linux trusts only the root-owned distribution bundle, never SSL_CERT_FILE or SSL_CERT_DIR", async () => {
  const { linuxDistributionRoots, LINUX_CA_BUNDLES, pacTrustRoots } = await import(
    "../dist/net/resolver.js"
  );
  const pem = (n) => `-----BEGIN CERTIFICATE-----\nMII${n}\n-----END CERTIFICATE-----`;
  const files = {
    [LINUX_CA_BUNDLES[0]]: { uid: 1000, mode: 0o100644, isFile: true, text: pem("user") },
    [LINUX_CA_BUNDLES[1]]: { uid: 0, mode: 0o100666, isFile: true, text: pem("writable") },
    [LINUX_CA_BUNDLES[2]]: { uid: 0, mode: 0o120777, isFile: false, text: pem("link") },
    [LINUX_CA_BUNDLES[3]]: {
      uid: 0,
      mode: 0o100644,
      isFile: true,
      text: `${pem("a")}\n${pem("b")}`,
    },
  };
  assert.deepEqual(
    linuxDistributionRoots((path) => files[path] ?? null),
    [`${pem("a")}\n`, `${pem("b")}\n`],
  );
  assert.deepEqual(
    linuxDistributionRoots(() => null),
    [],
  );
  // Whatever the platform, the result always includes Node's own roots.
  const { getCACertificates } = await import("node:tls");
  const roots = pacTrustRoots("linux");
  for (const cert of getCACertificates("default")) assert.ok(roots.includes(cert));
});

test("a discovery cache planted where aiand would not write one is ignored", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const value = { config: null, state: null };
  // Inside a git work tree.
  const repo = mkdtempSync(join(root, "repo-"));
  writeConfigMarker(repo);
  writeFileSync(
    join(repo, "proxy-discovery.json"),
    JSON.stringify({ key: "k", at: Date.now(), ...value }),
  );
  mkdirSync(join(repo, ".git"));
  assert.equal(await new DiscoveryCache(join(repo, "proxy-discovery.json")).read("k"), undefined);
  // In a dir aiand did not make.
  const foreign = mkdtempSync(join(root, "foreign-"));
  writeFileSync(
    join(foreign, "proxy-discovery.json"),
    JSON.stringify({ key: "k", at: Date.now(), ...value }),
  );
  assert.equal(
    await new DiscoveryCache(join(foreign, "proxy-discovery.json")).read("k"),
    undefined,
  );
  // As a link to a file elsewhere.
  if (process.platform !== "win32") {
    const linked = mkdtempSync(join(root, "linked-"));
    writeConfigMarker(linked);
    symlinkSync(join(foreign, "proxy-discovery.json"), join(linked, "proxy-discovery.json"));
    assert.equal(
      await new DiscoveryCache(join(linked, "proxy-discovery.json")).read("k"),
      undefined,
    );
  }
});

test("a browser never inherits the proxy user name or password, bridged or not", async () => {
  const { withoutBridge } = await import("../dist/net/system-bridge.js");
  const creds = { AIAND_PROXY_USERNAME: "corp\\alice", AIAND_PROXY_PASSWORD: "pw" };
  assert.deepEqual(withoutBridge({ PATH: "/bin", ...creds }), { PATH: "/bin" });
  assert.deepEqual(
    withoutBridge({ PATH: "/bin", HTTPS_PROXY: "http://corp:8080", aiand_proxy_password: "pw" }),
    { PATH: "/bin", HTTPS_PROXY: "http://corp:8080" },
  );
});

test("the discovery cache replaces a link at its path instead of writing through it", {
  skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false,
}, async () => {
  const { symlinkSync, lstatSync } = await import("node:fs");
  const dir = mkdtempSync(join(root, "cfg-"));
  writeConfigMarker(dir);
  const victim = join(root, `victim-${Date.now()}.txt`);
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(dir, "proxy-discovery.json"));
  const cache = new DiscoveryCache(join(dir, "proxy-discovery.json"));
  await cache.write("k", { config: null, state: null });
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.equal(lstatSync(join(dir, "proxy-discovery.json")).isFile(), true);
  assert.deepEqual(await cache.read("k"), { config: null, state: null });
});

test("IPv6 loopback in any spelling is loopback; NO_PROXY's port entries cover only that port", async () => {
  const { isLoopback, fixedRoute, matchesNoProxy } = await import("../dist/net/proxy-config.js");
  for (const host of [
    "::1",
    "[0:0:0:0:0:0:0:1]",
    "0000:0000::0001",
    "::ffff:127.0.0.1",
    "[::ffff:7f00:2]",
  ]) {
    assert.equal(isLoopback(host), true, host);
  }
  for (const host of ["::2", "::ffff:10.0.0.1", "fe80::1", "not:an:ip"]) {
    assert.equal(isLoopback(host), false, host);
  }
  const fixed = { http: { host: "proxy.corp", port: 8080 }, bypass: [], bypassPlain: false };
  const env = { NO_PROXY: "example.com:8080" };
  assert.deepEqual(fixedRoute(new URL("http://example.com/"), fixed, env), [
    { kind: "proxy", host: "proxy.corp", port: 8080 },
  ]);
  assert.deepEqual(fixedRoute(new URL("http://example.com:8080/"), fixed, env), [
    { kind: "direct" },
  ]);
  assert.equal(matchesNoProxy("example.com", undefined, "example.com:8080"), false);
});

test("plain http carrying credentials is not sent through a proxy; without them it is", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  const { port } = new URL(bridge.url);
  const send = async (headers) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: `http://127.0.0.1:${apiPort}/models`,
      headers: { "proxy-authorization": bridgeAuth(bridge.url), ...headers },
    });
    req.end();
    const [res] = await once(req, "response");
    res.resume();
    return res.statusCode;
  };
  try {
    assert.equal(await send({ authorization: "Bearer sk-test-aaaaaaaaaaaaaaaa" }), 502);
    assert.equal(await send({ cookie: "session=1" }), 502);
    assert.equal(await send({ "x-api-key": "anything" }), 502);
    assert.equal(await send({ "x-custom": "sk-test-bbbbbbbbbbbbbbbb" }), 502);
    assert.deepEqual(proxy.plainRequests, []);
    assert.match(bridge.failures().join("\n"), /could carry credentials/);
    assert.doesNotMatch(bridge.failures().join("\n"), /sk-test/);
    assert.equal(await send({}), 200);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("the bridge relaunch drops the proxy user name and password in any spelling", async () => {
  const { bridgeRelaunchPlan } = await import("../dist/cli/proxy.js");
  const plan = bridgeRelaunchPlan({
    env: { PATH: "/bin", aiand_proxy_password: "pw", Aiand_Proxy_Username: "u" },
    execPath: "/usr/bin/node",
    execArgv: [],
    argv: ["/usr/bin/node", "/opt/aiand/dist/index.js", "models"],
    sea: false,
    platform: "darwin",
    bridgeUrl: "http://aiand:pw@127.0.0.1:1",
    bridgeMarker: "AIAND_PROXY_BRIDGE",
    dropVars: ["AIAND_PROXY_USERNAME", "AIAND_PROXY_PASSWORD"],
  });
  assert.equal(plan.env.aiand_proxy_password, undefined);
  assert.equal(plan.env.Aiand_Proxy_Username, undefined);
  assert.equal(plan.env.PATH, "/bin");
});

test("a plain http query that carries a token is not sent through a proxy", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  try {
    assert.equal((await plainThrough(bridge, "/s?token=abc")).status, 502);
    assert.equal((await plainThrough(bridge, "/s?q=sk-test-cccccccccccccccc")).status, 502);
    assert.deepEqual(proxy.plainRequests, []);
    assert.equal((await plainThrough(bridge, "/s?page=2")).status, 200);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("NO_PROXY entries for an IPv6 address and port match any spelling of that address", async () => {
  const { matchesNoProxy } = await import("../dist/net/proxy-config.js");
  assert.equal(matchesNoProxy("[fd00::1]", 8080, "[fd00::1]:8080"), true);
  assert.equal(matchesNoProxy("fd00:0:0:0:0:0:0:1", 8080, "[fd00::1]:8080"), true);
  assert.equal(matchesNoProxy("fd00::1", 80, "[fd00::1]:8080"), false);
  assert.equal(matchesNoProxy("fd00::1", 443, "fd00::1"), true);
  assert.equal(matchesNoProxy("fd00::2", 443, "fd00::1"), false);
  assert.equal(matchesNoProxy("example.com", 8080, "example.com:8080"), true);
});

test("only a plain fetch goes through a proxy over http: no extra header, body or token-like path", async () => {
  const proxy = await startAuthProxy({ schemes: ["Basic"], ...USER, refuseConnectTo80: true });
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: proxy.port }],
    auth: { platform: process.platform, curl: null, credentials: USER },
  });
  const { port } = new URL(bridge.url);
  const send = async (path, headers = {}) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: `http://127.0.0.1:${apiPort}${path}`,
      headers: { "proxy-authorization": bridgeAuth(bridge.url), ...headers },
    });
    req.end();
    const [res] = await once(req, "response");
    res.resume();
    return res.statusCode;
  };
  const hex64 = "a1b2c3d4".repeat(8);
  try {
    assert.equal(await send("/ok", { "x-foo": hex64 }), 502);
    assert.equal(await send(`/files/${hex64}`), 502);
    assert.equal(await send(`/q?x=${hex64}`), 502);
    assert.equal(await send("/ok", { referer: "http://elsewhere/" }), 502);
    assert.deepEqual(proxy.plainRequests, []);
    assert.equal(
      await send("/ok", { accept: "text/plain", "user-agent": "agent/1", range: "bytes=0-1" }),
      200,
    );
    assert.equal(await send("/list?page=2&sort=name"), 200);
  } finally {
    await Promise.all([bridge.close(), proxy.close()]);
  }
});

test("a fixed proxy is never cached: it is read from settings each time", async () => {
  const dir = mkdtempSync(join(root, "fixed-"));
  writeConfigMarker(dir);
  const cache = new DiscoveryCache(join(dir, "proxy-discovery.json"));
  const fixed = { http: { host: "proxy.corp", port: 8080 }, bypass: [], bypassPlain: false };
  await cache.write("k", { config: { source: "test", autoDetect: false, fixed }, state: null });
  assert.equal(await cache.read("k"), undefined);
  writeFileSync(
    join(dir, "proxy-discovery.json"),
    JSON.stringify({
      key: "k",
      at: Date.now(),
      config: { source: "x", autoDetect: false, fixed },
      state: null,
    }),
  );
  assert.equal(await cache.read("k"), undefined);
});
