import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { startBridge } from "../dist/net/forwarder.js";
import { PacScript } from "../dist/net/pac.js";
import {
  basicAuthorization,
  CurlHandshake,
  parseChallenges,
  schemesToTry,
  systemCurl,
} from "../dist/net/proxy-auth.js";
import { loadPac, ProxyResolver } from "../dist/net/resolver.js";
import { SocketReader } from "../dist/net/socket-reader.js";
import { startSystemBridge } from "../dist/net/system-bridge.js";
import { defaultDiscoveryDeps } from "../dist/net/system-proxy.js";
import { discoverWpad } from "../dist/net/wpad.js";

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), "aiand-proxy-edges-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** A connected socket pair: `server` is what the reader reads from. */
async function pair() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = connect(server.address().port, "127.0.0.1");
  const [accepted] = await once(server, "connection");
  server.close();
  return { client, accepted };
}

test("the socket reader skips chunked, sized and unsized bodies and reads keep-alive", async () => {
  const { client, accepted } = await pair();
  const reader = new SocketReader(accepted);
  client.write(
    "HTTP/1.1 407 No\r\nTransfer-Encoding: chunked\r\nProxy-Authenticate: NTLM\r\n\r\n4;x=1\r\nabcd\r\n0\r\nTrailer: t\r\n\r\n",
  );
  const chunked = await reader.head(true);
  assert.equal(chunked.status, 407);
  assert.equal(await reader.skipBody(chunked), true);
  client.write("HTTP/1.0 407 No\r\nContent-Length: 2\r\n\r\nok");
  assert.equal(await reader.skipBody(await reader.head(true)), false);
  client.write("HTTP/1.1 407 No\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  assert.equal(await reader.skipBody(await reader.head(true)), false);
  client.write("HTTP/1.1 502 Bad\r\n\r\nrest");
  const unsized = await reader.head(true);
  assert.equal(await reader.skipBody(unsized), false);
  assert.equal(reader.release().toString(), "rest");
  client.destroy();
  accepted.destroy();
});

test("the socket reader rejects what is not HTTP, an oversized head, a bad length and a bad chunk", async () => {
  const cases = [
    ["SSH-2.0-OpenSSH\r\n\r\n", /did not answer with HTTP/],
    [`HTTP/1.1 200 OK\r\nPadding: ${"a".repeat(70 * 1024)}`, /too large/],
    ["HTTP/1.1 407 x\r\nContent-Length: -1\r\n\r\n", /Bad Content-Length/],
    ["HTTP/1.1 407 x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", /malformed chunked/],
  ];
  for (const [text, expected] of cases) {
    const { client, accepted } = await pair();
    const reader = new SocketReader(accepted);
    client.write(text);
    await assert.rejects(
      reader.head(true).then((head) => reader.skipBody(head)),
      expected,
    );
    client.destroy();
    accepted.destroy();
  }
  const { client, accepted } = await pair();
  const reader = new SocketReader(accepted);
  client.end("HTTP/1.1 200");
  await assert.rejects(reader.head(true), /closed/);
  accepted.destroy();
});

test("challenges: several per header, data kept, schemes chosen by what this machine can answer", () => {
  const head = {
    status: 407,
    line: "",
    headers: [
      ["Proxy-Authenticate", 'Basic realm="corp", NTLM'],
      ["proxy-authenticate", "Negotiate abc=="],
      ["Proxy-Authenticate", "Digest realm=x"],
    ],
  };
  const challenges = parseChallenges(head);
  assert.deepEqual(challenges, [
    { scheme: "Basic", data: 'realm="corp"' },
    { scheme: "NTLM", data: "" },
    { scheme: "Negotiate", data: "abc==" },
    { scheme: "Digest", data: "realm=x" },
  ]);
  const creds = { username: "u", password: "p" };
  assert.deepEqual(schemesToTry(challenges, { platform: "win32", curl: "c", credentials: null }), [
    "Negotiate",
    "NTLM",
  ]);
  assert.deepEqual(schemesToTry(challenges, { platform: "darwin", curl: "c", credentials: null }), [
    "Negotiate",
  ]);
  assert.deepEqual(schemesToTry(challenges, { platform: "linux", curl: "c", credentials: creds }), [
    "Negotiate",
    "NTLM",
    "Basic",
  ]);
  assert.deepEqual(
    schemesToTry(challenges, { platform: "linux", curl: null, credentials: creds }),
    ["Basic"],
  );
  assert.equal(
    basicAuthorization({ username: "CORP\\ä", password: "p:w" }),
    `Basic ${Buffer.from("CORP\\ä:p:w").toString("base64")}`,
  );
});

test("the system curl: System32's on Windows, /usr/bin's elsewhere, or none", () => {
  assert.equal(
    systemCurl(
      "win32",
      { SystemRoot: "C:\\Windows" },
      (p) => p === "C:\\Windows\\System32\\curl.exe",
    ),
    "C:\\Windows\\System32\\curl.exe",
  );
  assert.equal(
    systemCurl("win32", { SystemRoot: "C:\\Windows" }, () => false),
    null,
  );
  assert.equal(
    systemCurl("linux", {}, (p) => p === "/bin/curl"),
    "/bin/curl",
  );
  assert.equal(
    systemCurl("darwin", {}, () => false),
    null,
  );
});

test("a credential with a line break never reaches curl", async () => {
  await assert.rejects(
    CurlHandshake.start({
      curl: process.execPath,
      scheme: "NTLM",
      proxy: { host: "p", port: 1 },
      credentials: { username: "u", password: "a\nproxy = evil" },
    }),
    /line break/,
  );
});

test("a curl that exits at once gives no token", async () => {
  const handshake = await CurlHandshake.start({
    curl: process.execPath,
    scheme: "Negotiate",
    proxy: { host: "[::1]".slice(1, -1), port: 1 },
    credentials: null,
  });
  assert.equal(await handshake.next(null), null);
  assert.equal(await handshake.next("Negotiate abc"), null);
  handshake.close();
});

test("the bridge answers bad requests plainly and reports unreachable routes", async () => {
  const lines = [];
  const bridge = await startBridge({
    routes: async () => [{ kind: "direct" }],
    auth: { platform: process.platform, curl: null, credentials: null },
    log: (line) => lines.push(line),
  });
  const { port, password } = new URL(bridge.url);
  const auth = {
    "proxy-authorization": `Basic ${Buffer.from(`aiand:${password}`).toString("base64")}`,
  };
  const send = async (options) => {
    const req = request({ host: "127.0.0.1", port, ...options });
    req.end();
    const [event] = await Promise.race([once(req, "response"), once(req, "connect")]);
    event.resume?.();
    return event.statusCode;
  };
  try {
    assert.equal(await send({ method: "CONNECT", path: "no-port", headers: auth }), 400);
    assert.equal(await send({ method: "CONNECT", path: "host:0", headers: auth }), 400);
    assert.equal(await send({ path: "/relative", headers: auth }), 400);
    assert.equal(await send({ path: "ftp://x/", headers: auth }), 400);
    assert.equal(await send({ path: "http://127.0.0.1:9/" }), 407);
    const closed = createNetServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const deadPort = closed.address().port;
    closed.close();
    assert.equal(
      await send({ method: "CONNECT", path: `127.0.0.1:${deadPort}`, headers: auth }),
      502,
    );
    assert.equal(await send({ path: `http://127.0.0.1:${deadPort}/`, headers: auth }), 502);
    assert.equal(await send({ method: "CONNECT", path: `[::1]:${deadPort}`, headers: auth }), 502);
    assert.ok(
      bridge.failures().some((line) => line.includes("ECONNREFUSED")),
      bridge.failures().join("\n"),
    );
  } finally {
    await bridge.close();
  }
});

test("a proxy that refuses the CONNECT outright is reported with its status", async () => {
  const refuser = createNetServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  });
  refuser.listen(0, "127.0.0.1");
  await once(refuser, "listening");
  const bridge = await startBridge({
    routes: async () => [{ kind: "proxy", host: "127.0.0.1", port: refuser.address().port }],
    auth: { platform: process.platform, curl: null, credentials: null },
  });
  const { port, password } = new URL(bridge.url);
  try {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: "api.aiand.com:443",
      headers: {
        "proxy-authorization": `Basic ${Buffer.from(`aiand:${password}`).toString("base64")}`,
      },
    });
    req.end();
    const [res] = await once(req, "connect");
    assert.equal(res.statusCode, 502);
    assert.match(bridge.failures().join("\n"), /refused api\.aiand\.com:443 \(HTTP 403\)/);
  } finally {
    refuser.close();
    await bridge.close();
  }
});

/** Serve `text` as a PAC on loopback; resolves its URL and a closer. */
async function servePac(text) {
  const server = createServer((_req, res) => res.end(text));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/proxy.pac`,
    close: () => server.close(),
  };
}

test("a PAC served over http runs with the real lookups, and a file: URL is refused", async () => {
  const pac = await servePac(
    'function FindProxyForURL(u, h) { return dnsResolve("localhost") === "127.0.0.1" && myIpAddress() ? "PROXY 127.0.0.1:3128" : "DIRECT"; }',
  );
  const resolver = new ProxyResolver({ source: "test", autoDetect: false, pacUrl: pac.url });
  try {
    assert.equal(await resolver.prepare(), true);
    assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
      { kind: "proxy", host: "127.0.0.1", port: 3128, trust: "full" },
    ]);
    // The second ask is cached.
    assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/x")), [
      { kind: "proxy", host: "127.0.0.1", port: 3128, trust: "full" },
    ]);
  } finally {
    resolver.close();
    pac.close();
  }
  const file = join(root, "proxy.pac");
  writeFileSync(file, 'function FindProxyForURL() { return "DIRECT"; }');
  await assert.rejects(loadPac(pathToFileURL(file).href), /must be http or https/);
  await assert.rejects(loadPac("not a url"), /not a valid URL/);
  const local = new ProxyResolver({
    source: "test",
    autoDetect: false,
    pacUrl: pathToFileURL(file).href,
  });
  assert.equal(await local.prepare(), false);
  assert.match(
    local.state.pacFailure ?? "",
    /from a local file \(a PAC URL must be http or https\)/,
  );
});

test("a PAC answer that fails falls back to the fixed proxy, or direct", async () => {
  const pac = await servePac("function FindProxyForURL() { throw new Error('x'); }");
  const resolver = new ProxyResolver({ source: "test", autoDetect: false, pacUrl: pac.url });
  try {
    await resolver.prepare();
    assert.deepEqual(await resolver.routes(new URL("https://api.aiand.com/")), [
      { kind: "direct" },
    ]);
    assert.match(resolver.notes.join("\n"), /PAC answer for api\.aiand\.com/);
  } finally {
    resolver.close();
    pac.close();
  }
});

test("a PAC server that answers too slowly or not at all is a load failure", async () => {
  const silent = createServer(() => {});
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  const big = createServer((_req, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(600 * 1024, 32));
    res.end(Buffer.alloc(600 * 1024, 32));
  });
  big.listen(0, "127.0.0.1");
  await once(big, "listening");
  try {
    await assert.rejects(loadPac(`http://127.0.0.1:${big.address().port}/`), /larger than 1 MB/);
    await assert.rejects(
      loadPac(`http://127.0.0.1:${silent.address().port}/`),
      /did not load within 3 seconds/,
    );
  } finally {
    silent.closeAllConnections();
    big.closeAllConnections();
    silent.close();
    big.close();
  }
});

test("WPAD survives a lookup or a load that throws", async () => {
  const found = await discoverWpad(
    {
      dhcp: [],
      domains: ["a.corp.example"],
      resolves: async (host) => {
        if (host === "wpad.a.corp.example") throw new Error("SERVFAIL");
        return true;
      },
    },
    async () => {
      throw new Error("refused");
    },
  );
  assert.equal(found, null);
});

test("a PAC worker that is closed starts again on the next ask", async () => {
  const pac = new PacScript('function FindProxyForURL() { return "DIRECT"; }');
  const host = { resolve: async () => null, myIpAddress: "10.0.0.1", now: Date.now };
  try {
    assert.equal(await pac.find(new URL("https://a.example/"), host), "DIRECT");
    pac.close();
    assert.equal(await pac.find(new URL("https://b.example/"), host), "DIRECT");
  } finally {
    pac.close();
  }
});

test("the default discovery reads no policy file that is not there", async () => {
  for (const platform of ["linux", "darwin"]) {
    const deps = defaultDiscoveryDeps({}, platform);
    assert.equal(deps.readFile(join(root, "missing")), null);
    assert.deepEqual(await deps.policy().catch(() => ({ settings: {}, sources: {} })), {
      settings: {},
      sources: {},
    });
  }
});

test("startSystemBridge: nothing configured, nothing started", async () => {
  assert.equal(
    await startSystemBridge({
      env: { AIAND_SYSTEM_PROXY: "0" },
      platform: process.platform,
      cache: null,
    }),
    null,
  );
});

test("a browser started during a bridged command does not inherit the bridge", async () => {
  const { withoutBridge } = await import("../dist/net/system-bridge.js");
  const env = {
    PATH: "/bin",
    HTTPS_PROXY: "http://aiand:x@127.0.0.1:1",
    http_proxy: "x",
    AIAND_PROXY_BRIDGE: "1",
  };
  assert.deepEqual(withoutBridge(env), { PATH: "/bin" });
  const plain = { HTTPS_PROXY: "http://corp:8080" };
  assert.deepEqual(withoutBridge(plain), plain);
});
