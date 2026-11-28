import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";
import { BIN, cliEnv, FAKE_API_KEY, lf } from "./helpers.mjs";

const CHILD_TIMEOUT_MS = 15_000;
const requestedUrls = [];
const tunnelOrigins = new WeakMap();
const tunnelSockets = new Set();
let root;
let home;
let config;
let proxy;
let proxyUrl;
let api;
let apiUrl;
let apiStatus;

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function runCliProcess(env, { args = ["models", "--json"], execArgv = [] } = {}) {
  const child = spawn(process.execPath, [...execArgv, BIN, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const kill = () => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {
        // The process group has already exited.
      }
    }
    child.kill("SIGKILL");
  };
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, CHILD_TIMEOUT_MS);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(
      timedOut,
      false,
      `${args.join(" ")} did not finish within ${CHILD_TIMEOUT_MS} ms (signal ${signal}); proxy saw ${JSON.stringify(requestedUrls)}\n${stderr}`,
    );
    return { code, stdout: lf(stdout), stderr: lf(stderr) };
  } finally {
    clearTimeout(timer);
    kill();
  }
}

function childEnv(httpProxy) {
  return cliEnv({
    HOME: home,
    USERPROFILE: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: config,
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_BASE_URL: apiUrl,
    AIAND_AUTH_URL: undefined,
    AIAND_ALLOW_KEY_TO: apiUrl,
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    ALL_PROXY: undefined,
    all_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    NODE_USE_ENV_PROXY: undefined,
    AIAND_PROXY_RELAUNCHED: undefined,
  });
}

function keyExportEnv(overrides = {}) {
  return cliEnv({
    ...childEnv(undefined),
    HTTP_PROXY: undefined,
    HTTPS_PROXY: proxyUrl,
    NODE_OPTIONS: undefined,
    AIAND_DEBUG: undefined,
    ...overrides,
  });
}

function forward(req, res, target) {
  requestedUrls.push(target.href);
  const upstream = request(
    target,
    { method: "GET", headers: { ...req.headers, host: target.host } },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("test proxy upstream error");
  });
  req.pipe(upstream);
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "aiand-proxy-relaunch-"));
  home = join(root, "home");
  config = join(root, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });

  proxy = createServer((req, res) => {
    try {
      const target = new URL(req.url);
      if (req.method !== "GET" || target.protocol !== "http:") throw new Error("unsupported");
      forward(req, res, target);
    } catch {
      res.writeHead(400);
      res.end("the test proxy only forwards plain GET requests with absolute URLs");
      req.resume();
    }
  });

  // This Node release tunnels even plain HTTP through CONNECT. Feed the plain
  // GET inside that tunnel through the same forwarder and record its full URL.
  const tunnel = createServer((req, res) => {
    try {
      const origin = tunnelOrigins.get(req.socket);
      if (req.method !== "GET" || origin === undefined) throw new Error("unsupported");
      forward(req, res, new URL(req.url, origin));
    } catch {
      res.writeHead(400);
      res.end("bad tunneled request");
      req.resume();
    }
  });
  proxy.on("connect", (req, socket, head) => {
    tunnelOrigins.set(socket, `http://${req.url}`);
    tunnelSockets.add(socket);
    socket.once("close", () => tunnelSockets.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    tunnel.emit("connection", socket);
  });

  api = createServer((req, res) => {
    res.writeHead(req.url === "/v1/models" ? apiStatus : 404, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        req.url === "/v1/models" && apiStatus === 200 ? { data: [] } : { error: "stub error" },
      ),
    );
    req.resume();
  });

  await Promise.all([listen(proxy), listen(api)]);
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

beforeEach(() => {
  requestedUrls.length = 0;
  apiStatus = 200;
});

after(async () => {
  for (const socket of tunnelSockets) socket.destroy();
  await Promise.all([close(proxy), close(api)]);
  rmSync(root, { recursive: true, force: true });
});

test("with HTTP_PROXY set, the request goes through the proxy", async () => {
  const result = await runCliProcess(childEnv(proxyUrl));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(
    requestedUrls.includes(`${apiUrl}/v1/models`),
    `proxy did not record the models request: ${JSON.stringify(requestedUrls)}`,
  );
});

test("key export is exactly the key behind HTTPS_PROXY", async () => {
  const result = await runCliProcess(keyExportEnv(), { args: ["key", "export"] });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `${FAKE_API_KEY}\n`);
  assert.equal(result.stderr, "");
});

test("AIAND_DEBUG=1 prints one proxy configuration line", async () => {
  const result = await runCliProcess(keyExportEnv({ AIAND_DEBUG: "1" }), {
    args: ["key", "export"],
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `${FAKE_API_KEY}\n`);
  assert.equal(result.stderr, "Proxy: HTTPS_PROXY; system CAs: on\n");
});

test("the relaunch still prints other warnings", async () => {
  const preload = join(root, "emit-test-warning.mjs");
  writeFileSync(preload, 'process.emitWarning("aiand test", { code: "AIAND_TEST_WARNING" });\n');
  const result = await runCliProcess(keyExportEnv(), {
    args: ["key", "export"],
    execArgv: ["--import", pathToFileURL(preload).href],
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.ok(result.stderr.includes("AIAND_TEST_WARNING"), result.stderr);
});

test("without a proxy variable, the proxy sees nothing", async () => {
  const result = await runCliProcess(childEnv(undefined));
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(requestedUrls, []);
});

test("the exit code of the relaunched process is the CLI's exit code", async () => {
  apiStatus = 500;
  const direct = await runCliProcess(childEnv(undefined));
  const proxied = await runCliProcess(childEnv(proxyUrl));
  assert.notEqual(direct.code, 0, direct.stderr || direct.stdout);
  assert.equal(
    proxied.code,
    direct.code,
    `direct: ${JSON.stringify(direct)}\nproxied: ${JSON.stringify(proxied)}`,
  );
});
