import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextIfExists } from "../managed-file.js";
import { findRowById } from "./patch.js";
import { LLM_ROW_ID } from "./rows.js";

/** Profile layers shadowing our home route: the home llm-pi-ai row
 * replaces the entry's whole config, hiding Web UI providers in any profile
 * layer while the aiand route is on. Best-effort: a broken profile file
 * never refuses routing. */
export async function profileLayerWarnings(home: string): Promise<string[]> {
  const warnings: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(join(home, "profiles"), { withFileTypes: true });
  } catch {
    return warnings;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profilePatch = join(home, "profiles", entry.name, "cordis.patch.yml");
    try {
      const text = await readTextIfExists(profilePatch);
      if (text !== "" && findRowById(text, LLM_ROW_ID) !== undefined) {
        warnings.push(
          `The dsh profile layer ${profilePatch} also configures llm-pi-ai; its providers are hidden while the aiand route is on.`,
        );
      }
    } catch {}
  }
  return warnings;
}
