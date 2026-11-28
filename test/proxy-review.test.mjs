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
import { bridgeOrWarn } from "../dist/net/system-bridge.js";
import { startAuthProxy } from "./auth-proxy.mjs";

const USER = { username: "alice", password: "correct horse" };
let root;
let api;
let apiPort;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aiand-proxy-review-"));
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
    assert.deepEqual(await plainThrough(bridge, "/upload", "POST", "body"), {
      status: 200,
      text: "POST /upload",
    });
    assert.deepEqual(proxy.plainRequests, [
      `http://127.0.0.1:${apiPort}/hello?x=1`,
      `http://127.0.0.1:${apiPort}/upload`,
    ]);
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
  assert.equal(displayUrl("file:///etc/aiand/secret-store.key"), "a local PAC file");
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
