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
  return {
    cmd: opts.execPath,
    args: [...startupArgs(opts.execArgv), ...opts.execArgv, ...opts.argv.slice(1)],
    env: { ...env, NODE_USE_ENV_PROXY: "1", [RELAUNCH_MARKER]: "1" },
  };
}

const QUIET_EHPA = "--disable-warning=UNDICI-EHPA";

function startupArgs(execArgv: string[]): string[] {
  const args = [];
  if (!execArgv.includes("--use-system-ca")) args.push("--use-system-ca");
  if (!execArgv.includes(QUIET_EHPA)) args.push(QUIET_EHPA);
  return args;
}

/**
 * Whether to look for system proxy settings: only when no proxy variable is
 * set (those win) and this is not already a relaunched process.
 */
export function wantsSystemProxy(env: NodeJS.ProcessEnv): boolean {
  return configuredProxy(env) === undefined && env[RELAUNCH_MARKER] !== "1";
}

/**
 * The relaunch that sends this process's requests, and those of every agent
 * it starts, through the loopback bridge at `bridgeUrl`. A single executable
 * re-applies its own startup flags, so it gets only the user's arguments.
 */
export function bridgeRelaunchPlan(opts: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: string[];
  argv: string[];
  sea: boolean;
  /**
   * The name the program was started as. A single executable's argv repeats
   * it after the executable path (`[path, argv0, ...args]`); without it the
   * user's arguments are taken to start at argv[1].
   */
  argv0?: string;
  platform: NodeJS.Platform;
  bridgeUrl: string;
  bridgeMarker: string;
  dropVars: readonly string[];
}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const fold = (name: string): string => (opts.platform === "win32" ? name.toUpperCase() : name);
  const drop = new Set([...opts.dropVars, ...PROXY_VARS].map(fold));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(opts.env)) {
    if (!drop.has(fold(name))) env[name] = value;
  }
  // Windows folds the case of names: one spelling each, or the block holds duplicates.
  const names = opts.platform === "win32" ? ["HTTPS_PROXY", "HTTP_PROXY"] : PROXY_VARS;
  for (const name of names) env[name] = opts.bridgeUrl;
  Object.assign(env, { NODE_USE_ENV_PROXY: "1", [RELAUNCH_MARKER]: "1", [opts.bridgeMarker]: "1" });
  // The bridge only tunnels, so the relaunch keeps the trusted roots this
  // process started with: no --use-system-ca here.
  const quiet = opts.execArgv.includes(QUIET_EHPA) ? [] : [QUIET_EHPA];
  const seaArgs = opts.argv.slice(opts.argv0 !== undefined && opts.argv[1] === opts.argv0 ? 2 : 1);
  const args = opts.sea ? seaArgs : [...quiet, ...opts.execArgv, ...opts.argv.slice(1)];
  return { cmd: opts.execPath, args, env };
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
