import { dirname, join } from "node:path";
import type { Model } from "../../api/models.js";
import { agentHome, DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { asObject, notValidJsonError, parseJsonc, readTextIfExists } from "../managed-file.js";
import { getAddedState } from "../snapshot.js";

/**
 * T3 Code's settings vocabulary, split from the adapter:
 * where its state lives (T3CODE_HOME, like CLAUDE_CONFIG_DIR),
 * the provider instance `on` writes and the env contract it
 * carries, and the pure readers and parsers over
 * settings.json. The adapter — enable, disable, probe,
 * rotation — lives in adapter.ts.
 */

export const T3CODE_ID = "t3code";
/** The provider instance `on` writes; t3 requires `^[a-zA-Z][a-zA-Z0-9_-]*$`. */
export const INSTANCE_ID = "aiand";
/**
 * t3 spawns provider CLIs; a Claude Code subprocess is the driver
 * literal "claudeAgent" (not "claude"). Our instance is that
 * driver, pointed at the gateway through its environment.
 */
export const DRIVER = "claudeAgent";

/** Claude Code reads its boolean env switches as "1" and "0". */
const ENV_ON = "1";
const ENV_OFF = "0";
/**
 * Ownership marker aiand stamps on the instance. It rides the
 * `environment` array — a var name foreign to Claude Code, which
 * the claude CLI ignores but t3 forwards to it — because t3's
 * schema drops unknown top-level settings keys on its own writes,
 * so a marker at the root of settings.json would not survive t3
 * rewriting the file.
 */
const MARKER_KEY = "AIAND_MANAGED";
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
export const TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
/** Blanked so a key exported in the shell cannot win over ours. */
const API_KEY_KEY = "ANTHROPIC_API_KEY";
/**
 * The gateway flattens `system` into one string, so Claude Code's
 * attribution block would reach the model as prompt text; its docs
 * name this variable as the client-side fix for a gateway that
 * reshapes `system`.
 */
const ATTRIBUTION_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER";
/** A `[1m]`-tagged id would make Claude Code assume a 1M window. */
const DISABLE_1M_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const OPUS_SLOT = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const SONNET_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const FABLE_SLOT = "ANTHROPIC_DEFAULT_FABLE_MODEL";
const MAIN_SLOTS = [OPUS_SLOT, SONNET_SLOT, FABLE_SLOT, "CLAUDE_CODE_SUBAGENT_MODEL"];
const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
// These mirror src/agents/claude.ts deliberately: the same
// Claude Code env contract, two config surfaces.
// A switch left on in the shell or a lower settings file would
// route Claude Code to that cloud whatever ANTHROPIC_BASE_URL says.
const FOREIGN_PROVIDER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
// Curated fast-model order filtered through the live catalog, until
// a catalog field can say which model suits the haiku slot.
const FAST_PREFERRED = ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"];

export const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand t3code on again.";

/**
 * One entry of a provider instance's `environment` array. t3 keeps
 * `sensitive` values out of settings.json: the bytes live in
 * `secrets/provider-env-<instance>-<name>.bin` (0600) under the
 * same state dir, and settings.json holds the entry with an empty
 * `value` and `valueRedacted` set, so a file a user can read never
 * carries the key.
 */
type EnvEntry = {
  name: string;
  value: string;
  sensitive: boolean;
  valueRedacted?: boolean;
};

/** What enable() recorded so off can tell its values from the user's. */
export type T3codeRecord = {
  path?: string;
  /** The providerInstances.aiand value `on` found, when it carried our marker. */
  previousInstance?: Record<string, unknown>;
  /**
   * The instance `on` wrote (token entry blank, as it sits on disk),
   * so off can tell a hand edit from its own bytes. t3 only re-reads
   * external edits (~100ms debounce) and never rewrites the file, so
   * a mismatch is always the user's.
   */
  writtenInstance?: Record<string, unknown>;
  /** Whether defaultModelSelection was present before `on` wrote it. */
  hadSelection?: boolean;
  /** The defaultModelSelection value `on` found; absent means JSON null. */
  previousSelection?: Record<string, unknown>;
  /** Absolute paths of the secret files `on` wrote the session key to. */
  secretPaths?: string[];
  previousMode?: number;
  created?: boolean;
  /**
   * The exact bytes of a user-owned empty settings.json `on`
   * found, so off restores them byte-identically instead of
   * writing `{\n}\n`. `created` is false for such a file, so off
   * must never unlink it — a 0-byte settings.json is the user's.
   */
  emptyOriginalRaw?: string;
};

/** T3CODE_HOME relocates t3's state (like CLAUDE_CONFIG_DIR; not XDG). */
export function settingsPath(): string {
  const dir = process.env.T3CODE_HOME || join(agentHome(), ".t3");
  return join(dir, "userdata", "settings.json");
}

/**
 * While wired, the file `on` wrote: logout, uninstall and rotation
 * run from shells that may not share the T3CODE_HOME it was wired
 * under. An unreadable record falls back to the current file, so
 * status still reads one.
 */
export async function wiredSettingsPath(): Promise<string> {
  try {
    return (await getAddedState<T3codeRecord>(T3CODE_ID))?.path ?? settingsPath();
  } catch {
    return settingsPath();
  }
}

/**
 * The secrets dir sits next to settings.json, so a wired file's
 * secret is found from that file's own path, never from the
 * current T3CODE_HOME.
 */
export function secretsDirFor(settingsFile: string): string {
  return join(dirname(settingsFile), "secrets");
}

/** t3's secret-file name for one instance env var: raw UTF-8, base64url. */
export function secretPathFor(settingsFile: string, name: string): string {
  const instance = Buffer.from(INSTANCE_ID, "utf8").toString("base64url");
  const variable = Buffer.from(name, "utf8").toString("base64url");
  return join(secretsDirFor(settingsFile), `provider-env-${instance}-${variable}.bin`);
}

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
export function t3BaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

export const inCatalog = (catalog: Model[], id: string): boolean =>
  catalog.some((model) => model.id === id);

export function fastModel(catalog: Model[], main: string): string {
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

/**
 * The env block `on` writes, in order: gateway routing, the session
 * token (sensitive, so blank here), the blanked shell-key override,
 * our stamp, and the switches that would reroute Claude Code to a
 * cloud, then the model slots.
 */
export function instanceEnv(baseUrl: string, main: string, fast: string): EnvEntry[] {
  const entries: EnvEntry[] = [
    { name: BASE_URL_KEY, value: baseUrl, sensitive: false },
    { name: TOKEN_KEY, value: "", sensitive: true, valueRedacted: true },
    { name: API_KEY_KEY, value: "", sensitive: false },
    { name: MARKER_KEY, value: ENV_ON, sensitive: false },
    { name: ATTRIBUTION_KEY, value: ENV_OFF, sensitive: false },
    { name: DISABLE_1M_KEY, value: ENV_ON, sensitive: false },
  ];
  for (const key of FOREIGN_PROVIDER_KEYS) {
    entries.push({ name: key, value: ENV_OFF, sensitive: false });
  }
  for (const slot of MAIN_SLOTS) {
    entries.push({ name: slot, value: main, sensitive: false });
  }
  entries.push({ name: FAST_SLOT, value: fast, sensitive: false });
  return entries;
}

export function parseSettings(path: string, raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
  const object = asObject(parsed);
  if (!object) throw notValidJsonError(path, INVALID_CONFIG_HINT);
  return object;
}

/** Re-parse text this module just wrote, which is always an object. */
export const parseWritten = (text: string): Record<string, unknown> =>
  asObject(parseJsonc(text)) ?? {};

/** The aiand provider instance, when settings.json holds one. */
export function instanceAt(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(asObject(settings.providerInstances)?.[INSTANCE_ID]);
}

/** Our stamp on the instance: the marker var, on a claudeAgent driver. */
export function isOurs(
  instance: Record<string, unknown> | undefined,
): instance is Record<string, unknown> {
  const environment = Array.isArray(instance?.environment) ? instance.environment : [];
  return (
    environment.some((entry) => {
      const object = asObject(entry);
      return object?.name === MARKER_KEY && object?.value === ENV_ON;
    }) && instance?.driver === DRIVER
  );
}

/** A file carrying our marker; one we cannot parse counts, so its record survives until it is fixed. */
export async function markedFile(file: string): Promise<boolean> {
  try {
    return isOurs(instanceAt(parseSettings(file, await readTextIfExists(file))));
  } catch {
    return true;
  }
}

/**
 * The token entry reads "" on disk (its bytes live in the secret
 * file), so blank it before comparing: a hand edit that only pokes
 * the token entry's value still counts as our write.
 */
export function withoutTokenValue(instance: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...instance };
  const environment = Array.isArray(clone.environment) ? clone.environment : [];
  clone.environment = environment.map((entry) => {
    const object = asObject(entry);
    return object?.name === TOKEN_KEY ? { ...object, value: "" } : entry;
  });
  return clone;
}

/** The environment array without our stamp and the token entry. */
export function stripOurEnv(instance: Record<string, unknown>): unknown[] {
  const environment = Array.isArray(instance.environment) ? instance.environment : [];
  return environment.filter((entry) => {
    const name = asObject(entry)?.name;
    return name !== MARKER_KEY && name !== TOKEN_KEY;
  });
}
