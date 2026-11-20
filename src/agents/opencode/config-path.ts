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
 * Strip our marked provider from a pre-XDG config, if one is there.
 * `isOurs` is the adapter's marker check; `providerId` its provider key.
 */
export async function stripLegacyConfig(
  providerId: string,
  isOurs: (parsed: Record<string, unknown>) => boolean,
): Promise<string | undefined> {
  const path = legacyConfigPath();
  if (path === opencodeConfigPath()) return undefined;
  const raw = await readTextIfExists(path);
  if (!raw.trim()) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !isOurs(parsed)) return undefined;
  let text = jsoncDelete(raw, ["provider", providerId]);
  const left = (parseJsonc(text) as Record<string, unknown>).provider;
  if (left && typeof left === "object" && Object.keys(left).length === 0) {
    text = jsoncDelete(text, ["provider"]);
  }
  // The file may hold another provider's key: keep the mode it has.
  await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? DEFAULT_FILE_MODE });
  return `stripped the aiand provider from ${path}, which OpenCode does not read while XDG_CONFIG_HOME is set`;
}
