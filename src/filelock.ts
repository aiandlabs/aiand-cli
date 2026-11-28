import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, win32 } from "node:path";
import { systemToolEnv } from "./cli/spawn-env.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fsutil.js";

/**
 * The cross-process lock behind every read-modify-write of aiand's own files:
 * who holds it, when a holder counts as dead or hung, and how a stale lock is
 * taken over without two waiters both running.
 */

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

type MachineIdDeps = {
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[]) => string;
  read?: (path: string) => string;
  host?: () => string;
};

/**
 * reg.exe in the Windows folder, never in one the environment names: a lock
 * must not run a program from wherever SystemRoot was pointed. SystemRoot is
 * trusted only when it is a drive's Windows folder, as on any installed PC.
 */
export function trustedRegExe(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "";
  const windows = /^[A-Za-z]:\\Windows\\?$/i.test(root) ? root.replace(/\\$/, "") : "C:\\Windows";
  return win32.join(windows, "System32", "reg.exe");
}

const runQuietly = (file: string, args: string[]): string =>
  execFileSync(file, args, {
    encoding: "utf8",
    env: systemToolEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });

/**
 * The operating system's id for this machine, or null when none is readable.
 * Windows: MachineGuid under HKLM\SOFTWARE\Microsoft\Cryptography, which any
 * user may read, through reg.exe from System32. macOS: IOPlatformUUID. Linux:
 * /etc/machine-id (or D-Bus's copy). Each survives a reboot and differs
 * between PCs that share a host name, as PCs from one disk image often do.
 */
function osMachineId(deps: MachineIdDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runQuietly;
  const read = deps.read ?? ((path: string) => readFileSync(path, "utf8"));
  const valid = (id: string | undefined): string | null => {
    const trimmed = id?.trim().toLowerCase() ?? "";
    return /^[0-9a-f-]{16,64}$/.test(trimmed) ? trimmed : null;
  };
  try {
    if (platform === "win32") {
      const out = run(trustedRegExe(), [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      return valid(out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1]);
    }
    if (platform === "darwin") {
      const out = run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      return valid(out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]);
    }
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = valid(read(path));
        if (id) return id;
      } catch {
        // try the next one
      }
    }
  } catch {
    // unreadable: the caller falls back to the host name
  }
  return null;
}

/**
 * This machine, as a lock names it. A config folder on a network share (a
 * redirected or roaming profile, a home folder on a file server) can be used
 * from two PCs at once, and a pid means nothing on the other one: there it
 * would read as dead and the lock would be stolen from a live holder. The
 * operating system's machine id tells apart PCs that share a host name; the
 * host name, encoded so that two names never fold into one, stands in where
 * no id is readable. The prefixes keep the two kinds from ever matching. The
 * id goes into the lock hashed with a name of aiand's own, as systemd asks of
 * anything that records /etc/machine-id: a lock on a share is readable by
 * whoever can read the share, and whatever the id file held stays off it.
 */
export function machineIdentity(deps: MachineIdDeps = {}): string {
  const id = osMachineId(deps);
  if (id) return `m:${createHash("sha256").update(`aiand-lock:${id}`).digest("hex").slice(0, 32)}`;
  const name = (deps.host ?? hostname)();
  return name === "" ? "h:?" : `h:${encodeURIComponent(name)}`;
}

let ownIdentity: string | undefined;

/** This process's machine identity, read once. */
export function lockHost(): string {
  ownIdentity ??= machineIdentity();
  return ownIdentity;
}

/**
 * Whether the pid in a lock or guard can be checked here. Only this PC's own
 * machine id proves that: two PCs that fall back to the same host name would
 * each read the other's pid as dead, and a lock with no host at all (written
 * by an aiand from before the host was recorded) may come from any PC sharing
 * the folder. Every other lock is judged by its heartbeat alone, so a stale
 * one costs a single wait of the hung limit, once, after upgrading.
 */
export function pidIsLocal(text: string, own: string = lockHost()): boolean {
  const host = text.split(" ")[2];
  return host !== undefined && host.startsWith("m:") && host === own;
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
    await handle.writeFile(`${process.pid} - ${lockHost()}`);
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
  const pid = text === null ? 0 : lockPid(text);
  const dead = pid > 0 && text !== null && pidIsLocal(text) ? !holderAlive(pid) : false;
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
    // Another machine's holder is judged by its heartbeat alone.
    if (pid > 0 && pidIsLocal(text) && !holderAlive(pid)) return true;
    return watch.silentFor(`${text}@${mtimeMs}`) > (pid > 0 ? hungMs : unreadableGraceMs);
  };
  // Who holds it: the pid and host say where to look, the nonce says which
  // run. Two holders never share all three, so a recycled pid is told apart
  // from the holder.
  const ours = `${process.pid} ${randomBytes(8).toString("hex")} ${lockHost()}`;
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
