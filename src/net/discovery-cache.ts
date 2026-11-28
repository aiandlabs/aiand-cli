import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_MARKER_FILE } from "../config-files.js";
import { configDir, PRIVATE_FILE_MODE } from "../fsutil.js";
import type { ProxyConfig } from "./proxy-config.js";
import type { ResolverState } from "./resolver.js";

/**
 * The outcome of proxy discovery (the settings read, the PAC found by WPAD
 * or configured, or "direct"), kept for a few minutes so a run of commands
 * reads the registry and fetches the PAC once. It is keyed by the machine's
 * network addresses and the PAC setting, so joining another network or
 * changing AIAND_PROXY_PAC reads the settings afresh. It holds no
 * credential: proxy passwords and sign-in tokens are never written.
 */

const CACHE_FILE = "proxy-discovery.json";
export const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export type CachedDiscovery = { config: ProxyConfig | null; state: ResolverState | null };

/** What the cached result depends on: the OS, the PAC setting and the networks this machine is on. */
export function discoveryKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => `${entry.address}/${entry.netmask}`)
    .sort();
  const input = JSON.stringify([1, platform, env.AIAND_PROXY_PAC ?? "", addresses]);
  return createHash("sha256").update(input).digest("hex");
}

function isState(value: unknown): value is ResolverState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const optionalString = (v: unknown): boolean => v === null || typeof v === "string";
  return (
    optionalString(state.pacUrl) &&
    optionalString(state.pacSource) &&
    typeof state.fromWpad === "boolean" &&
    typeof state.myIp === "string" &&
    optionalString(state.pacFailure ?? null)
  );
}

/**
 * A cached config may name only PAC and WPAD outcomes, never a fixed proxy:
 * a fixed proxy is cheap to read again from settings, and a cache that
 * could name one would let whoever writes the file pick the proxy.
 */
function isConfig(value: unknown): value is ProxyConfig {
  if (value === null || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.source === "string" &&
    typeof config.autoDetect === "boolean" &&
    config.fixed === undefined
  );
}

export class DiscoveryCache {
  readonly #path: string;
  readonly #now: () => number;

  constructor(path: string = join(configDir(), CACHE_FILE), now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  /** The cached result for `key`, or undefined when there is none, it is stale, or it is unreadable. */
  async read(key: string): Promise<CachedDiscovery | undefined> {
    if (!(await this.#usable())) return undefined;
    try {
      // Only a plain file this user owns: never a link, never someone else's.
      const stats = await lstat(this.#path);
      if (!stats.isFile()) return undefined;
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return undefined;
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Record<string, unknown>;
      const at = parsed.at;
      if (parsed.key !== key || typeof at !== "number") return undefined;
      const age = this.#now() - at;
      if (age < 0 || age > DISCOVERY_TTL_MS) return undefined;
      const config =
        parsed.config === null ? null : isConfig(parsed.config) ? parsed.config : undefined;
      const state = parsed.state === null ? null : isState(parsed.state) ? parsed.state : undefined;
      if (config === undefined || state === undefined) return undefined;
      return { config, state };
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the cache may be used here at all, for reading as for writing:
   * only in a config dir aiand already made (it
   * holds config.json or aiand's marker) and that is not in a git work tree:
   * the cache never creates a dir, never lands in one aiand cannot prove is
   * its own, and never sits where it could be committed. A cache found
   * anywhere else is ignored, so a planted one cannot choose the proxy.
   */
  async #usable(): Promise<boolean> {
    const dir = dirname(this.#path);
    // A config dir reached through a link of its own gets no cache: the file
    // would land wherever the link points.
    if ((await lstat(dir).catch(() => null))?.isSymbolicLink() !== false) return false;
    const owned = await Promise.all(
      ["config.json", CONFIG_MARKER_FILE].map((name) =>
        stat(join(dir, name)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!owned.includes(true)) return false;
    const { gitWorkTreeFor } = await import("../agents/managed-file.js");
    return (await gitWorkTreeFor(this.#path).catch(() => null)) === null;
  }

  /** Keep `value` for `key`, where #usable allows. */
  async write(key: string, value: CachedDiscovery): Promise<void> {
    if (value.config?.fixed !== undefined) return;
    if (!(await this.#usable())) return;
    const state = value.state === null ? null : { ...value.state, pacFailure: null };
    const text = JSON.stringify({ key, at: this.#now(), config: value.config, state });
    // Not writeFileAtomic: it follows a link at the path (for dotfile
    // managers) and would write through it. A new file and a rename replace
    // whatever is at the path, a link included, and touch nothing else.
    const temp = join(dirname(this.#path), `.${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temp, text, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      await rename(temp, this.#path);
    } catch {
      await unlink(temp).catch(() => {});
    }
  }
}
