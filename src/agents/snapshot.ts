import { chmod, copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";
import { pathIsInside } from "../fsutil.js";

const MANIFEST_FILE = "latest.json";

type SnapshotEntry = {
  path: string;
  backupPath?: string;
  existed: boolean;
};

type SnapshotManifest = {
  createdAt: string;
  files: SnapshotEntry[];
  added?: AddedState;
};

/** Values enable() added so subtractive off can leave hand-edited ones. */
export type AddedState = {
  model?: string;
  previousModel?: string;
  /** File mode opencode.json had before `on` locked it to 0600; disable() restores it. */
  previousMode?: number;
  providerAiand?: unknown;
  created?: boolean;
};

function snapshotDir(agentId: string): string {
  return join(configDir(), "snapshots", agentId);
}

// Windows forbids `:` in filenames, so the ISO timestamp becomes a sortable,
// filesystem-safe directory name. Millisecond precision keeps two snapshots
// of the same agent from colliding.
function snapshotStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Flatten an absolute path into one collision-free snapshot copy filename.
 * `~/.config/opencode/opencode.json` -> `.config__opencode__opencode.json`.
 */
function copyNameFor(file: string): string {
  return (
    file
      .replace(/^[a-zA-Z]:/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .join("__") || "file"
  );
}

async function readManifest(agentId: string): Promise<SnapshotManifest | null> {
  const dir = snapshotDir(agentId);
  const manifestPath = join(dir, MANIFEST_FILE);
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as SnapshotManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new CliError(`${manifestPath} is not valid JSON.`, {
        hint: `Delete ${dir} to discard the corrupt snapshot and start over.`,
      });
    }
    throw error;
  }
}

/**
 * Snapshot `files` before the agent adapter rewrites them: a timestamped
 * sibling directory holds byte-for-byte copies and `latest.json` (0600) is the
 * manifest `restoreSnapshot` replays. Files that do not exist are recorded
 * with `existed: false` so restore deletes them instead of copying.
 * Returns the snapshot directory; each call replaces the previous manifest.
 */
export async function snapshotFiles(agentId: string, files: string[]): Promise<string> {
  const dir = snapshotDir(agentId);
  const snapDir = join(dir, snapshotStamp(new Date()));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(snapDir, { mode: 0o700 });
  await chmod(snapDir, 0o700);

  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    let existed = true;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    if (existed) {
      const backupPath = join(snapDir, copyNameFor(file));
      await copyFile(file, backupPath);
      entries.push({ path: file, backupPath, existed: true });
    } else {
      entries.push({ path: file, existed: false });
    }
  }

  const manifest: SnapshotManifest = { createdAt: new Date().toISOString(), files: entries };
  await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return snapDir;
}

/**
 * Restore every snapshotted file byte-for-byte (or delete files that did not
 * exist before we touched them), then drop the manifest and snapshot copies.
 * Returns false when there is no manifest — the config was never ours.
 *
 * `allowedFiles` (the adapter's managedFiles) is required at the command
 * boundary so a tampered latest.json cannot copy or delete arbitrary paths.
 * Copy sources must also sit inside this agent's snapshot directory.
 */
export async function restoreSnapshot(agentId: string, allowedFiles: string[]): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;

  const snapRoot = await realpath(snapshotDir(agentId));
  const allowed = new Set(allowedFiles.map((file) => resolve(file)));

  for (const entry of manifest.files) {
    const dest = resolve(entry.path);
    if (!allowed.has(dest)) {
      throw new CliError(
        `Snapshot restore refused a path that is not a managed file: ${entry.path}`,
        {
          hint: "The snapshot only restores this agent's managed files. Delete the snapshot directory if it was tampered with, then re-run `on`.",
        },
      );
    }
    if (entry.existed) {
      if (!entry.backupPath) {
        throw new CliError(`Snapshot manifest is missing a copy path for ${entry.path}.`, {
          hint: `Delete ${snapshotDir(agentId)} to discard the corrupt snapshot and start over.`,
        });
      }
      const src = await realpath(entry.backupPath);
      if (src === snapRoot || !pathIsInside(snapRoot, src)) {
        throw new CliError(
          `Snapshot copy is outside the snapshot directory: ${entry.backupPath}`,
          {
            hint: "The snapshot only restores copies stored inside this agent's snapshot directory.",
          },
        );
      }
      await mkdir(dirname(dest), { recursive: true });
      // Atomic replace: readers never observe a truncated managed file even
      // if this process is killed mid-restore. Byte-identical to copyFile on
      // success, including any trailing newline. Pass the snapshot copy's
      // mode so dest is not left at the 0600 lock `on` applied.
      const bytes = await readFile(src);
      const mode = (await stat(src)).mode & 0o777;
      await writeFileAtomic(dest, bytes, { mode });
    } else {
      await rm(dest, { force: true });
    }
  }

  await rm(snapshotDir(agentId), { recursive: true, force: true });
  return true;
}

export async function hasSnapshot(agentId: string): Promise<boolean> {
  return (await readManifest(agentId)) !== null;
}

/** Drop this agent's snapshot dir (manifest, copies, added.json). Used when enable() fails after a fresh snapshot. */
export async function discardSnapshot(agentId: string): Promise<void> {
  await rm(snapshotDir(agentId), { recursive: true, force: true });
}

async function writeManifest(agentId: string, manifest: SnapshotManifest): Promise<void> {
  await writeFileAtomic(join(snapshotDir(agentId), MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function recordAddedState(agentId: string, added: AddedState): Promise<void> {
  const dir = snapshotDir(agentId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFileAtomic(join(dir, "added.json"), `${JSON.stringify(added, null, 2)}\n`, {
    mode: 0o600,
  });
  const manifest = await readManifest(agentId);
  if (!manifest) return;
  manifest.added = added;
  await writeManifest(agentId, manifest);
}

/** Drop enable()'s added-state so a later `on` records the current file, not the first-on values. Snapshot copies stay for `restore --force`. */
export async function clearAddedState(agentId: string): Promise<void> {
  const dir = snapshotDir(agentId);
  await rm(join(dir, "added.json"), { force: true });
  const manifest = await readManifest(agentId);
  if (!manifest?.added) return;
  delete manifest.added;
  await writeManifest(agentId, manifest);
}

export async function getAddedState(agentId: string): Promise<AddedState | null> {
  const addedPath = join(snapshotDir(agentId), "added.json");
  try {
    return JSON.parse(await readFile(addedPath, "utf8")) as AddedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const manifest = await readManifest(agentId);
      return manifest?.added ?? null;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`${addedPath} is not valid JSON.`, {
        hint: `Delete ${snapshotDir(agentId)} to discard the corrupt snapshot and start over.`,
      });
    }
    throw error;
  }
}

/** True when the snapshot recorded that this path did not exist before enable. */
export async function fileCreatedByUs(agentId: string, path: string): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;
  const dest = resolve(path);
  return manifest.files.some((entry) => resolve(entry.path) === dest && entry.existed === false);
}
