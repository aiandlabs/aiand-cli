import { join } from "node:path";
import { agentHome, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode } from "../../fsutil.js";
import { jsoncDelete, parseJsonc, readTextIfExists } from "../managed-file.js";
import { opencodeConfigDir } from "./surfaces.js";

/**
 * The one opencode.json both OpenCode programs read: the terminal
 * `opencode` (1.x and 2.x) and OpenCode Desktop's background service.
 * Both honor XDG_CONFIG_HOME, so `on` writes where they look.
 */
export function opencodeConfigPath(): string {
  return join(opencodeConfigDir(), "opencode.json");
}

/**
 * Where aiand wrote before it honored XDG_CONFIG_HOME. A config there that
 * carries our marker holds a baked key OpenCode never read; `off` strips it.
 */
export function legacyConfigPath(): string {
  return join(agentHome(), ".config", "opencode", "opencode.json");
}

/**
 * Strip our marked provider from a pre-XDG config, if one is there, and say
 * so in the words of the command (`on` warns, `off` notes). `isOurs` is the
 * adapter's marker check; `providerId` its provider key. An `aiand` provider
 * without the marker is not ours and stays.
 */
export async function stripLegacyConfig(
  providerId: string,
  isOurs: (parsed: Record<string, unknown>) => boolean,
  command: "on" | "off",
): Promise<string | undefined> {
  const path = legacyConfigPath();
  if (path === opencodeConfigPath()) return undefined;
  try {
    if (!(await stripProvider(path, providerId, isOurs))) return undefined;
  } catch (error) {
    // `on` has already wired the current file; an unwritable old one is a
    // warning, not a failed `on`.
    if (command === "off") throw error;
    return `Could not check ${path} for an old ai& key; check it by hand.`;
  }
  return command === "on"
    ? `Removed the aiand provider, with its key, from ${path}: OpenCode does not read that file while XDG_CONFIG_HOME is set.`
    : `stripped the aiand provider from ${path}, which OpenCode does not read while XDG_CONFIG_HOME is set`;
}

async function stripProvider(
  path: string,
  providerId: string,
  isOurs: (parsed: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const raw = await readTextIfExists(path);
  if (!raw.trim()) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(raw) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || !isOurs(parsed)) return false;
  let text = jsoncDelete(raw, ["provider", providerId]);
  const left = (parseJsonc(text) as Record<string, unknown>).provider;
  if (left && typeof left === "object" && Object.keys(left).length === 0) {
    text = jsoncDelete(text, ["provider"]);
  }
  // The file may hold another provider's key: keep the mode it has.
  await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? DEFAULT_FILE_MODE });
  return true;
}
