import assert from "node:assert/strict";
import test from "node:test";
import { PacError, PacScript, pacUrl, parseEndpoint, parsePacResult } from "../dist/net/pac.js";

const NOW = Date.UTC(2026, 0, 5, 10, 30, 0); // a Monday, 10:30 UTC

function host(overrides = {}) {
  const lookups = [];
  return {
    lookups,
    resolve: async (name) => {
      lookups.push(name);
      return (
        { "intranet.corp.example": "10.1.2.3", "proxy.corp.example": "10.0.0.8" }[name] ?? null
      );
    },
    myIpAddress: "192.168.10.20",
    now: () => NOW,
    ...overrides,
  };
}

async function answer(source, url = "https://api.aiand.com/v1/models", pacHost = host()) {
  const pac = new PacScript(source);
  try {
    return await pac.find(new URL(url), pacHost);
  } finally {
    pac.close();
  }
}

test("a PAC sees the origin of an https URL and the bare host", async () => {
  const result = await answer('function FindProxyForURL(url, host) { return url + " " + host; }');
  assert.equal(result, "https://api.aiand.com/ api.aiand.com");
  assert.equal(pacUrl(new URL("http://example.test/a?b=1")), "http://example.test/a?b=1");
});

test("the standard PAC functions behave as browsers define them", async () => {
  const checks = [
    'isPlainHostName("intranet")',
    '!isPlainHostName("intranet.corp")',
    'dnsDomainIs("www.corp.example", ".corp.example")',
    '!dnsDomainIs("www.other.example", ".corp.example")',
    'localHostOrDomainIs("www", "www.corp.example")',
    'localHostOrDomainIs("www.corp.example", "www.corp.example")',
    'dnsDomainLevels("a.b.c") === 2',
    'shExpMatch("api.example.com", "*.example.com")',
    '!shExpMatch("api.example.com", "*.example")',
    'shExpMatch("http://a/b?c", "http://?/b*")',
    'isInNet("10.1.2.3", "10.0.0.0", "255.0.0.0")',
    '!isInNet("11.1.2.3", "10.0.0.0", "255.0.0.0")',
    'isInNet("intranet.corp.example", "10.0.0.0", "255.0.0.0")',
    'isInNetEx("10.1.2.3", "10.0.0.0/8")',
    'dnsResolve("intranet.corp.example") === "10.1.2.3"',
    'dnsResolve("nowhere.example") === null',
    'dnsResolveEx("nowhere.example") === ""',
    'isResolvable("proxy.corp.example")',
    '!isResolvable("nowhere.example")',
    'myIpAddress() === "192.168.10.20"',
    'myIpAddressEx() === "192.168.10.20"',
    'convert_addr("10.0.0.1") === 167772161',
    'weekdayRange("MON", "FRI", "GMT")',
    '!weekdayRange("SAT", "SUN", "GMT")',
    'weekdayRange("FRI", "MON", "GMT")',
    'dateRange("JAN", "GMT")',
    'dateRange(5, "GMT")',
    'dateRange(2026, "GMT")',
    'dateRange("DEC", "FEB", "GMT")',
    'timeRange(9, 17, "GMT")',
    '!timeRange(11, 12, "GMT")',
    'timeRange(10, 0, 11, 0, "GMT")',
    'typeof alert === "function"',
  ];
  const source = `function FindProxyForURL() {
    var failed = [];
    var checks = [${checks.map((c) => `function () { return ${c}; }`).join(",")}];
    var names = ${JSON.stringify(checks)};
    for (var i = 0; i < checks.length; i++) if (!checks[i]()) failed.push(names[i]);
    return failed.join(" | ");
  }`;
  assert.equal(await answer(source), "");
});

test("lookups are resolved outside the PAC and it runs again with the answers", async () => {
  const pacHost = host();
  const source = `function FindProxyForURL(url, h) {
    if (isInNet(dnsResolve("intranet.corp.example"), "10.0.0.0", "255.0.0.0")) {
      return isResolvable("nowhere.example") ? "DIRECT" : "PROXY proxy.corp.example:8080; DIRECT";
    }
    return "DIRECT";
  }`;
  assert.equal(await answer(source, undefined, pacHost), "PROXY proxy.corp.example:8080; DIRECT");
  assert.deepEqual(pacHost.lookups, ["intranet.corp.example", "nowhere.example"]);
});

test("a lookup the PAC catches still gets its answer", async () => {
  const source = `function FindProxyForURL() {
    var ip;
    try { ip = dnsResolve("intranet.corp.example"); } catch (e) { ip = "none"; }
    return "PROXY " + ip + ":3128";
  }`;
  assert.equal(await answer(source), "PROXY 10.1.2.3:3128");
});

test("FindProxyForURLEx wins when a PAC defines both", async () => {
  const source = `function FindProxyForURL() { return "PROXY old:1"; }
    function FindProxyForURLEx() { return "PROXY new:2"; }`;
  assert.equal(await answer(source), "PROXY new:2");
});

test("a PAC reaches nothing of Node's", async () => {
  const probes = {
    "host Function": 'this.constructor.constructor("return process")()',
    eval: 'eval("1")',
    Function: 'Function("return 1")()',
    "process global": "typeof process === 'undefined' ? null : process",
    "require global": "typeof require === 'undefined' ? null : require",
    timers: "typeof setTimeout === 'undefined' ? null : setTimeout",
    WebAssembly: "typeof WebAssembly === 'undefined' ? null : WebAssembly",
    "shared memory": "typeof SharedArrayBuffer === 'undefined' ? null : SharedArrayBuffer",
  };
  for (const [name, expression] of Object.entries(probes)) {
    const source = `function FindProxyForURL() {
      try { var v = ${expression}; return v === null || v === undefined ? "BLOCKED" : "REACHED " + typeof v; }
      catch (e) { return "BLOCKED"; }
    }`;
    assert.equal(await answer(source), "BLOCKED", name);
  }
});

test("a PAC cannot load modules", async () => {
  const source = `var loaded = "PENDING";
    import("node:fs").then(function () { loaded = "REACHED"; }, function () { loaded = "BLOCKED"; });
    function FindProxyForURL() { return loaded; }`;
  assert.equal(await answer(source), "BLOCKED");
});

test("a PAC that loops, throws or exhausts memory fails without harming the CLI", async () => {
  for (const source of [
    "function FindProxyForURL() { for (;;) {} }",
    "function FindProxyForURL() { throw new Error('no'); }",
    "function FindProxyForURL() { return { toString: function () { for (;;) {} } }; }",
    "function FindProxyForURL() { Promise.resolve().then(function () { for (;;) {} }); return 'DIRECT'; }",
    "var junk = []; function FindProxyForURL() { for (;;) junk.push(new Array(1e6).fill(1)); }",
  ]) {
    await assert.rejects(answer(source), PacError, source);
  }
});

test("a PAC that leaves a rejected promise behind still answers", async () => {
  const source = "function FindProxyForURL() { Promise.reject(new Error('x')); return 'DIRECT'; }";
  assert.equal(await answer(source), "DIRECT");
});

test("a PAC with a syntax error is refused up front", () => {
  assert.throws(() => new PacScript("function FindProxyForURL( {"), PacError);
});

test("a PAC that keeps asking for new hosts is cut off", async () => {
  const source = `var n = 0; function FindProxyForURL() {
    for (var i = 0; i < 100; i++) dnsResolve("h" + i + ".example");
    return "DIRECT";
  }`;
  await assert.rejects(answer(source), /more than 16 host names/);
});

test("a PAC answer becomes routes in order, skipping what aiand cannot use", () => {
  assert.deepEqual(parsePacResult("PROXY a.corp:8080; PROXY [fd00::1]:3128; DIRECT"), [
    { kind: "proxy", host: "a.corp", port: 8080 },
    { kind: "proxy", host: "fd00::1", port: 3128 },
    { kind: "direct" },
  ]);
  assert.deepEqual(parsePacResult("SOCKS5 s:1080; HTTPS h:443; HTTP p"), [
    { kind: "proxy", host: "p", port: 80 },
  ]);
  assert.deepEqual(parsePacResult(""), [{ kind: "direct" }]);
  assert.throws(() => parsePacResult("SOCKS s:1080"), PacError);
  assert.throws(() => parsePacResult("x".repeat(5000)), PacError);
});

test("proxy endpoints parse the way Windows and PAC write them", () => {
  assert.deepEqual(parseEndpoint("proxy:8080", 80), { host: "proxy", port: 8080 });
  assert.deepEqual(parseEndpoint("http://proxy/", 80), { host: "proxy", port: 80 });
  assert.deepEqual(parseEndpoint("[::1]:3128", 80), { host: "::1", port: 3128 });
  assert.equal(parseEndpoint("https://proxy:443", 80), null);
  assert.equal(parseEndpoint("user@proxy:1", 80), null);
  assert.equal(parseEndpoint("proxy:0", 80), null);
  assert.equal(parseEndpoint("", 80), null);
});
