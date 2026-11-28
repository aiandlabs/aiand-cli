import type { Endpoint, FixedProxy, ProxyConfig } from "./proxy-config.js";

/** A `scutil` value: a scalar, an `<array>` or a `<dictionary>`. */
type ScutilValue = string | ScutilValue[] | { [key: string]: ScutilValue };

/**
 * Parse `scutil --proxy` (or `--dns`) output: nested `<dictionary> {` and
 * `<array> {` blocks of `key : value` lines.
 */
export function parseScutil(stdout: string): { [key: string]: ScutilValue } {
  const root: { [key: string]: ScutilValue } = {};
  const stack: (ScutilValue[] | { [key: string]: ScutilValue })[] = [];
  let started = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!started) {
      if (/^<dictionary>\s*\{$/.test(line)) {
        stack.push(root);
        started = true;
      }
      continue;
    }
    if (line === "}") {
      stack.pop();
      if (stack.length === 0) break;
      continue;
    }
    const match = /^(.+?)\s*:\s*(.*)$/.exec(line);
    const parent = stack.at(-1);
    if (!match || parent === undefined) continue;
    const key = match[1]!;
    const value = match[2]!;
    let child: ScutilValue = value;
    if (/^<array>\s*\{$/.test(value)) child = [];
    else if (/^<dictionary>\s*\{$/.test(value)) child = {};
    if (Array.isArray(parent)) parent.push(child);
    else parent[key] = child;
    if (typeof child !== "string") stack.push(child);
  }
  return root;
}

function scalar(dict: { [key: string]: ScutilValue }, key: string): string | undefined {
  const value = dict[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function list(dict: { [key: string]: ScutilValue }, key: string): string[] {
  const value = dict[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function endpoint(
  dict: { [key: string]: ScutilValue },
  prefix: "HTTP" | "HTTPS",
): Endpoint | undefined {
  if (scalar(dict, `${prefix}Enable`) !== "1") return undefined;
  const host = scalar(dict, `${prefix}Proxy`);
  const port = Number(scalar(dict, `${prefix}Port`) ?? 80);
  if (host === undefined || !(port > 0 && port < 65_536)) return undefined;
  return { host, port };
}

/** The system proxy settings `scutil --proxy` reports for the active network. */
export function macosProxySettings(stdout: string): ProxyConfig | null {
  const dict = parseScutil(stdout);
  const http = endpoint(dict, "HTTP");
  const https = endpoint(dict, "HTTPS");
  const fixed: FixedProxy | undefined =
    http || https
      ? {
          ...(http ? { http } : {}),
          ...(https ? { https } : {}),
          bypass: list(dict, "ExceptionsList"),
          bypassPlain: scalar(dict, "ExcludeSimpleHostnames") === "1",
        }
      : undefined;
  const pacUrl =
    scalar(dict, "ProxyAutoConfigEnable") === "1"
      ? scalar(dict, "ProxyAutoConfigURLString")
      : undefined;
  const autoDetect = scalar(dict, "ProxyAutoDiscoveryEnable") === "1";
  if (!autoDetect && pacUrl === undefined && fixed === undefined) return null;
  return {
    source: "macOS proxy settings",
    autoDetect,
    ...(pacUrl !== undefined ? { pacUrl } : {}),
    ...(fixed ? { fixed } : {}),
  };
}

/** DNS search domains from `scutil --dns`, most specific first. */
export function macosSearchDomains(stdout: string): string[] {
  const domains: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(?:search domain\[\d+\]|domain)\s*:\s*(\S+)\s*$/.exec(line);
    if (match) domains.push(match[1]!.toLowerCase());
  }
  return [...new Set(domains)];
}
