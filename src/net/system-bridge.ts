import { DiscoveryCache, discoveryKey } from "./discovery-cache.js";
import { type Bridge, startBridge } from "./forwarder.js";
import type { ProxyCredentials } from "./proxy-auth.js";
import { systemCurl } from "./proxy-auth.js";
import { hasProxySettings, type ProxyConfig } from "./proxy-config.js";
import { ProxyResolver, type ResolverDeps } from "./resolver.js";
import {
  type DiscoveryDeps,
  defaultDiscoveryDeps,
  discoverProxyConfig,
  SYSTEM_PROXY_SWITCH,
} from "./system-proxy.js";

/** Set in the relaunched CLI (and so in every agent it starts) while the bridge carries its traffic. */
export const BRIDGE_MARKER = "AIAND_PROXY_BRIDGE";
/** Proxy credentials for Basic, or NTLM away from Windows: read once, never passed on. */
export const PROXY_USER_VAR = "AIAND_PROXY_USERNAME";
export const PROXY_PASSWORD_VAR = "AIAND_PROXY_PASSWORD";

/**
 * `env` for a detached child that may outlive this command (a browser): the
 * bridge goes away with the command, so its proxy variables are dropped.
 */
export function withoutBridge(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[BRIDGE_MARKER] !== "1") return env;
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^(?:https?_proxy|aiand_proxy_bridge)$/i.test(name)) next[name] = value;
  }
  return next;
}

export function proxyCredentials(env: NodeJS.ProcessEnv): ProxyCredentials | null {
  const username = env[PROXY_USER_VAR];
  const password = env[PROXY_PASSWORD_VAR];
  return username ? { username, password: password ?? "" } : null;
}

/**
 * Run `relaunch` (start the bridge and relaunch through it); a failure is
 * not fatal: the command runs without the bridge, after one plain line.
 */
export async function bridgeOrWarn(
  relaunch: () => Promise<boolean>,
  warn: (line: string) => void,
): Promise<boolean> {
  try {
    return await relaunch();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(
      `aiand could not use the proxy from your system settings (${reason}); continuing without it.`,
    );
    return false;
  }
}

export type SystemBridge = {
  bridge: Bridge;
  /** One line on where the settings came from, for AIAND_DEBUG. */
  describe: string;
  close(): Promise<void>;
};

/**
 * Read the system proxy settings and, when they route anything through a
 * proxy, start the bridge for them. Null when the network is direct (no
 * settings, or WPAD that found nothing), so most machines pay for one
 * settings read and nothing else.
 */
export async function startSystemBridge(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  log?: (line: string) => void;
  /** A failure the user should see without AIAND_DEBUG, in plain words. */
  warn?: (line: string) => void;
  discovery?: DiscoveryDeps;
  resolverDeps?: ResolverDeps;
  curl?: string | null;
  /** Null turns the discovery cache off. */
  cache?: DiscoveryCache | null;
}): Promise<SystemBridge | null> {
  if (options.env[SYSTEM_PROXY_SWITCH] === "0") return null;
  const log = options.log ?? (() => {});
  let cache: DiscoveryCache | null = null;
  try {
    cache = options.cache === undefined ? new DiscoveryCache() : options.cache;
  } catch {
    cache = null;
  }
  const key = discoveryKey(options.env, options.platform);
  const cached = await cache?.read(key);
  let config: ProxyConfig | null;
  let resolver: ProxyResolver | null = null;
  if (cached !== undefined) {
    log("using the proxy settings read in the last few minutes");
    config = cached.config;
    if (config !== null && cached.state !== null) {
      resolver = new ProxyResolver(config, options.resolverDeps);
      resolver.restore(cached.state);
    }
  } else {
    config = await discoverProxyConfig(
      options.discovery ?? defaultDiscoveryDeps(options.env, options.platform),
    ).catch(() => null);
    if (config !== null && !hasProxySettings(config)) config = null;
    if (config !== null) {
      resolver = new ProxyResolver(config, options.resolverDeps);
      await resolver.prepare();
      for (const note of resolver.notes) log(note);
      const failure = resolver.state.pacFailure;
      if (failure !== null) options.warn?.(failure);
    }
    await cache?.write(key, { config, state: resolver?.state ?? null });
  }
  if (config === null || resolver === null || !resolver.active) {
    resolver?.close();
    return null;
  }
  const routes = resolver;
  const bridge = await startBridge({
    routes: (url) => routes.routes(url),
    auth: {
      platform: options.platform,
      curl: options.curl === undefined ? systemCurl(options.platform, options.env) : options.curl,
      credentials: proxyCredentials(options.env),
    },
    log,
  });
  const how = routes.pacUrl !== null ? `PAC ${routes.pacUrl}` : "fixed proxy";
  return {
    bridge,
    describe: `Proxy: ${config.source} (${how}), through aiand's loopback bridge`,
    close: async () => {
      routes.close();
      await bridge.close();
    },
  };
}
