import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardsInterrupt,
  nodeSupportsEnvProxy,
  PROXY_VARS,
  proxyDebugLine,
  proxyUnsupportedWarning,
  RELAUNCH_MARKER,
  relaunchPlan,
} from "../dist/cli/proxy.js";

const baseOptions = {
  env: {},
  execPath: "/usr/local/bin/node",
  execArgv: [],
  argv: ["/usr/local/bin/node", "/opt/aiand/dist/index.js"],
  version: "v22.21.0",
};

test("no proxy variable means no relaunch", () => {
  assert.deepEqual(PROXY_VARS, ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]);
  assert.equal(RELAUNCH_MARKER, "AIAND_PROXY_RELAUNCHED");
  assert.equal(relaunchPlan(baseOptions), null);
  assert.equal(relaunchPlan({ ...baseOptions, env: { HTTPS_PROXY: "" } }), null);
  assert.equal(proxyUnsupportedWarning({}, "v22.20.0"), null);
});

test("a proxy variable relaunches with NODE_USE_ENV_PROXY, the marker, system CAs and UNDICI-EHPA disabled", () => {
  const env = { HTTPS_PROXY: "http://user:password@proxy.example:8080", PATH: "/usr/bin" };
  const plan = relaunchPlan({
    ...baseOptions,
    env,
    execArgv: ["--no-warnings"],
    argv: ["/usr/local/bin/node", "/opt/aiand/dist/index.js", "models", "--json"],
  });
  assert.deepEqual(plan, {
    cmd: "/usr/local/bin/node",
    args: [
      "--use-system-ca",
      "--disable-warning=UNDICI-EHPA",
      "--no-warnings",
      "/opt/aiand/dist/index.js",
      "models",
      "--json",
    ],
    env: {
      ...env,
      NODE_USE_ENV_PROXY: "1",
      [RELAUNCH_MARKER]: "1",
    },
  });
});

test("an already relaunched process does not relaunch again", () => {
  const env = { HTTPS_PROXY: "http://proxy.example:8080", [RELAUNCH_MARKER]: "1" };
  assert.equal(relaunchPlan({ ...baseOptions, env }), null);
});

test("NODE_USE_ENV_PROXY=1 already set means no relaunch", () => {
  const env = { HTTPS_PROXY: "http://proxy.example:8080", NODE_USE_ENV_PROXY: "1" };
  assert.equal(relaunchPlan({ ...baseOptions, env }), null);
  assert.equal(proxyUnsupportedWarning(env, "v22.20.0"), null);
});

test("Node older than 22.21 does not relaunch and gets a warning without the proxy URL", () => {
  const url = "http://user:password@proxy.example:8080";
  const env = { HTTPS_PROXY: url, https_proxy: "http://other-proxy.example:8080" };
  const version = "v22.20.0";
  assert.equal(relaunchPlan({ ...baseOptions, env, version }), null);
  const warning = proxyUnsupportedWarning(env, version);
  assert.equal(
    warning,
    "A proxy is set (HTTPS_PROXY), but Node v22.20.0 can't send requests through it. Install Node 22.21 or later.",
  );
  assert.equal(warning.includes(url), false);
  assert.equal(warning.includes("password"), false);
  assert.equal(proxyUnsupportedWarning(env, "v22.21.0"), null);

  assert.equal(nodeSupportsEnvProxy("v22.20.9"), false);
  assert.equal(nodeSupportsEnvProxy("v22.21.0"), true);
  assert.equal(nodeSupportsEnvProxy("v22.22.0"), true);
  assert.equal(nodeSupportsEnvProxy("v23.0.0"), true);
  assert.equal(nodeSupportsEnvProxy("v21.9.0"), false);
  assert.equal(nodeSupportsEnvProxy("not-a-version"), false);
});

test("relaunchPlan does not modify the env it was given", () => {
  const env = { HTTPS_PROXY: "http://proxy.example:8080", KEEP: "unchanged" };
  const original = { ...env };
  const plan = relaunchPlan({ ...baseOptions, env });
  assert.deepEqual(env, original);
  assert.notEqual(plan.env, env);
});

test("--use-system-ca and --disable-warning=UNDICI-EHPA are not added twice", () => {
  const cases = [
    {
      execArgv: ["--no-warnings", "--use-system-ca"],
      args: [
        "--disable-warning=UNDICI-EHPA",
        "--no-warnings",
        "--use-system-ca",
        "/opt/aiand/dist/index.js",
      ],
    },
    {
      execArgv: ["--no-warnings", "--disable-warning=UNDICI-EHPA"],
      args: [
        "--use-system-ca",
        "--no-warnings",
        "--disable-warning=UNDICI-EHPA",
        "/opt/aiand/dist/index.js",
      ],
    },
    {
      execArgv: ["--no-warnings", "--use-system-ca", "--disable-warning=UNDICI-EHPA"],
      args: [
        "--no-warnings",
        "--use-system-ca",
        "--disable-warning=UNDICI-EHPA",
        "/opt/aiand/dist/index.js",
      ],
    },
  ];
  for (const { execArgv, args } of cases) {
    const plan = relaunchPlan({
      ...baseOptions,
      env: { http_proxy: "http://proxy.example:8080" },
      execArgv,
    });
    assert.deepEqual(plan.args, args);
    assert.equal(plan.args.filter((arg) => arg === "--use-system-ca").length, 1);
    assert.equal(plan.args.filter((arg) => arg === "--disable-warning=UNDICI-EHPA").length, 1);
  }
});

test("proxyDebugLine is null without AIAND_DEBUG=1", () => {
  assert.equal(proxyDebugLine({ HTTPS_PROXY: "http://proxy.example:8080" }), null);
  assert.equal(proxyDebugLine({ AIAND_DEBUG: "true", HTTP_PROXY: "http://proxy.example" }), null);
});

test("proxyDebugLine is null without a proxy variable", () => {
  assert.equal(proxyDebugLine({ AIAND_DEBUG: "1" }), null);
  assert.equal(proxyDebugLine({ AIAND_DEBUG: "1", HTTPS_PROXY: "" }), null);
});

test("proxyDebugLine reports the proxy name without its URL or credentials", () => {
  const url = "http://user:password@proxy.example:8080";
  const line = proxyDebugLine({ AIAND_DEBUG: "1", HTTPS_PROXY: url });
  assert.equal(line, "Proxy: HTTPS_PROXY; system CAs: on");
  assert.equal(line.includes(url), false);
  assert.equal(line.includes("proxy.example"), false);
  assert.equal(line.includes("user"), false);
  assert.equal(line.includes("password"), false);
});

test("Ctrl-C at a terminal is not passed on again; a signal sent to the parent alone is", () => {
  assert.equal(forwardsInterrupt(true), false);
  assert.equal(forwardsInterrupt(false), true);
});
