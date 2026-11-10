import { normalizeBaseUrl } from "../config.js";
import { AGENTS } from "./registry.js";
import { wiredApiUrl } from "./wired.js";

/** One agent's key-refresh outcome, after a fresh credential is stored. */
export type RebakeNote = {
  agent: string;
  state: "refreshed" | "skipped" | "failed";
  note: string;
};

function probeFailedNote(agent: string, error: unknown): RebakeNote {
  return {
    agent,
    state: "failed",
    note: `Could not probe its config: ${(error as Error).message ?? String(error)}`,
  };
}

/**
 * Walk every registered adapter and swap the freshly-stored API key into any
 * config that may still hold ours:
 *
 * - probe throws            → failed note; a present `refreshKey` is still
 *   attempted, and its failure extends the same note (never a second note,
 *   never a silent skip)
 * - no refreshKey + active  → skipped note telling the user to re-run
 *   `aiand <id> on` (the adapter does not persist a plaintext key)
 * - refreshKey present      → try it, even when inactive: a marked config
 *   with a bad baseURL reads inactive yet still holds our key. refreshKey
 *   reports whether it touched a marked config, so unmarked files stay
 *   silent
 * - inactive + unmarked     → no note
 *
 * launcherOnly adapters are skipped. Never throws: a probe or refresh
 * failure becomes a `failed` note rather than aborting the login.
 * `previousKey` (automatic rotation) limits the swap to configs baked with
 * exactly that key.
 */
export async function rebakeAgentKeys(
  apiKey: string,
  { previousKey, skip }: { previousKey?: string; skip?: ReadonlySet<string> } = {},
): Promise<RebakeNote[]> {
  const notes: RebakeNote[] = [];

  for (const adapter of AGENTS) {
    if (adapter.launcherOnly || skip?.has(adapter.id)) continue;

    let active = false;
    let probeError: unknown = null;
    try {
      active = (await adapter.probe()).active;
    } catch (error) {
      probeError = error;
    }

    if (!adapter.refreshKey) {
      if (probeError !== null) {
        notes.push(probeFailedNote(adapter.id, probeError));
      } else if (active) {
        notes.push({
          agent: adapter.id,
          state: "skipped",
          note: `Re-run \`aiand ${adapter.id} on\` to refresh its key.`,
        });
      }
      continue;
    }

    if (probeError !== null) {
      // The config may still be marked, so attempt the swap — but the failed
      // note stands either way (a throwing probe is never a silent skip).
      const note = probeFailedNote(adapter.id, probeError);
      try {
        await adapter.refreshKey({ apiKey, previousKey });
      } catch (error) {
        note.note += ` Refresh also failed: ${(error as Error).message ?? String(error)}`;
      }
      notes.push(note);
      continue;
    }

    try {
      if (!(await adapter.refreshKey({ apiKey, previousKey }))) continue;
      notes.push({ agent: adapter.id, state: "refreshed", note: "Key refreshed." });
    } catch (error) {
      notes.push({
        agent: adapter.id,
        state: "failed",
        note: `Could not refresh its key: ${(error as Error).message ?? String(error)}`,
      });
    }
  }

  return notes;
}

/**
 * Rebake a key into agents only where it belongs: a key is bound to the API
 * origin that issued it, so baking it into a config wired for another origin
 * would send it there. An agent wired to a different origin than `binding`
 * is left alone with a note saying how to move it (`on --profile`). The
 * origin comes from the record `on` keeps; an agent wired before the record
 * existed is judged by `fallbackApiUrl`, the origin of the profile that was
 * active when it was most likely wired. Only routed agents get a note;
 * a mismatched agent that is off has nothing to move.
 */
export async function rebakeForBinding(
  apiKey: string,
  profileName: string,
  binding: { api_url: string },
  fallbackApiUrl: string,
): Promise<RebakeNote[]> {
  const target = normalizeBaseUrl(binding.api_url);
  const skip = new Set<string>();
  const notes: RebakeNote[] = [];
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;
    const wired = normalizeBaseUrl((await wiredApiUrl(adapter.id)) ?? fallbackApiUrl);
    if (wired === target) continue;
    skip.add(adapter.id);
    let active = false;
    try {
      active = (await adapter.probe()).active;
    } catch {
      // An unreadable config is reported by nothing here: it is skipped, and
      // `aiand <agent> status` says why.
    }
    if (!active) continue;
    notes.push({
      agent: adapter.id,
      state: "skipped",
      note: `Wired to ${wired}, but profile "${profileName}" is bound to ${target}, so its key was not baked in. Run \`aiand --profile ${profileName} ${adapter.id} on\` to move it.`,
    });
  }
  return [...notes, ...(await rebakeAgentKeys(apiKey, { skip }))];
}
