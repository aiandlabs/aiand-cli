import type { AgentAdapter } from "./types.js";

/**
 * What each agent does with a corporate proxy. "Opened with aiand" is the
 * path aiand controls: the agent inherits HTTPS_PROXY, HTTP_PROXY and
 * NODE_USE_ENV_PROXY pointing at aiand's loopback bridge, which does PAC,
 * WPAD and sign-in for it. The other columns are the agent started on its
 * own, after `aiand <agent> on`. They follow each agent's runtime and
 * documentation; "unverified" marks what only the enterprise test network
 * can settle, and its journeys replace this data with measured results.
 */
export type Support = "yes" | "no" | "node-flag" | "unverified";

export type ProxySupport = {
  runtime: string;
  viaAiand: Support;
  envProxy: Support;
  basicInUrl: Support;
  systemProxy: Support;
  pac: Support;
  signIn: Support;
};

const BUN: Omit<ProxySupport, "runtime"> = {
  viaAiand: "yes",
  envProxy: "yes",
  basicInUrl: "yes",
  systemProxy: "no",
  pac: "no",
  signIn: "no",
};
const NODE: Omit<ProxySupport, "runtime"> = { ...BUN, envProxy: "node-flag" };

export const PROXY_SUPPORT: Record<string, ProxySupport> = {
  opencode: { runtime: "Bun", ...BUN },
  claude: { runtime: "Bun", ...BUN },
  codex: { runtime: "Rust", ...BUN, systemProxy: "unverified" },
  pi: { runtime: "Node.js", ...NODE },
  omp: { runtime: "Bun", ...BUN },
  copilot: { runtime: "Node.js", ...BUN, envProxy: "unverified", basicInUrl: "unverified" },
  "copilot-app": {
    runtime: "Desktop app",
    viaAiand: "no",
    envProxy: "unverified",
    basicInUrl: "unverified",
    systemProxy: "unverified",
    pac: "unverified",
    signIn: "unverified",
  },
  hermes: { runtime: "Python", ...BUN, systemProxy: "unverified" },
  jouzu: { runtime: "Node.js", ...NODE },
};

/**
 * What `aiand <agent> on` says on a network whose proxy came from system
 * settings (aiand's bridge is carrying this process), or null when the agent
 * gets through on its own.
 */
export function proxyNoteForOn(
  adapter: AgentAdapter,
  env: NodeJS.ProcessEnv,
  marker: string,
): string | null {
  if (env[marker] !== "1") return null;
  const support = PROXY_SUPPORT[adapter.id];
  if (support?.pac === "yes" && support.signIn === "yes") return null;
  if (support?.viaAiand !== "yes") {
    return `aiand reaches this network's proxy for you (a PAC file, WPAD or sign-in), but the ${adapter.label} uses its own network settings and aiand cannot carry its requests. If it cannot connect, set its proxy in the app or ask your administrator.`;
  }
  return `aiand reaches this network's proxy for you (a PAC file, WPAD or sign-in), and ${adapter.label} cannot do that when started on its own. Open it with \`aiand ${adapter.id}\` so its requests go through aiand.`;
}
