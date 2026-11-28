// Node reads NODE_USE_ENV_PROXY only at startup, so enabling env proxies requires a relaunch.

export const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
export const RELAUNCH_MARKER = "AIAND_PROXY_RELAUNCHED";

function configuredProxy(env: NodeJS.ProcessEnv): (typeof PROXY_VARS)[number] | undefined {
  return PROXY_VARS.find((name) => env[name] !== undefined && env[name] !== "");
}

export function nodeSupportsEnvProxy(version: string): boolean {
  const match = /^v(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 21);
}

export function relaunchPlan(opts: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: string[];
  argv: string[];
  version: string;
}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  const { env } = opts;
  if (
    configuredProxy(env) === undefined ||
    env.NODE_USE_ENV_PROXY === "1" ||
    env[RELAUNCH_MARKER] === "1" ||
    !nodeSupportsEnvProxy(opts.version)
  ) {
    return null;
  }
  const startupArgs = [];
  if (!opts.execArgv.includes("--use-system-ca")) startupArgs.push("--use-system-ca");
  if (!opts.execArgv.includes("--disable-warning=UNDICI-EHPA")) {
    startupArgs.push("--disable-warning=UNDICI-EHPA");
  }
  return {
    cmd: opts.execPath,
    args: [...startupArgs, ...opts.execArgv, ...opts.argv.slice(1)],
    env: { ...env, NODE_USE_ENV_PROXY: "1", [RELAUNCH_MARKER]: "1" },
  };
}

export function proxyDebugLine(env: NodeJS.ProcessEnv): string | null {
  if (env.AIAND_DEBUG !== "1") return null;
  const name = configuredProxy(env);
  return name === undefined ? null : `Proxy: ${name}; system CAs: on`;
}

export function proxyUnsupportedWarning(env: NodeJS.ProcessEnv, version: string): string | null {
  const name = configuredProxy(env);
  if (name === undefined || env.NODE_USE_ENV_PROXY === "1" || nodeSupportsEnvProxy(version)) {
    return null;
  }
  return `A proxy is set (${name}), but Node ${version} can't send requests through it. Install Node 22.21 or later.`;
}

/**
 * Whether the relaunching parent passes SIGINT on to the child. A terminal's Ctrl-C
 * already reaches the child, which shares the terminal's process group; passing it on
 * as well reads as a second Ctrl-C, and some agents (Claude Code) exit on that.
 */
export function forwardsInterrupt(stdinIsTerminal: boolean): boolean {
  return !stdinIsTerminal;
}
