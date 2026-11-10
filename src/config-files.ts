import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What aiand keeps in its config dir, shared by the two things that must agree
 * on it: `fsutil` (which vouches for a dir with a marker) and `auth/config-wipe`
 * (which deletes by name once a dir is vouched for). A leaf module, so neither
 * imports the other.
 */

/** Proof for `logout --all` that a directory is aiand's own. */
export const CONFIG_MARKER_FILE = ".aiand-config";

/** Files aiand writes into its config dir. */
export const CONFIG_FILES: ReadonlySet<string> = new Set([
  "config.json",
  "credentials.json",
  "credentials-plaintext.json",
  "secret-store.json",
  "secret-store.key",
  "secret-store.dpapi.json",
  "secret-store.lock",
  "secret-store.lock.steal",
  "credentials.lock",
  "credentials.lock.steal",
  "wired.json",
  "finalize.json",
  "update-check.json",
  "model-catalog.json",
  "opencode-api.json",
]);

/** Directories aiand makes in its config dir. */
const CONFIG_DIRS: ReadonlySet<string> = new Set(["snapshots", "locks"]);

/** Leftovers of an interrupted atomic write or key publish. */
export const STRAY_TEMP = /^(?:\.\d+-[0-9a-f]+\.tmp|secret-store\.key\.\d+\.[0-9a-f]+\.tmp)$/;

/** Whether `config.json` has the shape aiand writes: a profile name and a profiles table. */
export async function holdsAiandConfig(real: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(real, "config.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const { profile, profiles } = parsed as { profile?: unknown; profiles?: unknown };
    return (
      typeof profile === "string" &&
      typeof profiles === "object" &&
      profiles !== null &&
      !Array.isArray(profiles)
    );
  } catch {
    return false;
  }
}

/**
 * Whether aiand may vouch for `root` with its marker: its `config.json` has
 * aiand's shape (an install older than the marker), or the dir holds nothing
 * but aiand's own entries and temp files, a new or empty dir included. A dir
 * with anything else in it, or a `config.json` of another tool's shape, is
 * someone else's: an `AIAND_CONFIG_DIR` typed as `~/.docker` must stay
 * unproven so `logout --all` refuses it.
 */
export async function mayMarkConfigDir(root: string): Promise<boolean> {
  if (await holdsAiandConfig(root)) return true;
  const names = await readdir(root);
  return names.every(
    (name) =>
      name !== "config.json" &&
      (name === CONFIG_MARKER_FILE ||
        CONFIG_FILES.has(name) ||
        CONFIG_DIRS.has(name) ||
        STRAY_TEMP.test(name)),
  );
}
