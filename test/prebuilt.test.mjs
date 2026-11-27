import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { buildPrebuilt, seaConfiguration } from "../scripts/build-prebuilt.mjs";
import { cliEnv, FAKE_API_KEY } from "./helpers.mjs";

const CHILD_TIMEOUT_MS = 30_000;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const requestedUrls = [];
const tunnelOrigins = new WeakMap();
const tunnelSockets = new Set();
let root;
let outputDir;
let artifact;
let home;
let config;
let emptyPath;
let proxy;
let proxyUrl;
let api;
let apiUrl;

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

function artifactEnv(overrides = {}) {
  return cliEnv({
    HOME: home,
    USERPROFILE: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: config,
    AIAND_API_KEY: FAKE_API_KEY,
    AIAND_BASE_URL: apiUrl,
    AIAND_AUTH_URL: undefined,
    PATH: emptyPath,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    ALL_PROXY: undefined,
    all_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    NODE_OPTIONS: undefined,
    NODE_USE_ENV_PROXY: undefined,
    AIAND_PROXY_RELAUNCHED: undefined,
    ...overrides,
  });
}

function runArtifact(args, env = artifactEnv()) {
  const child = spawn(artifact, args, {
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
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      kill();
      assert.equal(
        timedOut,
        false,
        `artifact did not finish within ${CHILD_TIMEOUT_MS} ms (signal ${signal}); proxy saw ${JSON.stringify(requestedUrls)}\n${stderr}`,
      );
      resolve({ code, stdout, stderr });
    });
  });
}

function forward(req, res, target) {
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  requestedUrls.push(target.href);
  const upstream = request(
    "http://127.0.0.1",
    {
      method: "GET",
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host },
    },
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
  root = mkdtempSync(join(tmpdir(), "aiand-prebuilt-"));
  outputDir = join(root, "artifact");
  home = join(root, "home");
  config = join(root, "config");
  emptyPath = join(root, "empty-path");
  for (const dir of [home, config, emptyPath]) mkdirSync(dir, { recursive: true });

  proxy = createServer((req, res) => {
    try {
      const target = new URL(req.url);
      if (req.method !== "GET" || target.protocol !== "http:") throw new Error("unsupported");
      forward(req, res, target);
    } catch {
      res.writeHead(400);
      res.end("the test proxy only forwards loopback plain GET requests with absolute URLs");
      req.resume();
    }
  });

  // Copied from proxy-relaunch: this Node release tunnels even plain HTTP
  // through CONNECT. Feed the plain GET through the same loopback forwarder.
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
    res.writeHead(req.url === "/v1/models" ? 200 : 404, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: [] } : { error: "stub error" }));
    req.resume();
  });

  await Promise.all([listen(proxy), listen(api)]);
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  apiUrl = `http://127.0.0.1:${api.address().port}`;
  artifact = await buildPrebuilt(outputDir);
});

beforeEach(() => {
  requestedUrls.length = 0;
});

after(async () => {
  for (const socket of tunnelSockets) socket.destroy();
  await Promise.all([close(proxy), close(api)]);
  rmSync(root, { recursive: true, force: true });
});

test("seaConfiguration bakes proxy and system CA startup flags without NODE_OPTIONS", () => {
  const main = join(root, "main.cjs");
  const output = join(root, "sea.blob");
  const embeddedPackage = join(root, "package.json");
  assert.deepEqual(seaConfiguration(main, output, embeddedPackage), {
    main,
    output,
    assets: { "package.json": embeddedPackage },
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgv: ["--use-env-proxy", "--use-system-ca"],
    execArgvExtension: "none",
  });
});

test("buildPrebuilt emits one relocated executable for --version and --help", async () => {
  assert.deepEqual(readdirSync(outputDir), [basename(artifact)]);
  const version = await runArtifact(["--version"]);
  assert.equal(version.code, 0, version.stderr || version.stdout);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runArtifact(["--help"]);
  assert.equal(help.code, 0, help.stderr || help.stdout);
  assert.equal(help.stderr.includes("ExperimentalWarning"), false, help.stderr);
  assert.equal(help.stderr.includes("single executable"), false, help.stderr);
});

test("the prebuilt executable uses HTTP_PROXY without Node on PATH or proxy startup environment", async () => {
  const env = artifactEnv({ HTTP_PROXY: proxyUrl });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_USE_ENV_PROXY, undefined);
  assert.equal(env.AIAND_PROXY_RELAUNCHED, undefined);
  assert.equal(env.PATH, emptyPath);

  const result = await runArtifact(["models", "--json"], env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.ok(
    requestedUrls.includes(`${apiUrl}/v1/models`),
    `proxy did not record the models request: ${JSON.stringify(requestedUrls)}`,
  );
});
