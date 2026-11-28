import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { configDir } from "../../config.js";
import { FILE_LOCK_TIMEOUT, withFileLock } from "../../filelock.js";

/**
 * Serialises every read-modify-write of one agent's config files across aiand
 * processes. It never falls back to running unlocked: a run that cannot take
 * the lock fails, since interleaving is what leaves the files broken.
 * `lockWaitMs` bounds the wait; unset, a live holder is waited for.
 */
export async function withAgentConfigLock<T>(
  agent: { id: string; label: string },
  fn: () => Promise<T>,
  lockWaitMs?: number,
): Promise<T> {
  const lockPath = join(configDir(), "locks", `agent-${agent.id}`);
  const options = lockWaitMs === undefined ? {} : { acquireTimeoutMs: lockWaitMs };
  try {
    return await withFileLock(lockPath, fn, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === FILE_LOCK_TIMEOUT) {
      throw new CliError(`Another aiand run is still changing the ${agent.label} config.`, {
        hint: `Wait for it to finish, then run aiand ${agent.id} off again.`,
      });
    }
    if (code === "EISDIR" || code === "ENOTDIR") {
      throw new CliError(`Cannot take the ${agent.label} config lock: ${lockPath} is not a file.`, {
        hint: `Remove ${lockPath}, then try again.`,
      });
    }
    throw error;
  }
}
