import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { windowsSystemTool } from "../cli/win-spawn.js";
import { runTool } from "../fsutil.js";
import {
  type LoadedPolicy,
  readLinuxPolicy,
  readMacOSPolicy,
  readWindowsPolicy,
} from "../policy.js";
import { parseEndpoint } from "./pac.js";
import type { ProxyConfig } from "./proxy-config.js";
import { splitBypass } from "./proxy-config.js";
import { macosProxySettings, macosSearchDomains } from "./system-proxy-macos.js";
import {
  parseRegQuery,
  type RegKeys,
  WINDOWS_PROXY_KEYS,
  WINDOWS_TCPIP_KEY,
  windowsDhcpWpadUrls,
  windowsInternetSettings,
  windowsWinHttpSettings,
  windowsWpadDomains,
} from "./system-proxy-windows.js";

/** Turns off reading system proxy settings: `AIAND_SYSTEM_PROXY=0`. */
export const SYSTEM_PROXY_SWITCH = "AIAND_SYSTEM_PROXY";
/** A PAC URL (or `auto` for WPAD) that applies on every OS, over system settings. */
export const PAC_SETTING = "AIAND_PROXY_PAC";

type Run = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string }>;

export type DiscoveryDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: Run;
  readFile(path: string): string | null;
  exists(path: string): boolean;
  policy(): Promise<LoadedPolicy>;
  /** This machine's current IPv4 addresses, to tell a live DHCP lease from a stale one. */
  addresses(): string[];
};

function localIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

const TOOL_TIMEOUT_MS = 5_000;

export function defaultDiscoveryDeps(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DiscoveryDeps {
  return {
    platform,
    env,
    run: runTool,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    exists: existsSync,
    addresses: localIpv4Addresses,
    policy: () => {
      if (platform === "win32") return readWindowsPolicy({ env });
      if (platform === "darwin") return readMacOSPolicy();
      return Promise.resolve(readLinuxPolicy());
    },
  };
}

/** A PAC setting's value as a config: a URL, or `auto` for WPAD. */
function pacSetting(value: string, source: string): ProxyConfig | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.toLowerCase() === "auto") return { source, autoDetect: true };
  return { source, autoDetect: false, pacUrl: trimmed };
}

/**
 * The proxy configuration the OS (or an administrator) sets, or null for a
 * direct connection. A managed policy's `proxyPac` comes first, then
 * `AIAND_PROXY_PAC`, then the OS's own settings. HTTPS_PROXY and the other
 * variables are handled before this is ever asked.
 */
export async function discoverProxyConfig(deps: DiscoveryDeps): Promise<ProxyConfig | null> {
  if (deps.env[SYSTEM_PROXY_SWITCH] === "0") return null;
  const policy = await deps.policy().catch(() => null);
  const policyPac = policy?.settings.proxyPac;
  let config =
    (policyPac !== undefined ? pacSetting(policyPac, "managed policy proxyPac") : null) ??
    pacSetting(deps.env[PAC_SETTING] ?? "", PAC_SETTING);
  if (config === null) {
    if (deps.platform === "win32") config = await windowsConfig(deps);
    else if (deps.platform === "darwin") config = await macosConfig(deps);
    else config = await gnomeConfig(deps);
  }
  if (config?.autoDetect) {
    const { domains, dhcp } = await wpadSources(deps);
    config = {
      ...config,
      wpadDomains: config.wpadDomains ?? domains,
      wpadDhcp: config.wpadDhcp ?? dhcp,
    };
  }
  return config;
}

async function query(deps: DiscoveryDeps, args: string[]): Promise<RegKeys> {
  const reg = windowsSystemTool("reg.exe", deps.env);
  const result = await deps
    .run(reg, ["query", ...args, "/reg:64"], { timeoutMs: TOOL_TIMEOUT_MS })
    .catch(() => null);
  return result?.code === 0 ? parseRegQuery(result.stdout) : new Map();
}

async function windowsConfig(deps: DiscoveryDeps): Promise<ProxyConfig | null> {
  const parts = await Promise.all(
    Object.values(WINDOWS_PROXY_KEYS).map((key) => query(deps, [key])),
  );
  const keys: RegKeys = new Map(parts.flatMap((part) => [...part]));
  return windowsInternetSettings(keys) ?? windowsWinHttpSettings(keys);
}

async function macosConfig(deps: DiscoveryDeps): Promise<ProxyConfig | null> {
  const result = await deps
    .run("/usr/sbin/scutil", ["--proxy"], { timeoutMs: TOOL_TIMEOUT_MS })
    .catch(() => null);
  return result?.code === 0 ? macosProxySettings(result.stdout) : null;
}

/** A GVariant text value from gsettings: `'text'`, a number, or `['a', 'b']`. */
function gvariant(raw: string): string | string[] {
  const value = raw.trim().replace(/^@as\s+/, "");
  if (value.startsWith("[")) {
    return [...value.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
  }
  const quoted = /^'((?:[^'\\]|\\.)*)'$/.exec(value);
  return quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : value;
}

/** GNOME's proxy settings, from `gsettings list-recursively org.gnome.system.proxy`. */
export function gnomeProxySettings(stdout: string): ProxyConfig | null {
  const values = new Map<string, string | string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^org\.gnome\.system\.proxy(\.[a-z]+)?\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (match) values.set(`${match[1]?.slice(1) ?? ""}.${match[2]}`, gvariant(match[3]!));
  }
  const textValue = (key: string): string => {
    const value = values.get(key);
    return typeof value === "string" ? value : "";
  };
  const mode = textValue(".mode");
  const source = "GNOME proxy settings";
  if (mode === "auto") {
    const url = textValue(".autoconfig-url");
    return url === "" ? { source, autoDetect: true } : { source, autoDetect: false, pacUrl: url };
  }
  if (mode !== "manual") return null;
  const endpoint = (scheme: string) =>
    textValue(`${scheme}.host`) === ""
      ? undefined
      : (parseEndpoint(
          `${textValue(`${scheme}.host`)}:${textValue(`${scheme}.port`) || "80"}`,
          80,
        ) ?? undefined);
  const http = endpoint("http");
  const https = endpoint("https");
  if (!http && !https) return null;
  const ignore = values.get(".ignore-hosts");
  return {
    source,
    autoDetect: false,
    fixed: {
      ...(http ? { http } : {}),
      ...(https ? { https } : {}),
      ...splitBypass(Array.isArray(ignore) ? ignore.join(";") : ""),
    },
  };
}

const GSETTINGS = "/usr/bin/gsettings";

async function gnomeConfig(deps: DiscoveryDeps): Promise<ProxyConfig | null> {
  const desktop = deps.env.XDG_CURRENT_DESKTOP ?? deps.env.DBUS_SESSION_BUS_ADDRESS;
  if (!desktop || !deps.exists(GSETTINGS)) return null;
  const result = await deps
    .run(GSETTINGS, ["list-recursively", "org.gnome.system.proxy"], { timeoutMs: TOOL_TIMEOUT_MS })
    .catch(() => null);
  return result?.code === 0 ? gnomeProxySettings(result.stdout) : null;
}

/** `search` and `domain` lines from resolv.conf, in order. */
export function resolvConfDomains(text: string): string[] {
  const domains: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(search|domain)\s+(.+)$/.exec(line);
    if (match) domains.push(...match[2]!.trim().split(/\s+/));
  }
  return [...new Set(domains.map((d) => d.toLowerCase()))];
}

async function wpadSources(deps: DiscoveryDeps): Promise<{ domains: string[]; dhcp: string[] }> {
  if (deps.platform === "win32") {
    const [tcpip, interfaces] = await Promise.all([
      query(deps, [WINDOWS_TCPIP_KEY]),
      query(deps, [`${WINDOWS_TCPIP_KEY}\\Interfaces`, "/s"]),
    ]);
    const current = { addresses: deps.addresses(), nowSeconds: Math.floor(Date.now() / 1000) };
    return { domains: windowsWpadDomains(tcpip), dhcp: windowsDhcpWpadUrls(interfaces, current) };
  }
  if (deps.platform === "darwin") {
    const result = await deps
      .run("/usr/sbin/scutil", ["--dns"], { timeoutMs: TOOL_TIMEOUT_MS })
      .catch(() => null);
    return { domains: result?.code === 0 ? macosSearchDomains(result.stdout) : [], dhcp: [] };
  }
  return { domains: resolvConfDomains(deps.readFile("/etc/resolv.conf") ?? ""), dhcp: [] };
}
