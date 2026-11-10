import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError } from "./cli/errors.js";
import { systemToolEnv } from "./cli/spawn-env.js";
import { windowsSystemTool } from "./cli/win-spawn.js";
import { CONFIG_MARKER_FILE, mayMarkConfigDir } from "./config-files.js";

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

interface WindowsUser {
  /** `*<SID>` for icacls, or DOMAIN\\user when whoami cannot answer. */
  principal: string;
  /** What icacls prints for this user's own entry: DOMAIN\\user, or the SID. */
  names: string[];
}

let ownerPrincipal: Promise<WindowsUser | null> | undefined;
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

/**
 * True when an owner-only ACL could not be applied to one of `paths`. Asked
 * about the paths a caller wrote, not the process: an unrelated overlay or
 * snapshot dir that failed earlier says nothing about the credential file.
 * Always false off Windows.
 */
export const ownerRestrictionFailedFor = (paths: string[]): boolean =>
  paths.some((path) => unrestricted.has(path));

/** Who is running, as icacls spells them; once per process. */
function currentUser(): Promise<WindowsUser | null> {
  ownerPrincipal ??= runTool(
    windowsSystemTool("whoami.exe", process.env),
    ["/user", "/fo", "csv", "/nh"],
    { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS },
  )
    .then((result) => {
      if (result.code !== 0) return undefined;
      const sid = result.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      const name = result.stdout.match(/^\s*"([^"]+)"/)?.[1];
      return sid ? { sid, name } : undefined;
    })
    .catch(() => undefined)
    .then((found): WindowsUser | null => {
      if (found) {
        return {
          principal: `*${found.sid}`,
          names: [found.sid, ...(found.name ? [found.name] : [])].map((n) => n.toLowerCase()),
        };
      }
      const user = process.env.USERNAME;
      if (!user) return null;
      const name = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
      return { principal: name, names: [name.toLowerCase()] };
    });
  return ownerPrincipal;
}

/**
 * The principals `icacls <path>` lists, in the spelling icacls takes back. The
 * first line starts with the path as given; the rest are indented.
 */
function listedPrincipals(output: string, path: string): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") break;
    const entry = (line.startsWith(path) ? line.slice(path.length) : line).trim();
    const at = entry.indexOf(":(");
    if (at > 0) found.push(entry.slice(0, at));
  }
  return found;
}

/**
 * Windows ignores the 0600/0700 modes the rest of this module sets, so a
 * file or dir holding the key gets an owner-only DACL instead: the current
 * user alone has full control and every other entry is gone. A dir's grant is
 * inheritable, so what is created in it afterwards is owner-only from its
 * first byte; restrict a dir before writing into it. No-op off Windows.
 *
 * `/inheritance:r` drops only entries marked inherited, and `/grant:r`
 * replaces only the named user's own entry. Entries another user or a group
 * holds directly (a dir made by an elevated process, or one a person edited)
 * would survive both, so the entries are listed afterwards and each remaining
 * principal is removed. A handle opened before this call keeps the access it
 * was granted then; Windows checks the DACL only at open.
 *
 * Best-effort: a failure leaves the ACL as it was and is recorded for
 * `ownerRestrictionFailedFor`, and reported under AIAND_DEBUG=1. `recordAs`
 * names the path a failure is recorded against when it differs from `path`,
 * as for a temp file about to be renamed over the real one. Resolves false
 * on failure.
 */
export async function restrictToOwner(
  path: string,
  options: { dir?: boolean; recordAs?: string } = {},
): Promise<boolean> {
  if (process.platform !== "win32") return true;
  if (restrictedDirs.has(path)) return true;
  const record = options.recordAs ?? path;
  try {
    const isDir = options.dir ?? (await stat(path)).isDirectory();
    const user = await currentUser();
    if (!user) throw new Error("the current user is unknown");
    const icacls = windowsSystemTool("icacls.exe", process.env);
    const run = (args: string[]) => runTool(icacls, args, { timeoutMs: WINDOWS_TOOL_TIMEOUT_MS });
    const granted = await run([
      path,
      "/inheritance:r",
      "/grant:r",
      `${user.principal}:${isDir ? "(OI)(CI)F" : "F"}`,
    ]);
    if (granted.code !== 0) throw new Error(`icacls exited ${granted.code}`);
    const listed = await run([path]);
    if (listed.code !== 0) throw new Error(`icacls exited ${listed.code} listing the ACL`);
    const others = listedPrincipals(listed.stdout, path).filter(
      (name) => !user.names.includes(name.toLowerCase()),
    );
    if (others.length > 0) {
      const removed = await run([
        path,
        ...others.flatMap((name) => ["/remove", /^S-1-/.test(name) ? `*${name}` : name]),
      ]);
      if (removed.code !== 0) throw new Error(`icacls exited ${removed.code} removing entries`);
    }
    unrestricted.delete(record);
    if (isDir) restrictedDirs.add(path);
    return true;
  } catch (error) {
    unrestricted.add(record);
    if (process.env.AIAND_DEBUG === "1") {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Warning: could not restrict ${path} to its owner: ${reason}\n`);
    }
    return false;
  }
}

/**
 * A throwaway dir under the temp dir that only the current user can open, for
 * what a launched agent reads a key from. On Windows the temp dir may let
 * others create entries, so the dir is restricted before anything is written
 * and must still be empty after: an entry another user planted while it
 * carried the inherited ACL, including a file they hold open, is refused
 * rather than written through. A dir that cannot be restricted is refused too. Once the DACL is owner-only nobody else can add
 * one, so the files written into it afterwards are ours alone; create them
 * with flag "wx". The caller removes the dir.
 */
export async function makePrivateTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    // Fails closed: a dir that could not be restricted keeps the ACL it
    // inherited, and the key would be written under it.
    const restricted = await restrictToOwner(dir, { dir: true });
    if (!restricted || (process.platform === "win32" && (await readdir(dir)).length > 0)) {
      throw new CliError(
        "A temporary directory for the agent was not private; nothing was written.",
        {
          hint: "Try again; if it repeats, point TEMP at a directory only you can use.",
        },
      );
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
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
 * Pure containment predicate behind `configRootContaining`. On win32,
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

/** The config dir's real path when `dir` is inside it, else null. */
async function configRootContaining(dir: string): Promise<string | null> {
  const root = await resolveForConfigCheck(configDir());
  if (root === null) return null;
  const target = await resolveForConfigCheck(dir);
  if (target === null) return null;
  return pathIsInside(root, target) ? root : null;
}

/**
 * Proof that a directory is aiand's own: `logout --all` deletes by name, so
 * a mistyped AIAND_CONFIG_DIR must never look like ours just because it
 * holds a `config.json`. aiand drops this file in the first time it writes
 * there, and nothing else ever creates it.
 */

const CONFIG_MARKER_TEXT =
  "This directory belongs to the ai& CLI (aiand). `aiand logout --all` deletes what aiand keeps here.\n";

async function ensureConfigMarker(root: string): Promise<void> {
  try {
    if (await lstat(join(root, CONFIG_MARKER_FILE)).catch(() => null)) return;
    // Only a dir that is aiand's by content gets vouched for: any write under
    // the config dir, a cache file included, passes through here.
    if (!(await mayMarkConfigDir(root))) return;
    const handle = await open(join(root, CONFIG_MARKER_FILE), "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(CONFIG_MARKER_TEXT);
    } finally {
      await handle.close();
    }
  } catch {
    // Unwritable: the marker is proof for logout --all, never a
    // precondition for the write that triggered it.
  }
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
 * How long a waiter must watch a live holder's lock stay exactly as it was
 * before calling it hung. The holder's event loop beats every 5 s even while
 * it waits out a 20 s PowerShell start, so a minute of silence is a stopped
 * process, or a PID that now belongs to something else: waiting longer only
 * makes a recycled PID wedge everyone for longer. Too short a limit lets two
 * processes rotate one refresh token, which the server reads as theft.
 */
const LOCK_HUNG_MS = 60_000;
/** A lock with no readable holder is probably mid-creation (open, then write). */
const LOCK_UNREADABLE_GRACE_MS = 5_000;
/**
 * A waiter polls every 50 ms. A longer gap between two polls means this
 * process was suspended (sleep, a stopped terminal) and the holder may have
 * been too, so what it has watched so far proves nothing.
 */
const LOCK_WATCH_GAP_MS = 1_000;

export type FileLockOptions = {
  heartbeatMs?: number;
  hungMs?: number;
  unreadableGraceMs?: number;
};

/** Whether a process with this pid is running (EPERM: it is, as another user). */
export function holderAlive(pid: number): boolean {
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
export async function stealLock(
  lockPath: string,
  text: string,
  isStale: StaleCheck,
): Promise<boolean> {
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

export type StaleCheck = (text: string, mtimeMs: number) => boolean;

/** The pid a lock names: its first word. A lock from before the nonce holds the pid alone. */
const lockPid = (text: string): number => {
  const pid = Number(text.split(" ")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
};

/**
 * Watches one lock on this process's own monotonic clock. Comparing the
 * lock's mtime with the wall clock would break when the clock jumps (sleep,
 * NTP, a manual change); a monotonic reading cannot be compared across
 * processes at all. So the waiter times how long the lock has stayed exactly
 * as it is (same holder, same mtime): a live holder changes the mtime every
 * heartbeat, whatever the clocks say, and the mtime is only ever compared
 * with its own earlier value.
 */
class LockWatch {
  private seen: string | null = null;
  private since = 0;

  /** How long, in ms, `key` has been the lock's state. */
  silentFor(key: string): number {
    const now = performance.now();
    if (key !== this.seen) {
      this.seen = key;
      this.since = now;
    }
    return now - this.since;
  }

  /** Forget what was watched: this process was not running for part of it. */
  restart(): void {
    this.seen = null;
  }
}

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
  const watch = new LockWatch();
  const isStale: StaleCheck = (text, mtimeMs) => {
    const pid = lockPid(text);
    if (pid > 0 && !holderAlive(pid)) return true;
    return watch.silentFor(`${text}@${mtimeMs}`) > (pid > 0 ? hungMs : unreadableGraceMs);
  };
  // Who holds it: the pid says where to look, the nonce says which run. Two
  // holders never share both, so a recycled pid is told apart from the holder.
  const ours = `${process.pid} ${randomBytes(8).toString("hex")}`;
  await mkdir(dirname(lockPath), { recursive: true, mode: PRIVATE_DIR_MODE });
  let lastPoll = performance.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(ours);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const polling = performance.now();
      if (polling - lastPoll > LOCK_WATCH_GAP_MS) watch.restart();
      // A lock that vanishes between the open and these reads is not stale, it
      // is free: judging it by a missing mtime would delete the next holder's.
      const [text, info] = await Promise.all([
        readFile(lockPath, "utf8").catch(missingAsNull),
        stat(lockPath).catch(missingAsNull),
      ]);
      if (text === null || info === null) continue;
      if (performance.now() - polling > LOCK_WATCH_GAP_MS) watch.restart();
      const stole = isStale(text, info.mtimeMs) && (await stealLock(lockPath, text, isStale));
      // Stamped before the pause, so a stop during it shows as a gap.
      lastPoll = performance.now();
      if (!stole) await new Promise((resolve) => setTimeout(resolve, 50));
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
    if ((await readFile(lockPath, "utf8").catch(() => null)) === ours) {
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
  const configRoot = await configRootContaining(dir);
  if (configRoot !== null) {
    await chmod(dir, PRIVATE_DIR_MODE).catch(() => {});
    await restrictToOwner(dir, { dir: true });
    await ensureConfigMarker(configRoot);
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
        await restrictToOwner(tempPath, { dir: false, recordAs: real });
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
