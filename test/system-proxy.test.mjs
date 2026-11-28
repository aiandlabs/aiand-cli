import assert from "node:assert/strict";
import test from "node:test";
import { bypassesFixedProxy, fixedRoute, parseProxyServer } from "../dist/net/proxy-config.js";
import {
  discoverProxyConfig,
  gnomeProxySettings,
  resolvConfDomains,
} from "../dist/net/system-proxy.js";
import {
  macosProxySettings,
  macosSearchDomains,
  parseScutil,
} from "../dist/net/system-proxy-macos.js";
import {
  parseConnectionSettings,
  parseRegQuery,
  windowsDhcpWpadUrls,
  windowsInternetSettings,
  windowsWinHttpSettings,
  windowsWpadDomains,
} from "../dist/net/system-proxy-windows.js";
import { discoverWpad, wpadHosts } from "../dist/net/wpad.js";

// --- Fixtures, shaped like the real tools' output ---------------------------

/** DefaultConnectionSettings / WinHttpSettings as reg.exe prints REG_BINARY. */
function connectionBlob({ flags, proxy = "", bypass = "", pac = "", version = 0x46 }) {
  const parts = [Buffer.alloc(12)];
  parts[0].writeUInt32LE(version, 0);
  parts[0].writeUInt32LE(7, 4);
  parts[0].writeUInt32LE(flags, 8);
  for (const text of [proxy, bypass, pac]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(text.length);
    parts.push(length, Buffer.from(text, "latin1"));
  }
  parts.push(Buffer.alloc(32));
  return Buffer.concat(parts).toString("hex").toUpperCase();
}

const IS = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const POLICY_IS = "SOFTWARE\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function regKey(path, values) {
  const lines = values.map(([name, type, data]) => `    ${name}    ${type}    ${data}`);
  return `\r\n${path}\r\n${lines.join("\r\n")}\r\n`;
}

const USER_PAC_AND_PROXY = [
  regKey(`HKEY_CURRENT_USER\\${IS}`, [
    ["CertificateRevocation", "REG_DWORD", "0x1"],
    ["ProxyEnable", "REG_DWORD", "0x1"],
    [
      "ProxyServer",
      "REG_SZ",
      "http=proxy.corp.example:8080;https=proxy.corp.example:8443;socks=s:1080",
    ],
    ["ProxyOverride", "REG_SZ", "*.corp.example;10.*;<local>"],
    ["AutoConfigURL", "REG_SZ", "http://pac.corp.example/proxy.pac"],
  ]),
  regKey(`HKEY_CURRENT_USER\\${IS}\\Connections`, [
    [
      "DefaultConnectionSettings",
      "REG_BINARY",
      connectionBlob({
        flags: 0x0f,
        proxy: "http=proxy.corp.example:8080;https=proxy.corp.example:8443;socks=s:1080",
        bypass: "*.corp.example;10.*;<local>",
        pac: "http://pac.corp.example/proxy.pac",
      }),
    ],
    ["SavedLegacySettings", "REG_BINARY", connectionBlob({ flags: 1 })],
  ]),
].join("");

test("reg.exe output parses into keys and values, names with spaces included", () => {
  const keys = parseRegQuery(
    regKey("HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters", [
      ["NV Domain", "REG_SZ", "corp.example"],
      ["SearchList", "REG_SZ", "eng.corp.example,corp.example"],
      ["Empty", "REG_SZ", ""],
    ]),
  );
  const values = keys.get("hklm\\system\\currentcontrolset\\services\\tcpip\\parameters");
  assert.deepEqual(values?.get("nv domain"), { type: "REG_SZ", data: "corp.example" });
  assert.deepEqual(values?.get("empty"), { type: "REG_SZ", data: "" });
});

test("the connection settings blob gives flags, proxy, bypass and PAC URL", () => {
  const blob = connectionBlob({
    flags: 0x0d,
    proxy: "p:1",
    bypass: "<local>",
    pac: "http://x/p.pac",
  });
  assert.deepEqual(parseConnectionSettings(blob), {
    flags: 0x0d,
    proxy: "p:1",
    bypass: "<local>",
    pacUrl: "http://x/p.pac",
  });
  assert.equal(parseConnectionSettings("4600"), null);
  assert.equal(parseConnectionSettings("zz"), null);
  // A length that runs past the end is a damaged value, not a proxy.
  assert.equal(
    parseConnectionSettings(`${connectionBlob({ flags: 3 }).slice(0, 24)}FFFF0000`),
    null,
  );
  // The WinHTTP default (direct access, no strings at all).
  assert.deepEqual(parseConnectionSettings("180000000000000001000000"), {
    flags: 1,
    proxy: "",
    bypass: "",
    pacUrl: "",
  });
});

test("Windows per-user settings: WPAD, the PAC URL and the fixed proxy with its exceptions", () => {
  const config = windowsInternetSettings(parseRegQuery(USER_PAC_AND_PROXY));
  assert.deepEqual(config, {
    source: "Windows proxy settings",
    autoDetect: true,
    pacUrl: "http://pac.corp.example/proxy.pac",
    fixed: {
      http: { host: "proxy.corp.example", port: 8080 },
      https: { host: "proxy.corp.example", port: 8443 },
      bypass: ["*.corp.example", "10.*"],
      bypassPlain: true,
    },
  });
});

test("Windows Group Policy wins over the user's own values", () => {
  const output =
    USER_PAC_AND_PROXY +
    regKey(`HKEY_CURRENT_USER\\${POLICY_IS}`, [
      ["AutoConfigURL", "REG_SZ", "http://gpo.corp.example/wpad.dat"],
      ["ProxyServer", "REG_SZ", "gpo-proxy.corp.example:3128"],
    ]);
  const config = windowsInternetSettings(parseRegQuery(output));
  assert.equal(config?.pacUrl, "http://gpo.corp.example/wpad.dat");
  assert.deepEqual(config?.fixed?.https, { host: "gpo-proxy.corp.example", port: 3128 });
});

test("Windows machine-wide settings apply when ProxySettingsPerUser is 0", () => {
  const output = [
    USER_PAC_AND_PROXY,
    regKey(`HKEY_LOCAL_MACHINE\\${POLICY_IS}`, [["ProxySettingsPerUser", "REG_DWORD", "0x0"]]),
    regKey(`HKEY_LOCAL_MACHINE\\${IS}\\Connections`, [
      [
        "DefaultConnectionSettings",
        "REG_BINARY",
        connectionBlob({ flags: 0x05, pac: "http://machine/p.pac" }),
      ],
    ]),
  ].join("");
  assert.deepEqual(windowsInternetSettings(parseRegQuery(output)), {
    source: "Windows machine proxy settings",
    autoDetect: false,
    pacUrl: "http://machine/p.pac",
  });
});

test("Windows with only 'Automatically detect settings' (the default) asks for WPAD", () => {
  const output = regKey(`HKEY_CURRENT_USER\\${IS}\\Connections`, [
    ["DefaultConnectionSettings", "REG_BINARY", connectionBlob({ flags: 0x09 })],
  ]);
  assert.deepEqual(windowsInternetSettings(parseRegQuery(output)), {
    source: "Windows proxy settings",
    autoDetect: true,
  });
});

test("Windows direct access, and a proxy switched off, give no settings", () => {
  const direct = regKey(`HKEY_CURRENT_USER\\${IS}\\Connections`, [
    ["DefaultConnectionSettings", "REG_BINARY", connectionBlob({ flags: 0x01, proxy: "p:1" })],
  ]);
  assert.equal(windowsInternetSettings(parseRegQuery(direct)), null);
  const off = regKey(`HKEY_CURRENT_USER\\${IS}`, [
    ["ProxyEnable", "REG_DWORD", "0x0"],
    ["ProxyServer", "REG_SZ", "p:1"],
  ]);
  assert.equal(windowsInternetSettings(parseRegQuery(off)), null);
  assert.equal(windowsInternetSettings(parseRegQuery("")), null);
});

test("the WinHTTP proxy (netsh winhttp set proxy) is read from its blob", () => {
  const output = regKey(`HKEY_LOCAL_MACHINE\\${IS}\\Connections`, [
    [
      "WinHttpSettings",
      "REG_BINARY",
      connectionBlob({
        version: 0x18,
        flags: 3,
        proxy: "winhttp.corp.example:8080",
        bypass: "<local>",
      }),
    ],
  ]);
  assert.deepEqual(windowsWinHttpSettings(parseRegQuery(output)), {
    source: "Windows WinHTTP proxy",
    autoDetect: false,
    fixed: {
      http: { host: "winhttp.corp.example", port: 8080 },
      https: { host: "winhttp.corp.example", port: 8080 },
      bypass: [],
      bypassPlain: true,
    },
  });
  const direct = regKey(`HKEY_LOCAL_MACHINE\\${IS}\\Connections`, [
    ["WinHttpSettings", "REG_BINARY", "1800000000000000010000000000000000000000"],
  ]);
  assert.equal(windowsWinHttpSettings(parseRegQuery(direct)), null);
});

test("Windows WPAD sources: DNS suffixes and DHCP option 252", () => {
  const tcpip = regKey(
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters",
    [
      ["Domain", "REG_SZ", "eng.corp.example"],
      ["NV Domain", "REG_SZ", "eng.corp.example"],
      ["SearchList", "REG_SZ", "corp.example,lab.corp.example"],
    ],
  );
  assert.deepEqual(windowsWpadDomains(parseRegQuery(tcpip)), [
    "eng.corp.example",
    "corp.example",
    "lab.corp.example",
  ]);

  const record = (option, data) => {
    const head = Buffer.alloc(16);
    head.writeUInt32LE(option, 0);
    head.writeUInt32LE(data.length, 8);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
    data.copy(padded);
    return Buffer.concat([head, padded]);
  };
  const options = Buffer.concat([
    record(1, Buffer.from([255, 255, 255, 0])),
    record(252, Buffer.from("http://wpad.corp.example/wpad.dat\0", "latin1")),
    record(15, Buffer.from("corp.example\0", "latin1")),
  ]);
  const interfaces = [
    regKey(
      "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{0B9E2A63-1111-2222-3333-444455556666}",
      [["DhcpInterfaceOptions", "REG_BINARY", options.toString("hex").toUpperCase()]],
    ),
    regKey(
      "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{AAAAAAAA-1111-2222-3333-444455556666}",
      [
        [
          "DhcpInterfaceOptions",
          "REG_BINARY",
          record(252, Buffer.from("not a url")).toString("hex"),
        ],
      ],
    ),
    "\r\nEnd of search: 2 match(es) found.\r\n",
  ].join("");
  assert.deepEqual(windowsDhcpWpadUrls(parseRegQuery(interfaces)), [
    "http://wpad.corp.example/wpad.dat",
  ]);
});

const SCUTIL_PROXY = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : corp.example
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.corp.example
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : proxy.corp.example
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://pac.corp.example/proxy.pac
  ProxyAutoDiscoveryEnable : 0
  SOCKSEnable : 0
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 0
    }
  }
}
`;

test("scutil --proxy: PAC URL, proxies, exceptions and simple host names", () => {
  assert.deepEqual(macosProxySettings(SCUTIL_PROXY), {
    source: "macOS proxy settings",
    autoDetect: false,
    pacUrl: "http://pac.corp.example/proxy.pac",
    fixed: {
      http: { host: "proxy.corp.example", port: 8080 },
      https: { host: "proxy.corp.example", port: 8443 },
      bypass: ["*.local", "169.254/16", "corp.example"],
      bypassPlain: true,
    },
  });
  assert.deepEqual(parseScutil(SCUTIL_PROXY).__SCOPED__, { en0: { HTTPEnable: "0" } });
});

test("scutil --proxy with nothing on, or auto discovery only", () => {
  const none = "<dictionary> {\n  FTPPassive : 1\n  HTTPEnable : 0\n}\n";
  assert.equal(macosProxySettings(none), null);
  const wpad = "<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n}\n";
  assert.deepEqual(macosProxySettings(wpad), { source: "macOS proxy settings", autoDetect: true });
  assert.equal(macosProxySettings(""), null);
});

test("scutil --dns search domains feed WPAD", () => {
  const dns = `DNS configuration

resolver #1
  search domain[0] : eng.corp.example
  search domain[1] : corp.example
  nameserver[0] : 10.0.0.53
  if_index : 6 (en0)

resolver #2
  domain   : local
  options  : mdns
`;
  assert.deepEqual(macosSearchDomains(dns), ["eng.corp.example", "corp.example", "local"]);
});

test("GNOME proxy settings from gsettings", () => {
  const manual = `org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '*.corp.example']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.http host 'proxy.corp.example'
org.gnome.system.proxy.http port 8080
org.gnome.system.proxy.https host 'proxy.corp.example'
org.gnome.system.proxy.https port 8443
org.gnome.system.proxy.socks host ''
`;
  assert.deepEqual(gnomeProxySettings(manual), {
    source: "GNOME proxy settings",
    autoDetect: false,
    fixed: {
      http: { host: "proxy.corp.example", port: 8080 },
      https: { host: "proxy.corp.example", port: 8443 },
      bypass: ["localhost", "127.0.0.0/8", "*.corp.example"],
      bypassPlain: false,
    },
  });
  assert.deepEqual(
    gnomeProxySettings(
      "org.gnome.system.proxy mode 'auto'\norg.gnome.system.proxy autoconfig-url 'http://pac/p.pac'\n",
    ),
    { source: "GNOME proxy settings", autoDetect: false, pacUrl: "http://pac/p.pac" },
  );
  assert.deepEqual(gnomeProxySettings("org.gnome.system.proxy mode 'auto'\n"), {
    source: "GNOME proxy settings",
    autoDetect: true,
  });
  assert.equal(gnomeProxySettings("org.gnome.system.proxy mode 'none'\n"), null);
});

test("resolv.conf search and domain lines", () => {
  assert.deepEqual(
    resolvConfDomains(
      "nameserver 10.0.0.53\nsearch eng.corp.example corp.example\ndomain corp.example\n",
    ),
    ["eng.corp.example", "corp.example"],
  );
});

test("Windows ProxyServer strings", () => {
  assert.deepEqual(parseProxyServer("proxy:3128"), {
    http: { host: "proxy", port: 3128 },
    https: { host: "proxy", port: 3128 },
  });
  assert.deepEqual(parseProxyServer("https=s:1;ftp=f:2"), { https: { host: "s", port: 1 } });
  assert.equal(parseProxyServer("socks=s:1080"), undefined);
  assert.equal(parseProxyServer(""), undefined);
});

test("fixed-proxy exceptions: globs, domains, CIDR, plain names and loopback", () => {
  const fixed = {
    https: { host: "p", port: 1 },
    bypass: ["*.corp.example", "10.*", "169.254/16", "intranet.example", "192.168.0.0/16"],
    bypassPlain: true,
  };
  for (const host of [
    "a.corp.example",
    "10.2.3.4",
    "169.254.1.1",
    "intranet.example",
    "www.intranet.example",
    "192.168.4.4",
    "server",
    "localhost",
    "127.0.0.1",
    "[::1]",
  ]) {
    assert.equal(bypassesFixedProxy(host, fixed), true, host);
  }
  for (const host of ["corp.example", "api.aiand.com", "11.2.3.4", "notintranet.example"]) {
    assert.equal(bypassesFixedProxy(host, fixed), false, host);
  }
  assert.deepEqual(fixedRoute(new URL("https://api.aiand.com/"), fixed), [
    { kind: "proxy", host: "p", port: 1 },
  ]);
  assert.deepEqual(fixedRoute(new URL("http://server/"), fixed), [{ kind: "direct" }]);
  assert.deepEqual(fixedRoute(new URL("http://api.aiand.com/"), fixed), [
    { kind: "proxy", host: "p", port: 1 },
  ]);
});

test("WPAD walks up the DNS suffix but stops at two labels and registry suffixes", () => {
  assert.deepEqual(wpadHosts(["eng.tokyo.corp.example", "corp.example"]), [
    "wpad.eng.tokyo.corp.example",
    "wpad.tokyo.corp.example",
    "wpad.corp.example",
  ]);
  assert.deepEqual(wpadHosts(["dept.example.co.jp"]), [
    "wpad.dept.example.co.jp",
    "wpad.example.co.jp",
  ]);
  assert.deepEqual(wpadHosts(["local", ""]), []);
});

test("WPAD tries DHCP first, then each wpad host that resolves, and stops at the first PAC", async () => {
  const resolved = [];
  const loaded = [];
  const found = await discoverWpad(
    {
      dhcp: ["http://dhcp-broken/wpad.dat"],
      domains: ["eng.corp.example"],
      resolves: async (host) => {
        resolved.push(host);
        return host === "wpad.corp.example";
      },
    },
    async (url) => {
      loaded.push(url);
      if (url === "http://dhcp-broken/wpad.dat") throw new Error("refused");
      return "function FindProxyForURL() { return 'DIRECT'; }";
    },
  );
  assert.deepEqual(found?.url, "http://wpad.corp.example/wpad.dat");
  assert.deepEqual(resolved, ["wpad.eng.corp.example", "wpad.corp.example"]);
  assert.deepEqual(loaded, ["http://dhcp-broken/wpad.dat", "http://wpad.corp.example/wpad.dat"]);
  assert.equal(
    await discoverWpad(
      { dhcp: [], domains: ["corp.example"], resolves: async () => false },
      async () => "",
    ),
    null,
  );
});

// --- discoverProxyConfig, with every OS tool faked ---------------------------

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    platform: "linux",
    env: {},
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return { code: 1, stdout: "" };
    },
    readFile: () => null,
    exists: () => false,
    policy: async () => ({ settings: {}, sources: {} }),
    ...overrides,
  };
}

test("AIAND_SYSTEM_PROXY=0 reads nothing", async () => {
  const fake = deps({ platform: "darwin", env: { AIAND_SYSTEM_PROXY: "0" } });
  assert.equal(await discoverProxyConfig(fake), null);
  assert.deepEqual(fake.calls, []);
});

test("a managed policy's proxyPac wins over AIAND_PROXY_PAC and the OS", async () => {
  const fake = deps({
    platform: "darwin",
    env: { AIAND_PROXY_PAC: "http://env/p.pac" },
    policy: async () => ({ settings: { proxyPac: "http://policy/p.pac" }, sources: {} }),
  });
  assert.deepEqual(await discoverProxyConfig(fake), {
    source: "managed policy proxyPac",
    autoDetect: false,
    pacUrl: "http://policy/p.pac",
  });
  assert.deepEqual(fake.calls, []);
});

test("AIAND_PROXY_PAC=auto on Linux looks for WPAD under resolv.conf's domains", async () => {
  const fake = deps({
    env: { AIAND_PROXY_PAC: "auto" },
    readFile: (path) => (path === "/etc/resolv.conf" ? "search corp.example\n" : null),
  });
  assert.deepEqual(await discoverProxyConfig(fake), {
    source: "AIAND_PROXY_PAC",
    autoDetect: true,
    wpadDomains: ["corp.example"],
    wpadDhcp: [],
  });
});

test("an unreadable managed policy does not stop the OS settings being read", async () => {
  const fake = deps({
    platform: "darwin",
    policy: async () => {
      throw new Error("bad policy");
    },
    run: async (command, args) => {
      fake.calls.push([command, ...args].join(" "));
      return { code: 0, stdout: SCUTIL_PROXY };
    },
  });
  const config = await discoverProxyConfig(fake);
  assert.equal(config?.pacUrl, "http://pac.corp.example/proxy.pac");
  assert.deepEqual(fake.calls, ["/usr/sbin/scutil --proxy"]);
});

test("macOS auto discovery also reads the DNS search domains", async () => {
  const fake = deps({ platform: "darwin" });
  fake.run = async (_command, args) => {
    fake.calls.push(args.join(" "));
    if (args[0] === "--proxy")
      return { code: 0, stdout: "<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n}\n" };
    return { code: 0, stdout: "resolver #1\n  search domain[0] : corp.example\n" };
  };
  assert.deepEqual(await discoverProxyConfig(fake), {
    source: "macOS proxy settings",
    autoDetect: true,
    wpadDomains: ["corp.example"],
    wpadDhcp: [],
  });
  assert.deepEqual(fake.calls, ["--proxy", "--dns"]);
});

test("Windows reads every proxy key with reg.exe in the 64-bit view, and WPAD sources", async () => {
  const fake = deps({ platform: "win32", env: { SystemRoot: "C:\\Windows" } });
  fake.run = async (_command, args) => {
    fake.calls.push(args.join(" "));
    if (args[1] === `HKCU\\${IS}\\Connections`) {
      return {
        code: 0,
        stdout: regKey(`HKEY_CURRENT_USER\\${IS}\\Connections`, [
          ["DefaultConnectionSettings", "REG_BINARY", connectionBlob({ flags: 0x09 })],
        ]),
      };
    }
    if (args[1] === "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters") {
      return {
        code: 0,
        stdout: regKey(
          "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters",
          [["Domain", "REG_SZ", "corp.example"]],
        ),
      };
    }
    return { code: 1, stdout: "" };
  };
  const config = await discoverProxyConfig(fake);
  assert.deepEqual(config, {
    source: "Windows proxy settings",
    autoDetect: true,
    wpadDomains: ["corp.example"],
    wpadDhcp: [],
  });
  assert.ok(
    fake.calls.every((call) => call.startsWith("query ") && call.endsWith(" /reg:64")),
    fake.calls.join("\n"),
  );
  assert.ok(fake.calls.some((call) => call.includes("\\Interfaces /s /v DhcpInterfaceOptions")));
});

test("Linux without a desktop session or gsettings reads nothing", async () => {
  const fake = deps({ env: { XDG_CURRENT_DESKTOP: "GNOME" } });
  assert.equal(await discoverProxyConfig(fake), null);
  assert.deepEqual(fake.calls, []);
  const withGsettings = deps({ env: { XDG_CURRENT_DESKTOP: "GNOME" }, exists: () => true });
  withGsettings.run = async (command, args) => {
    withGsettings.calls.push([command, ...args].join(" "));
    return {
      code: 0,
      stdout:
        "org.gnome.system.proxy mode 'auto'\norg.gnome.system.proxy autoconfig-url 'http://pac/p.pac'\n",
    };
  };
  assert.equal((await discoverProxyConfig(withGsettings))?.pacUrl, "http://pac/p.pac");
  assert.deepEqual(withGsettings.calls, [
    "/usr/bin/gsettings list-recursively org.gnome.system.proxy",
  ]);
});
