import { type Bridge, startBridge } from "./forwarder.js";
import type { ProxyCredentials } from "./proxy-auth.js";
import { systemCurl } from "./proxy-auth.js";
import { hasProxySettings } from "./proxy-config.js";
import { ProxyResolver, type ResolverDeps } from "./resolver.js";
import { type DiscoveryDeps, defaultDiscoveryDeps, discoverProxyConfig } from "./system-proxy.js";

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
  discovery?: DiscoveryDeps;
  resolverDeps?: ResolverDeps;
  curl?: string | null;
}): Promise<SystemBridge | null> {
  const config = await discoverProxyConfig(
    options.discovery ?? defaultDiscoveryDeps(options.env, options.platform),
  ).catch(() => null);
  if (config === null || !hasProxySettings(config)) return null;
  const resolver = new ProxyResolver(config, options.resolverDeps);
  const active = await resolver.prepare();
  const log = options.log ?? (() => {});
  for (const note of resolver.notes) log(note);
  if (!active) {
    resolver.close();
    return null;
  }
  const bridge = await startBridge({
    routes: (url) => resolver.routes(url),
    auth: {
      platform: options.platform,
      curl: options.curl === undefined ? systemCurl(options.platform, options.env) : options.curl,
      credentials: proxyCredentials(options.env),
    },
    log,
  });
  const how = resolver.pacUrl !== null ? `PAC ${resolver.pacUrl}` : "fixed proxy";
  return {
    bridge,
    describe: `Proxy: ${config.source} (${how}), through aiand's loopback bridge`,
    close: async () => {
      resolver.close();
      await bridge.close();
    },
  };
}
