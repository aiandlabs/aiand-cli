import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { CliError, EXIT } from "../cli/errors.js";
import { safeLine } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { agentPathEnv, childEnv, MASTER_KEY_VAR, scrubAgentEnv } from "../cli/spawn-env.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import { findOnPath } from "./detect.js";
import type { AgentAdapter } from "./types.js";

/**
 * Take the values of `flags` out of an agent's args, in both `--flag value`
 * and `--flag=value` forms, the way run-agent strips owned flags: a value is
 * only taken when it is not itself a flag. `keep` leaves a value (and its
 * flag) in the args.
 */
export function takeFlagValues(
  args: readonly string[],
  flags: readonly string[],
  keep: (value: string) => boolean = () => false,
): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    const next = args[i + 1];
    if (flags.includes(token) && next !== undefined && !next.startsWith("-")) {
      if (keep(next)) rest.push(token, next);
      else values.push(next);
      i += 1;
      continue;
    }
    const flag = flags.find((name) => token.startsWith(`${name}=`));
    const value = flag === undefined ? undefined : token.slice(flag.length + 1);
    if (value) {
      if (keep(value)) rest.push(token);
      else values.push(value);
      continue;
    }
    rest.push(token);
  }
  return { values, rest };
}

export function notInstalledError(adapter: AgentAdapter): CliError {
  return new CliError(`${adapter.label} is not installed.`, {
    exitCode: EXIT.NOT_FOUND,
    hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
  });
}

/** Where an administrator finds what to allow for aiand and each agent. */
export const WINDOWS_ADMIN_GUIDE =
  "https://github.com/aiandlabs/aiand-cli/blob/main/docs/it-admin-windows.md";

/**
 * The plain error for an agent Windows would not start, or null for any other
 * failure. Application control (AppLocker, App Control for Business, Software
 * Restriction Policies) refuses with ERROR_ACCESS_DISABLED_BY_POLICY (1260) or
 * an App Control violation (4551); libuv has no name for either and Node
 * reports `UNKNOWN`. EACCES and EPERM are an ACL or a policy refusing the
 * file. An agent behind an npm `.cmd` shim never gets here: cmd.exe starts,
 * prints Windows' own refusal, and exits 1.
 */
export function startRefusedError(
  adapter: Pick<AgentAdapter, "label">,
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): CliError | null {
  if (platform !== "win32") return null;
  const { code, path } = error as NodeJS.ErrnoException;
  if (code !== "UNKNOWN" && code !== "EACCES" && code !== "EPERM") return null;
  // The path is a file name from PATH or a repo, so it may carry escapes.
  const where = path ? ` (${safeLine(path)})` : "";
  return new CliError(`Windows would not start ${adapter.label}${where}.`, {
    hint: [
      "On a managed PC this is usually application control (AppLocker, App Control for Business,",
      "or a Software Restriction Policy) refusing programs in that folder. Ask IT to allow it.",
      `What aiand and each agent need: ${WINDOWS_ADMIN_GUIDE}`,
    ].join("\n"),
  });
}

export async function installIfMissing(adapter: AgentAdapter): Promise<void> {
  if (adapter.detect().installed) return;
  const { command, url } = adapter.install;
  const [bin, ...args] = command.split(" ");
  if (bin !== "npm" || !isInteractive()) throw notInstalledError(adapter);
  const prompt = `${adapter.label} is not installed. Install it with ${command}?`;
  if (!(await confirm(prompt, { default: true }))) {
    throw notInstalledError(adapter);
  }

  const failed = (reason: string): CliError =>
    new CliError(`Installing ${adapter.label} failed: ${reason}.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: `Install it yourself with: ${command}\nSee: ${url}`,
    });
  // Install scripts run third-party code: never hand them the session key.
  const env = scrubAgentEnv(process.env);
  const npm = await spawnChild(bin, args, { stdio: "inherit", env }).catch((error: Error) => ({
    error,
  }));
  if ("error" in npm) throw failed(npm.error.message);
  if (npm.status !== 0) throw failed(`npm exited with ${npm.status ?? "a signal"}`);
  if (!adapter.detect().installed) {
    throw new CliError(`${adapter.label} is installed, but ${adapter.bin} is not on your PATH.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: "Add npm's global bin directory (under `npm prefix -g`) to PATH, then run this again.",
    });
  }
}

/**
 * What an agent's child environment starts from: ours without the secrets the
 * adapter's own injection replaces. Codex alone keeps the store master key,
 * because the `aiand key export` it runs for each key fetch must decrypt the
 * file tier with it.
 */
export function agentBaseEnv(
  adapter: AgentAdapter,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return scrubAgentEnv(env, platform, { keep: adapter.id === "codex" ? [MASTER_KEY_VAR] : [] });
}

export async function runAgentBinary(
  adapter: AgentAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  cleanup?: () => Promise<void>,
): Promise<void> {
  // Ctrl+C also reaches the agent through the terminal, and agents use it in-session.
  let child: ChildProcess | undefined;
  let lateSignal: NodeJS.Signals | undefined;
  const ignore = (): void => {};
  const forward = (signal: NodeJS.Signals): void => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
    else lateSignal = signal;
  };
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.stdin.pause();

  try {
    const { status, signal } = await spawnChild(
      adapter.bin,
      args,
      { env, stdio: "inherit" },
      (c) => {
        child = c;
      },
    );
    process.exitCode =
      typeof status === "number" ? status : signal ? 128 + (constants.signals[signal] ?? 0) : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notInstalledError(adapter);
    throw startRefusedError(adapter, error) ?? error;
  } finally {
    try {
      await cleanup?.();
    } finally {
      process.removeListener("SIGINT", ignore);
      process.removeListener("SIGTERM", forward);
      process.removeListener("SIGHUP", forward);
      if (lateSignal) process.exitCode = 128 + (constants.signals[lateSignal] ?? 0);
    }
  }
}

function spawnChild(
  binary: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
  onSpawn?: (child: ChildProcess) => void,
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>();
  let child: ChildProcess;
  const env = agentPathEnv(childEnv(options.env ?? process.env));
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(binary, args, env);
    if (!resolved) {
      reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: "ENOENT" }));
      return promise;
    }
    child = spawn(resolved.command, resolved.args, {
      ...options,
      env: resolved.env ?? env,
      windowsVerbatimArguments: resolved.verbatim,
    });
  } else {
    // The path detection accepted, not the bare name: execvp would also walk
    // an empty or `.` PATH entry into the current directory.
    const resolved = findOnPath(binary);
    if (!resolved) {
      reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: "ENOENT" }));
      return promise;
    }
    child = spawn(resolved, args, { argv0: binary, ...options, env });
  }
  onSpawn?.(child);
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve({ status, signal }));
  return promise;
}
