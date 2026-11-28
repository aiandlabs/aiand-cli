import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import {
  EXTRA_CA_VAR,
  storeTrustNotes,
  USE_SYSTEM_CA_VAR,
  withStoreTrust,
} from "../dist/agents/ca-trust.js";
import { publicRequest } from "../dist/api/client.js";
import {
  isUntrustedCertificate,
  missingFrom,
  nodeReadsSystemStore,
  storeExpected,
  storeOnlyCertificates,
  trustSystemCertificates,
  UNTRUSTED_CERTIFICATE,
  untrustedCertificateHint,
} from "../dist/cli/system-ca.js";
import { cliEnv, FAKE_API_KEY, runCli, startMockGateway, withTestEnv } from "./helpers.mjs";

// A company that inspects HTTPS re-signs every site with its own root, which
// sits in the OS store only. These tests make a throwaway root and a server
// certificate it signs, serve HTTPS on loopback with it, and show requests
// fail without the root and succeed once the store (as the CLI reads it,
// through tls.getCACertificates("system")) holds it. No real store is touched.

const env = withTestEnv("aiand-system-ca-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "cfg");
  process.env.NO_COLOR = "1";
});

const FAKE_STORE = fileURLToPath(new URL("./fake-system-store.mjs", import.meta.url));
const HAS_OPENSSL = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const needsOpenssl = HAS_OPENSSL ? {} : { skip: "openssl is not on PATH" };

let pki;
function openssl(args, cwd) {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A throwaway root and a 127.0.0.1 server certificate it signs. */
function makePki(dir) {
  mkdirSync(dir, { recursive: true });
  openssl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=aiand test inspection root",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ],
    dir,
  );
  openssl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    ],
    dir,
  );
  writeFileSync(
    join(dir, "server.ext"),
    "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      "server.ext",
      "-out",
      "server.pem",
    ],
    dir,
  );
  return {
    dir,
    caFile: join(dir, "ca.pem"),
    ca: readFileSync(join(dir, "ca.pem"), "utf8"),
    certFile: join(dir, "server.pem"),
    keyFile: join(dir, "server.key"),
  };
}

let server;
let serverUrl;
before(async () => {
  if (!HAS_OPENSSL) return;
  pki = makePki(join(env.dir, "pki"));
  server = createServer(
    { cert: readFileSync(pki.certFile), key: readFileSync(pki.keyFile) },
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `https://127.0.0.1:${server.address().port}/`;
});
after(() => server?.close());

const fakeApi = (system, calls = []) => ({
  getCACertificates: (type) => (type === "system" ? system : ["BUNDLED-A", "BUNDLED-B"]),
  setDefaultCACertificates: (certs) => calls.push(certs),
});

describe("trustSystemCertificates", () => {
  test("adds the store's certificates Node does not already trust, once each", () => {
    const calls = [];
    const outcome = trustSystemCertificates({
      env: {},
      execArgv: [],
      api: fakeApi(["BUNDLED-A", "STORE-1", "STORE-1", " STORE-2\n"], calls),
    });
    assert.deepEqual(outcome, { state: "added", added: 2 });
    assert.deepEqual(calls, [["BUNDLED-A", "BUNDLED-B", "STORE-1", " STORE-2\n"]]);
  });

  test("an empty store changes nothing", () => {
    const calls = [];
    assert.deepEqual(trustSystemCertificates({ env: {}, execArgv: [], api: fakeApi([], calls) }), {
      state: "added",
      added: 0,
    });
    assert.deepEqual(calls, []);
  });

  test("AIAND_SYSTEM_CA=0 keeps Node's own store", () => {
    const calls = [];
    const outcome = trustSystemCertificates({
      env: { AIAND_SYSTEM_CA: "0" },
      execArgv: [],
      api: fakeApi(["STORE-1"], calls),
    });
    assert.deepEqual(outcome, { state: "off" });
    assert.deepEqual(calls, []);
  });

  test("a Node already reading the store is left to it", () => {
    for (const [envVars, execArgv] of [
      [{}, ["--use-system-ca"]],
      [{ NODE_USE_SYSTEM_CA: "1" }, []],
      [{ NODE_OPTIONS: "--max-old-space-size=100 --use-system-ca" }, []],
    ]) {
      assert.equal(nodeReadsSystemStore(envVars, execArgv), true);
      assert.deepEqual(trustSystemCertificates({ env: envVars, execArgv, api: fakeApi(["S"]) }), {
        state: "node",
      });
    }
    assert.equal(nodeReadsSystemStore({ NODE_USE_SYSTEM_CA: "0" }, []), false);
  });

  test("a Node without the store API is reported, not crashed on", () => {
    assert.deepEqual(trustSystemCertificates({ env: {}, execArgv: [], api: {} }), {
      state: "unsupported",
    });
    assert.deepEqual(storeOnlyCertificates({ env: {}, api: {} }), []);
  });

  test("an unreadable store keeps Node's own roots", () => {
    const api = {
      getCACertificates: (type) => {
        if (type === "system") throw new Error("keychain locked");
        return ["BUNDLED-A"];
      },
      setDefaultCACertificates: () => assert.fail("must not replace the store"),
    };
    assert.deepEqual(trustSystemCertificates({ env: {}, execArgv: [], api }), {
      state: "failed",
      reason: "keychain locked",
    });
    assert.deepEqual(storeOnlyCertificates({ env: {}, api }), []);
  });

  test("a Linux machine with no certificate directory is not read", () => {
    const none = () => false;
    assert.equal(storeExpected({}, "linux", none), false);
    assert.equal(storeExpected({ SSL_CERT_FILE: "/etc/company.pem" }, "linux", none), true);
    assert.equal(
      storeExpected({}, "linux", (path) => path === "/etc/ssl/certs"),
      true,
    );
    assert.equal(
      storeExpected({ SSL_CERT_DIR: "/opt/certs" }, "linux", (path) => path === "/opt/certs"),
      true,
    );
    assert.equal(storeExpected({}, "darwin", none), true);
    assert.equal(storeExpected({}, "win32", none), true);
  });

  test("missingFrom ignores whitespace differences", () => {
    assert.deepEqual(missingFrom(["A\nB"], ["AB", "C", "C\n"]), ["C"]);
  });

  test("storeOnlyCertificates is the store minus the bundled roots", () => {
    assert.deepEqual(storeOnlyCertificates({ env: {}, api: fakeApi(["BUNDLED-B", "COMPANY"]) }), [
      "COMPANY",
    ]);
    assert.deepEqual(
      storeOnlyCertificates({ env: { AIAND_SYSTEM_CA: "0" }, api: fakeApi(["COMPANY"]) }),
      [],
    );
  });
});

describe("untrusted certificates are named in plain words", () => {
  test("only chain-of-trust codes count", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      }),
    });
    assert.equal(isUntrustedCertificate(wrapped), true);
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    assert.equal(isUntrustedCertificate(refused), false);
    const expired = { code: "CERT_HAS_EXPIRED" };
    assert.equal(isUntrustedCertificate(expired), false);
    assert.equal(isUntrustedCertificate(undefined), false);
  });

  test("the hint says what to do for each way the store was (not) read", () => {
    assert.match(untrustedCertificateHint({ state: "off" }), /AIAND_SYSTEM_CA=0 is set/);
    assert.match(untrustedCertificateHint({ state: "unsupported" }), /Node\.js 22\.21 or later/);
    assert.match(
      untrustedCertificateHint({ state: "failed", reason: "x" }),
      /could not read that store \(x\)/,
    );
    const read = untrustedCertificateHint({ state: "added", added: 0 });
    assert.match(read, /does not hold the root/);
    for (const hint of [read, untrustedCertificateHint({ state: "node" })]) {
      assert.match(hint, /NODE_EXTRA_CA_CERTS/);
      assert.match(hint, /it-admin-certificates\.md/);
    }
  });
});

describe("a request through an inspecting network", needsOpenssl, () => {
  test("fails on the unknown root, then succeeds once the store holds it", async () => {
    await assert.rejects(publicRequest(serverUrl), (error) => {
      assert.equal(error.type, UNTRUSTED_CERTIFICATE);
      assert.match(error.message, /certificate is not trusted on this computer/);
      assert.match(error.hint, /certificate store/);
      return true;
    });

    const outcome = trustSystemCertificates({
      env: {},
      execArgv: [],
      api: {
        getCACertificates: (type) =>
          type === "system"
            ? [...tls.getCACertificates("system"), pki.ca]
            : tls.getCACertificates(type),
        setDefaultCACertificates: tls.setDefaultCACertificates,
      },
    });
    assert.equal(outcome.state, "added");
    assert.ok(outcome.added >= 1);

    const response = await publicRequest(serverUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

describe("the CLI trusts the store with no flag and no variable", needsOpenssl, () => {
  let gateway;
  let storeFile;
  before(async () => {
    gateway = await startMockGateway({ args: ["--cert", pki.certFile, "--key", pki.keyFile] });
    storeFile = join(env.dir, "store.pem");
    writeFileSync(storeFile, pki.ca);
  });
  after(() => gateway?.stop());

  const cli = (args, overrides = {}) =>
    runCli(args, {
      env: cliEnv({
        AIAND_BASE_URL: `${gateway.url}/stub/vision-catalog`,
        AIAND_API_KEY: "",
        NODE_EXTRA_CA_CERTS: undefined,
        NODE_USE_SYSTEM_CA: undefined,
        ...overrides,
      }),
    });
  const withStore = (extra = {}) => ({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(FAKE_STORE)}`.trim(),
    AIAND_TEST_SYSTEM_STORE: storeFile,
    ...extra,
  });

  test("models works when the root is only in the store", async () => {
    const r = await cli(["models"], withStore());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /vision/i);
  });

  test("without the root, models says the certificate is not trusted", async () => {
    const r = await cli(["models"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /certificate is not trusted on this computer/);
    assert.match(r.stderr, /certificate store/);
  });

  test("AIAND_SYSTEM_CA=0 turns the store off and says so", async () => {
    const r = await cli(["models"], withStore({ AIAND_SYSTEM_CA: "0" }));
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /AIAND_SYSTEM_CA=0 is set/);
  });

  test("status reports an untrusted certificate, not a bare outage", async () => {
    const r = await cli(["status"], { AIAND_API_KEY: FAKE_API_KEY });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Gateway unreachable/);
    assert.match(r.stderr, /certificate is not trusted on this computer/);
    assert.doesNotMatch(r.stderr, /Check your network and retry/);

    const json = await cli(["status", "--json"], { AIAND_API_KEY: FAKE_API_KEY });
    const auth = JSON.parse(json.stdout).auth;
    assert.equal(auth.reachable, false);
    assert.match(auth.reason, /certificate is not trusted/);
  });

  // Linux is the one platform where the real store can be pointed somewhere
  // else without installing anything: Node reads it through OpenSSL, which
  // takes SSL_CERT_FILE / SSL_CERT_DIR.
  test(
    "on Linux, the real system store path works",
    process.platform === "linux"
      ? {}
      : { skip: "SSL_CERT_FILE moves the system store on Linux only" },
    async () => {
      const emptyDir = join(env.dir, "empty-cert-dir");
      mkdirSync(emptyDir, { recursive: true });
      const r = await cli(["models"], { SSL_CERT_FILE: storeFile, SSL_CERT_DIR: emptyDir });
      assert.equal(r.code, 0, r.stderr);
    },
  );
});

describe("agents and npm get the store too", () => {
  const bundlePath = () => join(env.dir, "cfg", "system-ca.pem");

  test("a child gets NODE_USE_SYSTEM_CA and the store's extra roots", async () => {
    const next = await withStoreTrust(
      { PATH: "/bin" },
      {
        certs: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"],
        bundlePath: bundlePath(),
      },
    );
    assert.equal(next[USE_SYSTEM_CA_VAR], "1");
    assert.equal(next[EXTRA_CA_VAR], bundlePath());
    assert.equal(
      readFileSync(bundlePath(), "utf8"),
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    );
  });

  test("nothing extra in the store means no bundle file", async () => {
    const path = join(env.dir, "never.pem");
    const next = await withStoreTrust({}, { certs: [], bundlePath: path });
    assert.equal(next[USE_SYSTEM_CA_VAR], "1");
    assert.equal(next[EXTRA_CA_VAR], undefined);
    assert.equal(existsSync(path), false);
  });

  test("values the caller set are kept, in any case on Windows", async () => {
    const mine = await withStoreTrust(
      { NODE_USE_SYSTEM_CA: "0", NODE_EXTRA_CA_CERTS: "/etc/company.pem" },
      { certs: ["C"], bundlePath: bundlePath(), platform: "linux" },
    );
    assert.equal(mine[USE_SYSTEM_CA_VAR], "0");
    assert.equal(mine[EXTRA_CA_VAR], "/etc/company.pem");
    const win = await withStoreTrust(
      { node_extra_ca_certs: "C:\\company.pem", Node_Use_System_CA: "1" },
      { certs: ["C"], bundlePath: bundlePath(), platform: "win32" },
    );
    assert.equal(win[EXTRA_CA_VAR], undefined);
    assert.equal(win[USE_SYSTEM_CA_VAR], undefined);
  });

  test("AIAND_SYSTEM_CA=0 passes the environment through untouched", async () => {
    const base = { AIAND_SYSTEM_CA: "0" };
    assert.equal(await withStoreTrust(base, { certs: ["C"], bundlePath: bundlePath() }), base);
  });

  test(
    "a Node agent started with that environment reaches the inspected server",
    needsOpenssl,
    async () => {
      const probe = `fetch(${JSON.stringify(serverUrl)}).then(r => r.text()).then(t => { console.log(t); }, e => { console.log(e.cause?.code); process.exitCode = 1; })`;
      const run = (childEnv) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["-e", probe], { env: childEnv });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("close", (code) => resolve({ code, out: out.trim() }));
        });
      const base = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT };
      const without = await run(base);
      assert.equal(without.code, 1);
      assert.equal(without.out, "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
      const agentEnv = await withStoreTrust(base, { certs: [pki.ca], bundlePath: bundlePath() });
      const withTrust = await run(agentEnv);
      assert.equal(withTrust.code, 0, withTrust.out);
      assert.equal(withTrust.out, '{"ok":true}');
    },
  );

  test("on names the setting for agents that do not read the store themselves", () => {
    const pi = { id: "pi", label: "Pi", bin: "pi" };
    const [note] = storeTrustNotes(pi, { env: {}, certs: ["COMPANY"] });
    assert.match(note, /Pi does not read this computer's certificate store/);
    assert.match(note, /NODE_USE_SYSTEM_CA=1/);
    assert.match(note, /`aiand pi`/);
    assert.deepEqual(storeTrustNotes(pi, { env: {}, certs: [] }), []);
    assert.deepEqual(storeTrustNotes(pi, { env: { NODE_USE_SYSTEM_CA: "1" }, certs: ["C"] }), []);
    assert.deepEqual(storeTrustNotes(pi, { env: { AIAND_SYSTEM_CA: "0" }, certs: ["C"] }), []);
    for (const id of ["claude", "codex", "opencode", "copilot", "copilot-app", "hermes"]) {
      assert.deepEqual(storeTrustNotes({ id, label: id, bin: id }, { env: {}, certs: ["C"] }), []);
    }
  });
});

test("both installers' release helpers read the store and name an untrusted root", () => {
  for (const file of ["../install.sh", "../install.ps1"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /tls\.getCACertificates\("system"\)/, file);
    assert.match(text, /tls\.setDefaultCACertificates\(\[\.\.\.current, \.\.\.added\]\)/, file);
    assert.match(text, /its certificate is not trusted on this computer/, file);
  }
});
