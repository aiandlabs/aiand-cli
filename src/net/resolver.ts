import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { PacError, type PacHost, PacScript, parsePacResult, type Route } from "./pac.js";
import { fixedRoute, type ProxyConfig } from "./proxy-config.js";
import { discoverWpad } from "./wpad.js";

const PAC_MAX_BYTES = 1024 * 1024;
const PAC_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 2_000;
const ROUTE_CACHE_LIMIT = 512;

export type ResolverDeps = {
  /** A PAC file's text, fetched directly (never through a proxy). */
  loadPac(url: string): Promise<string>;
  /** The IPv4 address `host` resolves to, or null. */
  resolve(host: string): Promise<string | null>;
  myIpAddress(): string;
  now(): number;
};

/** Fetch a PAC over http(s) or read a file: URL, capped in size and time. */
export function loadPac(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    return readFile(fileURLToPath(parsed)).then((bytes) => {
      if (bytes.length > PAC_MAX_BYTES) throw new PacError("The PAC file is larger than 1 MB.");
      return bytes.toString("utf8");
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.reject(
      new PacError(`A PAC URL must be http, https or file: ${parsed.protocol}`),
    );
  }
  const get = parsed.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(parsed, { timeout: PAC_TIMEOUT_MS, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new PacError(`The PAC file at ${parsed.origin} answered ${response.statusCode}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PAC_MAX_BYTES) {
          request.destroy(new PacError("The PAC file is larger than 1 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("timeout", () =>
      request.destroy(new PacError("The PAC file did not load in time.")),
    );
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

const defaultResolverDeps: ResolverDeps = {
  loadPac,
  resolve: resolveIpv4,
  myIpAddress: firstIpv4,
  now: Date.now,
};

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
  #pacUrl: string | null = null;
  readonly #cache = new Map<string, Route[]>();
  readonly notes: string[] = [];

  constructor(config: ProxyConfig, deps: ResolverDeps = defaultResolverDeps) {
    this.config = config;
    this.#deps = deps;
  }

  /** Load the PAC, if any. Resolves whether anything but direct is possible. */
  async prepare(): Promise<boolean> {
    const { config } = this;
    const load = async (url: string): Promise<string | null> => {
      try {
        const source = await this.#deps.loadPac(url);
        this.#pac = new PacScript(source);
        this.#pacUrl = url;
        return source;
      } catch (error) {
        this.notes.push(`PAC ${url}: ${(error as Error).message}`);
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
        load,
      );
      if (found === null) this.notes.push("WPAD found no PAC file");
    }
    if (this.#pac === null && config.pacUrl !== undefined) await load(config.pacUrl);
    return this.#pac !== null || config.fixed !== undefined;
  }

  /** Where the PAC in use came from, for the debug line. */
  get pacUrl(): string | null {
    return this.#pacUrl;
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

  async #compute(url: URL): Promise<Route[]> {
    if (this.#pac !== null) {
      const host: PacHost = {
        resolve: (name) => (isIP(name) === 4 ? Promise.resolve(name) : this.#deps.resolve(name)),
        myIpAddress: this.#deps.myIpAddress(),
        now: this.#deps.now,
      };
      try {
        return parsePacResult(await this.#pac.find(url, host));
      } catch (error) {
        this.notes.push(`PAC answer for ${url.host}: ${(error as Error).message}`);
      }
    }
    return this.config.fixed ? fixedRoute(url, this.config.fixed) : [{ kind: "direct" }];
  }

  close(): void {
    this.#pac?.close();
  }
}
