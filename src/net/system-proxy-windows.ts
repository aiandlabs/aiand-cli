import {
  type FixedProxy,
  type ProxyConfig,
  parseProxyServer,
  splitBypass,
} from "./proxy-config.js";

/**
 * Windows proxy settings, read with reg.exe the way WinINet and WinHTTP read
 * them: Group Policy first, then the per-user (or, under the "per machine"
 * policy, machine-wide) Internet Settings, then the WinHTTP setting that
 * `netsh winhttp set proxy` writes.
 */

type RegValue = { type: string; data: string };
/** reg.exe output: key path (lowercased) to value name (lowercased) to value. */
export type RegKeys = Map<string, Map<string, RegValue>>;

const IS = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const POLICY_IS = "Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export const WINDOWS_PROXY_KEYS = {
  machinePolicy: `HKLM\\${POLICY_IS}`,
  userPolicy: `HKCU\\${POLICY_IS}`,
  user: `HKCU\\${IS}`,
  userConnections: `HKCU\\${IS}\\Connections`,
  machine: `HKLM\\${IS}`,
  machineConnections: `HKLM\\${IS}\\Connections`,
} as const;

export const WINDOWS_TCPIP_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters";

const HIVES: Record<string, string> = {
  HKEY_LOCAL_MACHINE: "HKLM",
  HKEY_CURRENT_USER: "HKCU",
};

function normalizeKey(key: string): string {
  const [hive = "", ...rest] = key.split("\\");
  return [HIVES[hive.toUpperCase()] ?? hive.toUpperCase(), ...rest].join("\\").toLowerCase();
}

/** Parse `reg query` output (one key, or several with /s). */
export function parseRegQuery(stdout: string): RegKeys {
  const keys: RegKeys = new Map();
  let current: Map<string, RegValue> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      current = new Map();
      keys.set(normalizeKey(line.trim()), current);
      continue;
    }
    const match = /^ {4}(.*?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/.exec(line);
    if (match && current)
      current.set(match[1]!.toLowerCase(), { type: match[2]!, data: match[3] ?? "" });
  }
  return keys;
}

function regValue(keys: RegKeys, key: string, name: string): RegValue | undefined {
  return keys.get(normalizeKey(key))?.get(name.toLowerCase());
}

function dword(value: RegValue | undefined): number | undefined {
  if (value?.type !== "REG_DWORD") return undefined;
  const parsed = Number.parseInt(value.data, 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function text(value: RegValue | undefined): string | undefined {
  if (value?.type !== "REG_SZ" && value?.type !== "REG_EXPAND_SZ") return undefined;
  return value.data.trim() === "" ? undefined : value.data.trim();
}

export type ConnectionSettings = {
  flags: number;
  proxy: string;
  bypass: string;
  pacUrl: string;
};

const CONNECTION_FLAGS = { direct: 1, proxy: 2, pacUrl: 4, autoDetect: 8 } as const;

/**
 * The binary `DefaultConnectionSettings` (and `WinHttpSettings`) value:
 * version, counter and flags as little-endian DWORDs, then length-prefixed
 * proxy, bypass and (WinINet only) PAC URL strings.
 */
export function parseConnectionSettings(hex: string): ConnectionSettings | null {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 12) return null;
  let offset = 12;
  const readString = (): string | null => {
    if (offset === bytes.length) return "";
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    if (offset + length > bytes.length) return null;
    const value = bytes.subarray(offset, offset + length).toString("latin1");
    offset += length;
    return value;
  };
  const flags = bytes.readUInt32LE(8);
  const proxy = readString();
  const bypass = readString();
  const pacUrl = readString();
  if (proxy === null || bypass === null || pacUrl === null) return null;
  return { flags, proxy, bypass, pacUrl };
}

function fixedFrom(
  server: string | undefined,
  override: string | undefined,
): FixedProxy | undefined {
  const endpoints = server === undefined ? undefined : parseProxyServer(server);
  if (!endpoints) return undefined;
  return { ...endpoints, ...splitBypass(override ?? "") };
}

/**
 * The WinINet settings in effect: the policy key wins value by value, then
 * the connection blob, then the plain values WinINet mirrors it into.
 */
export function windowsInternetSettings(keys: RegKeys): ProxyConfig | null {
  const perUser = dword(regValue(keys, WINDOWS_PROXY_KEYS.machinePolicy, "ProxySettingsPerUser"));
  const machine = perUser === 0;
  const settingsKey = machine ? WINDOWS_PROXY_KEYS.machine : WINDOWS_PROXY_KEYS.user;
  const connectionsKey = machine
    ? WINDOWS_PROXY_KEYS.machineConnections
    : WINDOWS_PROXY_KEYS.userConnections;
  const policyKey = machine ? WINDOWS_PROXY_KEYS.machinePolicy : WINDOWS_PROXY_KEYS.userPolicy;
  const pick = (name: string): RegValue | undefined =>
    regValue(keys, policyKey, name) ?? regValue(keys, settingsKey, name);

  const blobValue = regValue(keys, connectionsKey, "DefaultConnectionSettings");
  const blob = blobValue?.type === "REG_BINARY" ? parseConnectionSettings(blobValue.data) : null;

  const enabled = dword(pick("ProxyEnable"));
  const proxyOn =
    enabled === undefined ? Boolean(blob && blob.flags & CONNECTION_FLAGS.proxy) : enabled === 1;
  const server = text(pick("ProxyServer")) ?? (blob?.proxy || undefined);
  const override = text(pick("ProxyOverride")) ?? (blob?.bypass || undefined);
  const pacFromBlob =
    blob && blob.flags & CONNECTION_FLAGS.pacUrl ? blob.pacUrl || undefined : undefined;
  const pacUrl =
    text(regValue(keys, policyKey, "AutoConfigURL")) ??
    pacFromBlob ??
    text(regValue(keys, settingsKey, "AutoConfigURL"));
  const autoDetect = Boolean(blob && blob.flags & CONNECTION_FLAGS.autoDetect);
  const fixed = proxyOn ? fixedFrom(server, override) : undefined;

  const config: ProxyConfig = {
    source: machine ? "Windows machine proxy settings" : "Windows proxy settings",
    autoDetect,
    ...(pacUrl !== undefined ? { pacUrl } : {}),
    ...(fixed ? { fixed } : {}),
  };
  return autoDetect || pacUrl !== undefined || fixed ? config : null;
}

/** The machine-wide WinHTTP proxy (`netsh winhttp set proxy`), used when WinINet has none. */
export function windowsWinHttpSettings(keys: RegKeys): ProxyConfig | null {
  const value = regValue(keys, WINDOWS_PROXY_KEYS.machineConnections, "WinHttpSettings");
  const blob = value?.type === "REG_BINARY" ? parseConnectionSettings(value.data) : null;
  if (!blob || !(blob.flags & CONNECTION_FLAGS.proxy)) return null;
  const fixed = fixedFrom(blob.proxy, blob.bypass);
  return fixed ? { source: "Windows WinHTTP proxy", autoDetect: false, fixed } : null;
}

/** DNS suffixes WPAD searches under: the primary domain, then the search list. */
export function windowsWpadDomains(keys: RegKeys): string[] {
  const read = (name: string): string | undefined => text(regValue(keys, WINDOWS_TCPIP_KEY, name));
  const domains = [read("Domain"), read("NV Domain"), read("DhcpDomain")];
  for (const entry of (read("SearchList") ?? "").split(/[,\s]+/)) domains.push(entry);
  return [...new Set(domains.filter((d): d is string => Boolean(d)).map((d) => d.toLowerCase()))];
}

const DHCP_WPAD_OPTION = 252;

/**
 * PAC URLs a DHCP server offered, from each interface's cached
 * `DhcpInterfaceOptions`: records of option id, vendor flag, data length and
 * a timestamp as DWORDs, then the data padded to four bytes. A record that
 * does not fit ends the scan; only http(s) URLs are kept.
 */
export function windowsDhcpWpadUrls(keys: RegKeys): string[] {
  const urls: string[] = [];
  for (const values of keys.values()) {
    const value = values.get("dhcpinterfaceoptions");
    if (value?.type !== "REG_BINARY" || !/^(?:[0-9a-f]{2})*$/i.test(value.data)) continue;
    const bytes = Buffer.from(value.data, "hex");
    let offset = 0;
    while (offset + 16 <= bytes.length) {
      const option = bytes.readUInt32LE(offset);
      const length = bytes.readUInt32LE(offset + 8);
      const start = offset + 16;
      if (start + length > bytes.length) break;
      if (option === DHCP_WPAD_OPTION) {
        const url = bytes
          .subarray(start, start + length)
          .toString("latin1")
          .replace(/\0+$/, "");
        if (/^https?:\/\/[^\s]+$/i.test(url)) urls.push(url);
      }
      offset = start + Math.ceil(length / 4) * 4;
    }
  }
  return [...new Set(urls)];
}
