import { isIP } from "node:net";
import { parseEndpoint, type Route } from "./pac.js";

export type Endpoint = { host: string; port: number };

/** A proxy named directly in system settings, used when no PAC answers. */
export type FixedProxy = {
  http?: Endpoint;
  https?: Endpoint;
  /** Host patterns that go direct: `*.corp.example`, `10.*`, `10.0.0.0/8`. */
  bypass: string[];
  /** Host names without a dot go direct (Windows `<local>`, macOS "simple hostnames"). */
  bypassPlain: boolean;
};

/**
 * Where the operating system says requests should go, in the order Windows
 * applies them: automatic detection (WPAD), then a PAC file, then a fixed
 * proxy. `source` names where it was read, for the debug line.
 */
export type ProxyConfig = {
  source: string;
  autoDetect: boolean;
  pacUrl?: string;
  fixed?: FixedProxy;
  /** DNS suffixes to try `wpad.<suffix>` under, most specific first. */
  wpadDomains?: string[];
  /** PAC URLs a DHCP server offered (option 252). */
  wpadDhcp?: string[];
};

export function hasProxySettings(config: ProxyConfig): boolean {
  return config.autoDetect || config.pacUrl !== undefined || config.fixed !== undefined;
}

/**
 * A proxy list as Windows writes it (`host:port`, or `http=h:p;https=h:p`),
 * or a single endpoint. SOCKS entries are ignored: aiand cannot use them.
 */
export function parseProxyServer(text: string): Pick<FixedProxy, "http" | "https"> | undefined {
  const value = text.trim();
  if (value === "") return undefined;
  if (!value.includes("=")) {
    const endpoint = parseEndpoint(value, 80);
    return endpoint ? { http: endpoint, https: endpoint } : undefined;
  }
  const result: Pick<FixedProxy, "http" | "https"> = {};
  for (const part of value.split(/[;\s]+/)) {
    const [scheme = "", target = ""] = part.split("=", 2);
    const endpoint = parseEndpoint(target, 80);
    if (!endpoint) continue;
    if (scheme.toLowerCase() === "http") result.http = endpoint;
    if (scheme.toLowerCase() === "https") result.https = endpoint;
  }
  return result.http || result.https ? result : undefined;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

/** `10.0.0.0/8` and macOS's short form `169.254/16`, for an IPv4 host. */
function matchesCidr(host: string, pattern: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){0,3})\/(\d{1,2})$/.exec(pattern);
  if (!match || isIP(host) !== 4) return false;
  const octets = match[1]!.split(".");
  while (octets.length < 4) octets.push("0");
  const bits = Number(match[2]);
  if (bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(host) & mask) >>> 0 === (ipv4ToInt(octets.join(".")) & mask) >>> 0;
}

function matchesGlob(host: string, pattern: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  // A bare domain also covers its subdomains, as macOS and GNOME read it.
  const domain = pattern.startsWith(".") ? `|.*${escaped}` : `|.*\\.${escaped}`;
  return new RegExp(`^(?:${source}${pattern.includes("*") ? "" : domain})$`).test(host);
}

const LOOPBACK =
  /^(?:localhost|[a-z0-9.-]*\.localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|0\.0\.0\.0|::)$/i;

/** Whether `host` (brackets allowed) names this machine. */
export function isLoopback(host: string): boolean {
  return LOOPBACK.test(
    host
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, ""),
  );
}

/** NO_PROXY (or no_proxy) as the environment sets it. */
export function noProxyOf(env: NodeJS.ProcessEnv): string {
  return env.NO_PROXY ?? env.no_proxy ?? "";
}

/**
 * Whether NO_PROXY sends `host` direct, read the way Node and curl read it:
 * `*` for everything; a domain (with or without a leading `.` or `*.`)
 * covering itself and its subdomains; an IP address or CIDR range; any of
 * them with `:port` to cover that port only.
 */
export function matchesNoProxy(host: string, port: number | undefined, noProxy: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  for (const raw of noProxy.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return true;
    const portMatch = /^(.*?):(\d+)$/.exec(entry);
    if (portMatch && !entry.startsWith("[") && (portMatch[1]!.match(/:/g) ?? []).length === 0) {
      if (port !== undefined && Number(portMatch[2]) !== port) continue;
      entry = portMatch[1]!;
    }
    entry = entry.replace(/^\[|\]$/g, "");
    if (entry.includes("/")) {
      if (matchesCidr(name, entry)) return true;
      continue;
    }
    const domain = entry.replace(/^\*?\./, "");
    if (name === domain || name.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/** Whether `host` skips a fixed proxy. Loopback always does, and so does NO_PROXY. */
export function bypassesFixedProxy(
  host: string,
  fixed: FixedProxy,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.test(name)) return true;
  if (matchesNoProxy(name, undefined, noProxyOf(env))) return true;
  if (fixed.bypassPlain && !name.includes(".") && !name.includes(":")) return true;
  return fixed.bypass.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "" || pattern === "<local>") return false;
    if (pattern.includes("/")) return matchesCidr(name, pattern);
    return matchesGlob(name, pattern.replace(/:\d+$/, ""));
  });
}

/** The route a fixed proxy gives `url`. */
export function fixedRoute(
  url: URL,
  fixed: FixedProxy,
  env: NodeJS.ProcessEnv = process.env,
): Route[] {
  if (bypassesFixedProxy(url.hostname, fixed, env)) return [{ kind: "direct" }];
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const endpoint = secure ? (fixed.https ?? fixed.http) : (fixed.http ?? fixed.https);
  return endpoint ? [{ kind: "proxy", ...endpoint }] : [{ kind: "direct" }];
}

/** Split a list of bypass entries the way each OS writes them. */
export function splitBypass(text: string): { bypass: string[]; bypassPlain: boolean } {
  const entries = text
    .split(/[;,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    bypass: entries.filter((entry) => entry.toLowerCase() !== "<local>"),
    bypassPlain: entries.some((entry) => entry.toLowerCase() === "<local>"),
  };
}
