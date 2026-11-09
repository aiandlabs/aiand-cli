import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holderAlive, makePrivateTempDir, PRIVATE_FILE_MODE, restrictToOwner } from "../fsutil.js";
import { DAY_MS } from "../time.js";
import { restoreShimsFromOverlay } from "./hermes/shims.js";

/**
 * Launcher overlays: the throwaway dirs in os.tmpdir() that carry a session
 * key for one agent process. Cleanup removes each when its child exits; a
 * crash or a kill skips that, and the key sits in tmp until something
 * sweeps it. Only a dir this CLI made is ever swept, proven by the marker
 * file written into it at creation, never by its name.
 */

const OVERLAY_PREFIX = "aiand-";
const MARKER_FILE = ".aiand-overlay";
/** A session older than this is gone even if its pid was reused since. */
const ABANDONED_MS = 7 * DAY_MS;
/** The launcher's own sweep leaves anything younger alone. */
export const STALE_OVERLAY_MS = DAY_MS;

type OverlayMarker = { pid: number; createdAt: number };

/**
 * mkdtemp under os.tmpdir() plus the marker that lets a later sweep claim it.
 * The dir is owner-only before anything lands in it (Windows: tmp inherits
 * other users' read access, and a grant added once links exist could
 * propagate through them), so every overlay is both marked and private.
 */
export async function makeOverlayDir(prefix: string): Promise<string> {
  const dir = await makePrivateTempDir(prefix);
  const marker: OverlayMarker = { pid: process.pid, createdAt: Date.now() };
  try {
    const markerPath = join(dir, MARKER_FILE);
    await writeFile(markerPath, JSON.stringify(marker), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await restrictToOwner(markerPath, { dir: false });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/** Ours to judge: a real dir (not a link) and a regular marker, both owned by this user. */
async function readMarker(dir: string): Promise<OverlayMarker | null> {
  const uid = process.getuid?.();
  try {
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || (uid !== undefined && dirStat.uid !== uid)) return null;
    const markerPath = join(dir, MARKER_FILE);
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || (uid !== undefined && markerStat.uid !== uid)) return null;
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Partial<OverlayMarker>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export type OverlaySweep = {
  /** Overlays deleted: their session is over. */
  removed: string[];
  /** Overlays left alone because the aiand process that made them still runs. */
  inUse: string[];
};

/**
 * Delete marked overlays whose session is over: the process that made them
 * is gone (or the overlay is older than any session runs). `minAgeMs` spares
 * younger ones, so a routine sweep never races a launch that just started.
 * Best-effort per dir: one that cannot be removed is skipped, not fatal.
 */
export async function sweepOverlays({
  minAgeMs = 0,
}: {
  minAgeMs?: number;
} = {}): Promise<OverlaySweep> {
  const root = tmpdir();
  const result: OverlaySweep = { removed: [], inUse: [] };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return result;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(OVERLAY_PREFIX)) continue;
    const dir = join(root, name);
    const marker = await readMarker(dir);
    if (marker === null) continue;
    const age = now - marker.createdAt;
    if (age < minAgeMs) continue;
    if (marker.pid === process.pid) continue;
    if (holderAlive(marker.pid) && age < ABANDONED_MS) {
      result.inUse.push(dir);
      continue;
    }
    try {
      // A crashed Hermes session leaves the user's store shims pointing into
      // its overlay: put them back first, and keep the overlay while any
      // still does, or the user's own `hermes` is left on a deleted path.
      if (!(await restoreShimsFromOverlay(dir))) continue;
      await rm(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch {
      // Held open (Windows) or vanished: the next sweep tries again.
    }
  }
  return result;
}
