import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { CliError, EXIT } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import type { AgentAdapter } from "./types.js";

export function notInstalledError(adapter: AgentAdapter): CliError {
  return new CliError(`${adapter.label} is not installed.`, {
    exitCode: EXIT.NOT_FOUND,
    hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
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
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
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

export async function runAgentBinary(
  adapter: AgentAdapter,
  args: string[],
  env: NodeJS.ProcessEnv,
  cleanup?: () => Promise<void>,
): Promise<void> {
  // Like a shell's foreground job: Ctrl+C reaches the agent through the
  // terminal, and agents use it in-session (Claude Code clears its input), so
  // the launcher ignores it. SIGTERM and SIGHUP go to the agent. Cleanup runs
  // only once the agent has exited, so it never pulls an overlay out from
  // under a live session.
  let child: ChildProcess | undefined;
  const ignore = (): void => {};
  const forward = (signal: NodeJS.Signals): void => {
    child?.kill(signal);
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
    throw error;
  } finally {
    process.removeListener("SIGINT", ignore);
    process.removeListener("SIGTERM", forward);
    process.removeListener("SIGHUP", forward);
    await cleanup?.();
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
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(binary, args, options.env ?? process.env);
    if (!resolved) {
      reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: "ENOENT" }));
      return promise;
    }
    child = spawn(resolved.command, resolved.args, {
      ...options,
      windowsVerbatimArguments: resolved.verbatim,
    });
  } else {
    child = spawn(binary, args, options);
  }
  onSpawn?.(child);
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve({ status, signal }));
  return promise;
}
