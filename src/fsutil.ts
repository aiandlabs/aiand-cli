import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./cli/errors.js";
import { systemToolEnv } from "./cli/spawn-env.js";
import { windowsSystemTool } from "./cli/win-spawn.js";

/**
 * Config paths, containment checks, and the atomic writer, shared by config,
 * secrets, and the adapters. A leaf module: it imports nothing from the
 * project but the error type and spawn helpers under `cli/`, so config and secrets
 * import from here instead of each other.
 */

/** Owner-only read/write: config, credentials, secrets, and agent configs we write. */
export const PRIVATE_FILE_MODE = 0o600;
/** Owner-only directory: the config dir and snapshot dirs. */
export const PRIVATE_DIR_MODE = 0o700;
/** What a file we lock to 0600 goes back to when we cannot tell what it had. */
export const DEFAULT_FILE_MODE = 0o644;

/**
 * Run a helper tool with stdin piped and stdout captured. A secret, when
 * there is one, rides `input` only: argv and the environment are readable by
 * other processes of the same user for the child's lifetime.
 */
export async function runTool(
  cmd: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): Promise<{ code: number | null; stdout: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
  }>();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: systemToolEnv(),
    windowsHide: true,
  });
  // Not spawn's own `timeout`: its timer outlives a spawn that fails with
  // ENOENT and holds the process open for the full timeout.
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout });
  });
  // A fast-exiting tool (broken dbus, PATH shim) closes stdin before the write
  // lands: without this listener that EPIPE is an unhandled crash, not a
  // fallback to the next storage tier.
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  return promise;
}

const WINDOWS_TOOL_TIMEOUT_MS = 10_000;
let ownerPrincipal: Promise<string | null> | undefined;
const restrictedDirs = new Set<string>();
// Paths whose last owner-only restriction failed in this process. Persisted
// by saveCredential so `status`, which writes nothing, can still tell.
const unrestricted = new Set<string>();

/**
 * Forget the owner principal and every restriction this process recorded, so
 * the next restrictToOwner asks whoami and icacls again. Tests that stub those
 * tools use it: on a real Windows host an earlier write has already cached the
 * real user's SID.
 */
export function resetOwnerRestriction(): void {
  ownerPrincipal = undefined;
  restrictedDirs.clear();
  unrestricted.clear();
}

/** True when an owner-only ACL could not be applied to something this run wrote. Always false off Windows. */
export const ownerRestrictionFailed = (): boolean => unrestricted.size > 0;

/** `*<SID>` for icacls, or DOMAIN\user when whoami cannot answer; once per process. */
function currentUserPrincipal(): Promise<string | null> {
  ownerPrincipal ??= runTool(
    windowsSystemTool("whoami.exe", process.env),
    ["/user", "/fo", "csv", "/nh"],
    { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS },
  )
    .then((result) =>
      result.code === 0 ? result.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0] : undefined,
    )
    .catch(() => undefined)
    .then((sid) => {
      if (sid) return `*${sid}`;
      const user = process.env.USERNAME;
      if (!user) return null;
      return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    });
  return ownerPrincipal;
}

/**
 * Windows ignores the 0600/0700 modes the rest of this module sets, so a
 * file or dir holding the key gets an owner-only DACL instead: inherited
 * entries (Users, Administrators, SYSTEM) are dropped and the current user
 * alone has full control. A dir's grant is inheritable, so what is created
 * in it afterwards is owner-only from its first byte; restrict a dir before
 * writing into it. No-op off Windows. Best-effort: a failure leaves the
 * inherited ACL and is reported only under AIAND_DEBUG=1.
 */
export async function restrictToOwner(
  path: string,
  options: { dir?: boolean } = {},
): Promise<void> {
  if (process.platform !== "win32") return;
  if (restrictedDirs.has(path)) return;
  try {
    const isDir = options.dir ?? (await stat(path)).isDirectory();
    const principal = await currentUserPrincipal();
    if (!principal) throw new Error("the current user is unknown");
    const result = await runTool(
      windowsSystemTool("icacls.exe", process.env),
      [path, "/inheritance:r", "/grant:r", `${principal}:${isDir ? "(OI)(CI)F" : "F"}`],
      { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new Error(`icacls exited ${result.code}`);
    unrestricted.delete(path);
    if (isDir) restrictedDirs.add(path);
  } catch (error) {
    unrestricted.add(path);
    if (process.env.AIAND_DEBUG === "1") {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Warning: could not restrict ${path} to its owner: ${reason}\n`);
    }
  }
}

/**
 * Create the config dir and, on Windows, resolve the current user and restrict
 * the dir to them. Run it before taking a lock that guards a write there: the
 * whoami and icacls starts it makes can take 10 s each on a cold machine, and a
 * waiter calls a lock stale long before that. After it, writeFileAtomic into
 * this dir spawns nothing.
 */
export async function prepareConfigDir(): Promise<void> {
  const dir = configDir();
  try {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    // The write that follows reports a path it cannot use, in its own words.
    return;
  }
  await chmod(dir, PRIVATE_DIR_MODE).catch(() => {});
  await restrictToOwner(dir, { dir: true });
}

export function configDir(): string {
  if (process.env.AIAND_CONFIG_DIR) return process.env.AIAND_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "aiand") : join(homedir(), ".config", "aiand");
}

/**
 * The HOME agents resolve their config from. Tests point this at a temp dir
 * so adapters never touch the real user HOME; it also lets a user scope
 * wiring (e.g. `AIAND_HOME=/mnt/c/Users/me`) when they want it.
 */
export function agentHome(): string {
  return process.env.AIAND_HOME || homedir();
}

async function resolveForConfigCheck(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    return null;
  }
}

/**
 * Pure containment predicate behind `isUnderConfigDir`. On win32,
 * `relative('C:\\cfg', 'D:\\other')` returns the absolute `D:\other`
 * (no `..` prefix), so an absolute `rel` must also reject — otherwise
 * `writeFileAtomic` would chmod 0700 a foreign drive. The `pathImpl`
 * parameter exists only so tests can exercise win32 semantics on POSIX.
 */
export function pathIsInside(
  root: string,
  target: string,
  pathImpl: {
    relative: (from: string, to: string) => string;
    isAbsolute: (p: string) => boolean;
  } = { relative, isAbsolute },
): boolean {
  if (target === root) return true;
  const rel = pathImpl.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

async function isUnderConfigDir(dir: string): Promise<boolean> {
  const root = await resolveForConfigCheck(configDir());
  if (root === null) return false;
  const target = await resolveForConfigCheck(dir);
  if (target === null) return false;
  return pathIsInside(root, target);
}

export async function existingFileMode(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** How often a holder touches its lock while `fn` runs. */
const LOCK_HEARTBEAT_MS = 5_000;
/**
 * How long a live holder may leave its lock untouched before it counts as hung.
 * Far above the heartbeat: a holder inside a 20 s PowerShell start or a stalled
 * network call is slow, not dead, and stealing from it lets two processes
 * rotate one refresh token, which the server reads as theft.
 */
const LOCK_HUNG_MS = 5 * 60_000;
/** A lock with no readable pid is probably mid-creation (open, then write). */
const LOCK_UNREADABLE_GRACE_MS = 5_000;

export type FileLockOptions = {
  heartbeatMs?: number;
  hungMs?: number;
  unreadableGraceMs?: number;
};

function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const missingAsNull = (error: unknown): null => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
};

/** A steal takes milliseconds: a guard older than this belongs to a hung stealer. */
const STEAL_GUARD_MS = 10_000;

/**
 * Remove the stale lock holding `text`. Stealers take turns through a guard
 * file, and each re-judges the lock under it: judging first and removing later
 * lets a slow stealer delete the fresh lock a faster one has just created
 * (renaming it away and putting it back leaves a gap in which a third process
 * takes the name, and two holders run). A live holder only releases a lock it
 * owns, and a dead one never does, so under the guard the lock cannot change
 * between the re-check and the unlink. Returns false when it stole nothing.
 */
async function stealLock(lockPath: string, text: string, isStale: StaleCheck): Promise<boolean> {
  const guard = `${lockPath}.steal`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(guard, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    await clearDeadGuard(guard);
    return false;
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    const [current, info] = await Promise.all([
      readFile(lockPath, "utf8").catch(missingAsNull),
      stat(lockPath).catch(missingAsNull),
    ]);
    if (current !== text || info === null || !isStale(current, info.mtimeMs)) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  } finally {
    await handle.close().catch(() => {});
    await unlink(guard).catch(() => {});
  }
}

/** A guard whose stealer died, or hung past STEAL_GUARD_MS, would block every steal for good. */
async function clearDeadGuard(guard: string): Promise<void> {
  const [text, info] = await Promise.all([
    readFile(guard, "utf8").catch(() => null),
    stat(guard).catch(() => null),
  ]);
  if (info === null) return;
  const pid = Number(text);
  const dead = pid > 0 ? !holderAlive(pid) : false;
  if (dead || Date.now() - info.mtimeMs > STEAL_GUARD_MS) await unlink(guard).catch(() => {});
}

type StaleCheck = (text: string, mtimeMs: number) => boolean;

/** Runs `fn` while holding `lockPath`, so two aiand processes never run it at once. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const hungMs = options.hungMs ?? LOCK_HUNG_MS;
  const unreadableGraceMs = options.unreadableGraceMs ?? LOCK_UNREADABLE_GRACE_MS;
  // Codex SIGKILLs a slow auth command, so a dead holder is common. A live
  // one is waited for: only a long silence (no heartbeat) marks it hung.
  const isStale: StaleCheck = (text, mtimeMs) => {
    const pid = Number(text);
    const age = Date.now() - mtimeMs;
    return pid > 0 ? !holderAlive(pid) || age > hungMs : age > unreadableGraceMs;
  };
  await mkdir(dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock that vanishes between the open and these reads is not stale, it
      // is free: judging it by a missing mtime would delete the next holder's.
      const [text, info] = await Promise.all([
        readFile(lockPath, "utf8").catch(missingAsNull),
        stat(lockPath).catch(missingAsNull),
      ]);
      if (text === null || info === null) continue;
      if (!isStale(text, info.mtimeMs) || !(await stealLock(lockPath, text, isStale))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only a lock still ours: one stolen from a hung run and retaken is not.
    if ((await readFile(lockPath, "utf8").catch(() => null)) === String(process.pid)) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Temp file in the same directory, then rename over the target, so readers
 * (OpenCode loading opencode.json) never see a truncated file. Follows
 * symlinks to the real file so stow/chezmoi links survive. Without `mode`, the
 * target's existing permissions are kept rather than the umask default.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(filePath);
  try {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    // A file squatting where a directory belongs: POSIX says ENOTDIR here,
    // Windows EEXIST, and the same read that would have caught it first sees
    // ENOENT there, so this is the only place a Windows run learns of it.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTDIR") throw error;
    throw new CliError(`Cannot write ${filePath}: a parent path is not a directory.`, {
      hint: "Remove or rename the file blocking the path, then try again.",
    });
  }
  // mkdir mode only covers newly created dirs — tighten our own config tree
  // best-effort; never chmod third-party dirs (e.g. ~/.config/opencode).
  if (await isUnderConfigDir(dir)) {
    await chmod(dir, PRIVATE_DIR_MODE).catch(() => {});
    await restrictToOwner(dir, { dir: true });
  }
  // Follow the whole symlink chain so rename(2) lands on the real file
  // instead of replacing the link. Only ENOENT falls back to filePath:
  // a fresh path isn't a symlink, and replacing a broken link with the
  // regular file is the correct recovery. Any other error (EACCES, ELOOP)
  // fails closed — a fallback there could rename over a symlink we could
  // not resolve.
  let real = filePath;
  try {
    real = await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const realDir = dirname(real);
  const targetMode = options.mode ?? (await existingFileMode(real));
  const tempPath = join(realDir, `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tempPath, "w", targetMode ?? PRIVATE_FILE_MODE);
    try {
      // Before the first byte, so the key is never readable under the
      // parent's inherited ACL; rename keeps the DACL.
      // A dir restricted this run hands its owner-only DACL to what is created in it.
      if (options.mode === PRIVATE_FILE_MODE && !restrictedDirs.has(realDir)) {
        await restrictToOwner(tempPath, { dir: false });
      }
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, real);
    // rename is atomic but not durable: flush the file before (handle.sync
    // above) and the directory entry after, so a crash cannot lose the write.
    if (process.platform !== "win32") {
      // Best-effort: some filesystems (network mounts) reject directory
      // fsync with EINVAL — skip durability there rather than fail the write.
      try {
        const dirFd = await open(realDir, "r");
        try {
          await dirFd.sync();
        } finally {
          await dirFd.close();
        }
      } catch {
        // durability unavailable on this filesystem
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  if (targetMode !== undefined) {
    await chmod(real, targetMode);
  }
}
