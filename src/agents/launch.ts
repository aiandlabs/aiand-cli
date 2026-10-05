import { type ChildProcess, spawn } from "node:child_process";
import { CliError, EXIT } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import type { AgentAdapter } from "./types.js";

export function installCommand(adapter: AgentAdapter): string {
  return `npm install -g ${adapter.install.package}`;
}

export function notInstalledError(adapter: AgentAdapter): CliError {
  return new CliError(`${adapter.label} is not installed.`, {
    exitCode: EXIT.NOT_FOUND,
    hint: `Install it with: ${installCommand(adapter)}\nSee: ${adapter.install.url}`,
  });
}

export async function installIfMissing(adapter: AgentAdapter): Promise<void> {
  if (adapter.detect().installed) return;
  if (!isInteractive()) throw notInstalledError(adapter);
  const command = installCommand(adapter);
  const prompt = `${adapter.label} is not installed. Install it with ${command}?`;
  if (!(await confirm(prompt, { default: true }))) {
    throw notInstalledError(adapter);
  }

  const failed = (reason: string): CliError =>
    new CliError(`Installing ${adapter.label} failed: ${reason}.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: `Install it yourself with: ${command}\nSee: ${adapter.install.url}`,
    });
  const npm = await spawnChild("npm", ["install", "-g", adapter.install.package], {
    stdio: "inherit",
  }).catch((error: Error) => ({ error }));
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
  let cleaned = false;
  const doCleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await cleanup?.();
  };
  const onSigint = (): void => {
    void doCleanup().finally(() => process.exit(EXIT.INTERRUPTED));
  };
  const onSigterm = (): void => {
    void doCleanup().finally(() => process.exit(EXIT.TERMINATED));
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const { status, signal } = await spawnChild(adapter.bin, args, { env, stdio: "inherit" });
    process.exitCode = typeof status === "number" ? status : signal ? 1 : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notInstalledError(adapter);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await doCleanup();
  }
}

function spawnChild(
  binary: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
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
  child.once("error", reject);
  child.once("exit", (status, signal) => resolve({ status, signal }));
  return promise;
}
