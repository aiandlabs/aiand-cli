import { chmod, copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CliError } from "../cli/errors.js";
import { configDir, writeFileAtomic } from "../config.js";

const MANIFEST_FILE = "latest.json";

type BackupEntry = {
  path: string;
  backupPath?: string;
  existed: boolean;
};

type BackupManifest = {
  createdAt: string;
  files: BackupEntry[];
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

/** Pre-rename location; installs that already have a manifest there keep using it. */
function legacyDir(agentId: string): string {
  return join(configDir(), "backups", agentId);
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, MANIFEST_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * New snapshots go under snapshots/; when only the legacy backups/ manifest
 * exists, that dir stays authoritative so existing installs still restore.
 */
async function effectiveDir(agentId: string): Promise<string> {
  const next = snapshotDir(agentId);
  if (await hasManifest(next)) return next;
  if (await hasManifest(legacyDir(agentId))) return legacyDir(agentId);
  return next;
}

// Windows forbids `:` in filenames, so the ISO timestamp becomes a sortable,
// filesystem-safe directory name. Millisecond precision keeps two snapshots
// of the same agent from colliding.
function snapshotStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Flatten an absolute path into one collision-free backup filename.
 * `~/.config/opencode/opencode.json` -> `.config__opencode__opencode.json`.
 */
function backupNameFor(file: string): string {
  return (
    file
      .replace(/^[a-zA-Z]:/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .join("__") || "file"
  );
}

async function readManifest(agentId: string): Promise<BackupManifest | null> {
  const dir = await effectiveDir(agentId);
  const manifestPath = join(dir, MANIFEST_FILE);
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as BackupManifest;
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
 * Back up `files` before the agent adapter rewrites them: a timestamped
 * sibling directory holds byte-for-byte copies and `latest.json` (0600) is the
 * manifest `restoreSnapshot` replays. Files that do not exist are recorded
 * with `existed: false` so restore deletes them instead of copying.
 * Returns the snapshot directory; each call replaces the previous manifest.
 */
export async function snapshotFiles(agentId: string, files: string[]): Promise<string> {
  const dir = await effectiveDir(agentId);
  const snapDir = join(dir, snapshotStamp(new Date()));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(snapDir, { mode: 0o700 });
  await chmod(snapDir, 0o700);

  const entries: BackupEntry[] = [];
  for (const file of files) {
    let existed = true;
    try {
      await stat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    if (existed) {
      const backupPath = join(snapDir, backupNameFor(file));
      await copyFile(file, backupPath);
      entries.push({ path: file, backupPath, existed: true });
    } else {
      entries.push({ path: file, existed: false });
    }
  }

  const manifest: BackupManifest = { createdAt: new Date().toISOString(), files: entries };
  await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return snapDir;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
export async function restoreSnapshot(agentId: string, allowedFiles: string[] = []): Promise<boolean> {
  const manifest = await readManifest(agentId);
  if (!manifest) return false;

  const snapRoot = await realpath(await effectiveDir(agentId));
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
          hint: `Delete ${await effectiveDir(agentId)} to discard the corrupt snapshot and start over.`,
        });
      }
      const src = await realpath(entry.backupPath);
      if (!isInside(snapRoot, src)) {
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

  await rm(await effectiveDir(agentId), { recursive: true, force: true });
  return true;
}

export async function hasSnapshot(agentId: string): Promise<boolean> {
  return (await readManifest(agentId)) !== null;
}

/** Drop this agent's snapshot dir (manifest, copies, added.json). Used when enable() fails after a fresh snapshot. */
export async function discardSnapshot(agentId: string): Promise<void> {
  await rm(await effectiveDir(agentId), { recursive: true, force: true });
}

async function writeManifest(agentId: string, manifest: BackupManifest): Promise<void> {
  await writeFileAtomic(join(await effectiveDir(agentId), MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function recordAddedState(agentId: string, added: AddedState): Promise<void> {
  const dir = await effectiveDir(agentId);
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
  const dir = await effectiveDir(agentId);
  await rm(join(dir, "added.json"), { force: true });
  const manifest = await readManifest(agentId);
  if (!manifest?.added) return;
  delete manifest.added;
  await writeManifest(agentId, manifest);
}

export async function getAddedState(agentId: string): Promise<AddedState | null> {
  const addedPath = join(await effectiveDir(agentId), "added.json");
  try {
    return JSON.parse(await readFile(addedPath, "utf8")) as AddedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const manifest = await readManifest(agentId);
      return manifest?.added ?? null;
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`${addedPath} is not valid JSON.`, {
        hint: `Delete ${await effectiveDir(agentId)} to discard the corrupt snapshot and start over.`,
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
