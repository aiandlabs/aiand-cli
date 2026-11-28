import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { getCACertificates } from "node:tls";
import {
  PacError,
  type PacHost,
  PacScript,
  parsePacResult,
  type Route,
  type Trust,
} from "./pac.js";
import { fixedRoute, matchesNoProxy, noProxyOf, type ProxyConfig } from "./proxy-config.js";
import { discoverWpad, wpadSuffixes } from "./wpad.js";

const PAC_MAX_BYTES = 1024 * 1024;
const PAC_TIMEOUT_MS = 3_000;
const LOOKUP_TIMEOUT_MS = 1_500;
const ROUTE_CACHE_LIMIT = 512;

export type ResolverDeps = {
  /** A PAC file's text, fetched directly (never through a proxy). */
  loadPac(url: string): Promise<string>;
  /** The IPv4 address `host` resolves to, or null. */
  resolve(host: string): Promise<string | null>;
  /** This machine's address on the route to `ip` (what myIpAddress() answers). */
  localAddress(ip: string | null): Promise<string>;
  now(): number;
};

/** A URL fit to print: no user name, password, query or fragment. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "a local file";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "an invalid URL";
  }
}

/** The roots a PAC served over https is checked against: Node's and the OS store's. */
function pacTrustRoots(): string[] {
  return [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];
}

/**
 * Fetch a PAC over http(s), capped in size and time. Redirects are not
 * followed. An https PAC is checked against the OS certificate store as well
 * as Node's, as browsers check it. A file: URL is refused: a PAC setting is
 * not a way to have aiand read local files (Windows dropped file: PACs too).
 */
export function loadPac(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new PacError("the PAC URL is not a valid URL"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(new PacError("a PAC URL must be http or https"));
  }
  const secure = parsed.protocol === "https:";
  const get = secure ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const options = {
      timeout: PAC_TIMEOUT_MS,
      agent: false,
      ...(secure ? { ca: pacTrustRoots() } : {}),
    };
    const request = get(parsed, options, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new PacError(`the server answered ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PAC_MAX_BYTES) {
          request.destroy(new PacError("it is larger than 1 MB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new PacError("it did not load within 3 seconds")));
    request.on("error", reject);
  });
}

async function resolveIpv4(host: string): Promise<string | null> {
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS).unref(),
  );
  const answer = lookup(host, { family: 4 }).then(
    (result) => result.address,
    () => null,
  );
  return Promise.race([answer, timeout]);
}

function firstIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

/**
 * The local address the OS would send from to reach `ip`: a UDP socket
 * connected to it (no packet is sent) reports it. That is the interface of
 * the route in use, not a container or VM bridge that happens to be listed
 * first. Falls back to the first non-loopback address.
 */
export function localAddressFor(ip: string | null): Promise<string> {
  if (ip === null || isIP(ip) !== 4) return Promise.resolve(firstIpv4());
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (address: string): void => {
      socket.close();
      resolve(address);
    };
    socket.on("error", () => done(firstIpv4()));
    socket.connect(53, ip, () => {
      const { address } = socket.address();
      done(address && address !== "0.0.0.0" ? address : firstIpv4());
    });
  });
}

const defaultResolverDeps: ResolverDeps = {
  loadPac,
  resolve: resolveIpv4,
  localAddress: localAddressFor,
  now: Date.now,
};

/** What prepare() found, to be cached and restored without fetching again. */
export type ResolverState = {
  pacUrl: string | null;
  pacSource: string | null;
  /** The PAC came from WPAD, so the proxies it names are not fully trusted. */
  fromWpad: boolean;
  myIp: string;
  /** A configured PAC that could not be loaded, in plain words. */
  pacFailure: string | null;
};

const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/;

/**
 * Turns a ProxyConfig into routes, the way Windows applies one: a PAC from
 * WPAD, else the configured PAC, else the fixed proxy, else direct. A PAC
 * that cannot be loaded or answers with an error falls through to the fixed
 * proxy, as WinINet does.
 */
export class ProxyResolver {
  readonly config: ProxyConfig;
  readonly #deps: ResolverDeps;
  #pac: PacScript | null = null;
  #state: ResolverState = {
    pacUrl: null,
    pacSource: null,
    fromWpad: false,
    myIp: "127.0.0.1",
    pacFailure: null,
  };
  readonly #cache = new Map<string, Route[]>();
  readonly notes: string[] = [];

  readonly #env: NodeJS.ProcessEnv;

  /** `env` supplies NO_PROXY, which wins over the PAC and the fixed proxy as it does for Node. */
  constructor(
    config: ProxyConfig,
    deps: ResolverDeps = defaultResolverDeps,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.config = config;
    this.#deps = deps;
    this.#env = env;
  }

  /** Load the PAC, if any. Resolves whether anything but direct is possible. */
  async prepare(): Promise<boolean> {
    const { config } = this;
    const load = async (url: string, fromWpad: boolean): Promise<string | null> => {
      try {
        const source = await this.#deps.loadPac(url);
        this.#pac = new PacScript(source);
        this.#state = { ...this.#state, pacUrl: url, pacSource: source, fromWpad };
        return source;
      } catch (error) {
        const reason = (error as Error).message;
        this.notes.push(`PAC ${displayUrl(url)}: ${reason}`);
        if (!fromWpad) {
          this.#state.pacFailure = `aiand could not load the proxy configuration file from ${displayUrl(url)} (${reason}), so it ${config.fixed ? "uses the fixed proxy from the same settings" : "connects directly"}.`;
        }
        return null;
      }
    };
    if (config.autoDetect) {
      const found = await discoverWpad(
        {
          dhcp: config.wpadDhcp ?? [],
          domains: config.wpadDomains ?? [],
          resolves: async (host) => (await this.#deps.resolve(host)) !== null,
        },
        (url) => load(url, true),
      );
      if (found === null) this.notes.push("WPAD found no PAC file");
    }
    if (this.#pac === null && config.pacUrl !== undefined) await load(config.pacUrl, false);
    if (this.#pac !== null && this.#state.pacUrl !== null) {
      const pacHost = new URL(this.#state.pacUrl).hostname;
      const ip =
        pacHost === "" ? null : isIP(pacHost) === 4 ? pacHost : await this.#deps.resolve(pacHost);
      this.#state.myIp = await this.#deps.localAddress(ip).catch(() => "127.0.0.1");
    }
    return this.active;
  }

  get active(): boolean {
    return this.#pac !== null || this.config.fixed !== undefined;
  }

  /** What prepare() found, for the discovery cache. */
  get state(): ResolverState {
    return { ...this.#state };
  }

  /** Take a cached state instead of preparing. A cached PAC that no longer compiles is dropped. */
  restore(state: ResolverState): boolean {
    this.#state = { ...state, pacFailure: null };
    this.#pac = null;
    if (state.pacSource !== null) {
      try {
        this.#pac = new PacScript(state.pacSource);
      } catch {
        this.#state = { ...this.#state, pacUrl: null, pacSource: null };
      }
    }
    return this.active;
  }

  /** Where the PAC in use came from, fit to print. */
  get pacUrl(): string | null {
    return this.#state.pacUrl === null ? null : displayUrl(this.#state.pacUrl);
  }

  async routes(url: URL): Promise<Route[]> {
    const key = `${url.protocol}//${url.host}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const routes = await this.#compute(url);
    if (this.#cache.size >= ROUTE_CACHE_LIMIT) this.#cache.clear();
    this.#cache.set(key, routes);
    return routes;
  }

  /** How far a proxy named by the PAC in use is trusted with the user's sign-in. */
  #trust(host: string): Trust {
    if (!this.#state.fromWpad) return "full";
    const name = host.toLowerCase();
    if (!name.includes(".") && !name.includes(":")) return "intranet";
    if (isIP(name) === 4) return PRIVATE_V4.test(name) ? "intranet" : "none";
    if (isIP(name) === 6) return /^(?:fc|fd|fe80|::1$)/i.test(name) ? "intranet" : "none";
    const suffixes = wpadSuffixes(this.config.wpadDomains ?? []);
    return suffixes.some((s) => name === s || name.endsWith(`.${s}`)) ? "intranet" : "none";
  }

  async #compute(url: URL): Promise<Route[]> {
    const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
    if (matchesNoProxy(url.hostname, port, noProxyOf(this.#env))) return [{ kind: "direct" }];
    if (this.#pac !== null) {
      const host: PacHost = {
        resolve: (name) => (isIP(name) === 4 ? Promise.resolve(name) : this.#deps.resolve(name)),
        myIpAddress: this.#state.myIp,
        now: this.#deps.now,
      };
      try {
        return parsePacResult(await this.#pac.find(url, host)).map((route) =>
          route.kind === "proxy" ? { ...route, trust: this.#trust(route.host) } : route,
        );
      } catch (error) {
        this.notes.push(`PAC answer for ${url.host}: ${(error as Error).message}`);
      }
    }
    return this.config.fixed ? fixedRoute(url, this.config.fixed, this.#env) : [{ kind: "direct" }];
  }

  close(): void {
    this.#pac?.close();
  }
}
