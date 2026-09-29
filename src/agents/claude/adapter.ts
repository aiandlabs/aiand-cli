import { chmod, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "../../api/models.js";
import { CliError } from "../../cli/errors.js";
import {
  agentHome,
  DEFAULT_BASE_URL,
  isRoutableBaseUrl,
  trimSlash,
  writeFileAtomic,
} from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary, INSTALL_HINTS } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
} from "../managed-file.js";
import {
  clearAddedState,
  fileCreatedByUs,
  getAddedState,
  getAddedStateSync,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import { applyModelPicker, buildModelPicker, stripModelPicker } from "./picker.js";

const CLAUDE_ID = "claude";
const CLAUDE_BIN = "claude";

/** Claude Code reads its boolean env switches as "1" and "0". */
const ENV_ON = "1";
const ENV_OFF = "0";
const MARKER_KEY = "AIAND_MANAGED";
const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
const TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
/** Blanked so a key exported in the shell cannot win over ours. */
const API_KEY_KEY = "ANTHROPIC_API_KEY";
/**
 * The gateway flattens `system` into one string, so Claude Code's attribution
 * block would reach the model as prompt text; its docs name this variable as
 * the client-side fix for a gateway that reshapes `system`.
 */
const ATTRIBUTION_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER";
/** A `[1m]`-tagged id would make Claude Code assume a 1M window and ignore the cap below. */
const DISABLE_1M_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
const OPUS_SLOT = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const SONNET_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const FABLE_SLOT = "ANTHROPIC_DEFAULT_FABLE_MODEL";
const MAIN_SLOTS = [OPUS_SLOT, SONNET_SLOT, FABLE_SLOT, "CLAUDE_CODE_SUBAGENT_MODEL"];
const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
const ENV_MODEL_KEY = "ANTHROPIC_MODEL";
/** The slot `default`, and an alias this adapter does not know, start on. */
const DEFAULT_SLOT = SONNET_SLOT;
/** Claude Code's model aliases and the slot each starts on; `opusplan` uses opus only in plan mode. */
const ALIAS_SLOTS: Record<string, string> = {
  default: DEFAULT_SLOT,
  sonnet: SONNET_SLOT,
  opusplan: SONNET_SLOT,
  opus: OPUS_SLOT,
  best: OPUS_SLOT,
  fable: FABLE_SLOT,
  haiku: FAST_SLOT,
};
const CONTEXT_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
// One cap for every model: open models get unreliable at tool calling well
// before their advertised 1M window (a glm-5.3 session looped at ~270k), so
// Claude Code should compact long sessions first. A per-model catalog field
// (an "effective context") would retire it.
const CONTEXT_CAP_TOKENS = 200_000;
const DENIED_TOOLS = ["WebSearch"];
const FOREIGN_PROVIDER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// Curated orders filtered through the live catalog, until a catalog field can
// say which model suits which slot. Vision first for the main slots, since
// pasting screenshots is routine in Claude Code.
const MAIN_PREFERRED = ["moonshotai/kimi-k3", "qwen/qwen3.8-27b", "moonshotai/kimi-k2.7-code"];
const FAST_PREFERRED = ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"];

const INVALID_CONFIG_HINT = "Fix it by hand, then run aiand claude on again.";

type Env = Record<string, string>;

/** What enable() recorded so off can tell its values from the user's. */
type ClaudeRecord = {
  path?: string;
  env?: Env;
  previousEnv?: Env;
  removedModel?: string;
  removedEnvModel?: string;
  addedDeny?: string[];
  createdKeys?: string[];
  modelPicker?: unknown;
  previousMode?: number;
  created?: boolean;
};

/** The two settings that can name the model Claude Code starts on, strongest first. */
const MODEL_SETTINGS = [
  { path: ["env", ENV_MODEL_KEY], label: `env.${ENV_MODEL_KEY}`, record: "removedEnvModel" },
  { path: ["model"], label: "model", record: "removedModel" },
] as const;

function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(agentHome(), ".claude");
  return join(dir, "settings.json");
}

/**
 * While wired, the file `on` wrote: logout, uninstall and rotation run from
 * shells that may not share the CLAUDE_CONFIG_DIR it was wired under. An
 * unreadable record falls back to the current file, so status still reads one.
 */
async function wiredSettingsPath(): Promise<string> {
  try {
    return (await getAddedState<ClaudeRecord>(CLAUDE_ID))?.path ?? claudeSettingsPath();
  } catch {
    return claudeSettingsPath();
  }
}

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
function claudeBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

const inCatalog = (catalog: Model[], id: string): boolean =>
  catalog.some((model) => model.id === id);

const aliasName = (model: string): string => model.replace(/\[1m\]$/i, "").toLowerCase();

const isAlias = (model: string): boolean => Object.hasOwn(ALIAS_SLOTS, aliasName(model));

const claudeDefaultModel = (catalog: Model[], profileModel?: string): string =>
  resolveDefault(catalog, profileModel, MAIN_PREFERRED);

function fastModel(catalog: Model[], main: string): string {
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

function gatewayEnv(apiKey: string, baseUrl: string): Env {
  return {
    [BASE_URL_KEY]: baseUrl,
    [TOKEN_KEY]: apiKey,
    [API_KEY_KEY]: "",
    [MARKER_KEY]: ENV_ON,
    [ATTRIBUTION_KEY]: ENV_OFF,
    [DISABLE_1M_KEY]: ENV_ON,
    // A switch left on in the shell or a lower settings file would route
    // Claude Code to that cloud whatever ANTHROPIC_BASE_URL says.
    ...Object.fromEntries(FOREIGN_PROVIDER_KEYS.map((key) => [key, ENV_OFF])),
  };
}

function slotEnv(main: string, fast: string): Env {
  const env: Env = {};
  for (const slot of MAIN_SLOTS) env[slot] = main;
  env[FAST_SLOT] = fast;
  return env;
}

/**
 * Every `env` key `on` owns apart from the token and the marker (which `off`
 * always removes), taken from the helpers that write them so the lists
 * cannot drift.
 */
const OWNED_ENV_KEYS = [
  ...Object.keys(gatewayEnv("", "")),
  ...Object.keys(slotEnv("", "")),
  CONTEXT_KEY,
].filter((key) => key !== TOKEN_KEY && key !== MARKER_KEY);

function ownedValues(env: Record<string, unknown>): Env {
  const owned: Env = {};
  for (const key of OWNED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") owned[key] = value;
  }
  return owned;
}

const restoreEnv = (text: string, key: string, previous: string | undefined): string =>
  previous !== undefined ? jsoncSet(text, ["env", key], previous) : jsoncDelete(text, ["env", key]);

const settingAt = (settings: Record<string, unknown>, path: readonly string[]): unknown =>
  path.length === 1 ? settings[path[0]!] : asObject(settings.env)?.[path[1]!];

/** The setting that decides the startup model, and the model it resolves to. */
function startupModel(settings: Record<string, unknown>): {
  model: string | undefined;
  setting?: { label: string; value: string };
} {
  const env = asObject(settings.env) ?? {};
  for (const { path, label } of MODEL_SETTINGS) {
    const value = settingAt(settings, path);
    if (!nonEmpty(value)) continue;
    if (!isAlias(value)) return { model: value, setting: { label, value } };
    const slot = env[ALIAS_SLOTS[aliasName(value)]!];
    return { model: nonEmpty(slot) ? slot : undefined, setting: { label, value } };
  }
  const slot = env[DEFAULT_SLOT];
  return { model: nonEmpty(slot) ? slot : undefined };
}

function contextTokens(catalog: Model[], ids: string[]): string | undefined {
  const windows = ids
    .map((id) => catalog.find((model) => model.id === id)?.context_window)
    .filter((window): window is number => typeof window === "number" && window > 0);
  return windows.length > 0 ? String(Math.min(CONTEXT_CAP_TOKENS, ...windows)) : undefined;
}

export function buildClaudeSettings({
  apiKey,
  baseUrl,
  main,
  catalog,
}: {
  apiKey: string;
  baseUrl: string;
  main: string;
  catalog: Model[];
}): Record<string, unknown> {
  const fast = fastModel(catalog, main);
  // ANTHROPIC_MODEL too: a shell export of it would beat the `model` below.
  const env: Env = {
    ...gatewayEnv(apiKey, baseUrl),
    ...slotEnv(main, fast),
    [ENV_MODEL_KEY]: main,
  };
  const tokens = contextTokens(catalog, [main, fast]);
  if (tokens) env[CONTEXT_KEY] = tokens;
  return {
    model: main,
    env,
    permissions: { deny: DENIED_TOOLS },
    modelPicker: buildModelPicker(catalog),
  };
}

/** A file carrying our marker; one we cannot parse counts, so its record survives until it is fixed. */
async function markedFile(path: string): Promise<boolean> {
  try {
    const env = asObject(parseSettings(path, await readTextIfExists(path)).env);
    return env?.[MARKER_KEY] === ENV_ON;
  } catch {
    return true;
  }
}

const routedByUs = (env: Record<string, unknown> | undefined): boolean =>
  env?.[MARKER_KEY] === ENV_ON && isRoutableBaseUrl(env[BASE_URL_KEY]);

function parseSettings(path: string, raw: string): Record<string, unknown> {
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
const parseWritten = (text: string): Record<string, unknown> => asObject(parseJsonc(text)) ?? {};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

function assertNotForeign(
  path: string,
  settings: Record<string, unknown>,
  env: Record<string, unknown>,
): void {
  const hint = `Remove it from ${path} by hand, then run aiand claude on again. aiand run-agent claude launches Claude Code on ai& without touching the file.`;
  if (nonEmpty(settings.apiKeyHelper)) {
    throw new CliError("Claude Code already has an apiKeyHelper that ai& does not manage.", {
      hint,
    });
  }
  for (const key of [BASE_URL_KEY, TOKEN_KEY, ...FOREIGN_PROVIDER_KEYS]) {
    if (nonEmpty(env[key]) && env[key] !== ENV_OFF) {
      throw new CliError(`Claude Code already sets env.${key}, which ai& does not manage.`, {
        hint,
      });
    }
  }
}

async function probe(): Promise<ProbeResult> {
  let settings: Record<string, unknown>;
  try {
    const path = await wiredSettingsPath();
    settings = parseSettings(path, await readTextIfExists(path));
  } catch {
    return { active: false, model: null };
  }
  const active = routedByUs(asObject(settings.env));
  return { active, model: (active && startupModel(settings).model) || null };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = claudeSettingsPath();
  const wired = await getAddedState<ClaudeRecord>(CLAUDE_ID);
  if (wired?.path && wired.path !== path) {
    // Two wired files would share one record, and off would hand one file's
    // values to the other. A record whose file lost our marker is stale.
    if (await markedFile(wired.path)) {
      throw new CliError(`Claude Code is already wired through ${wired.path}.`, {
        hint: "Run aiand claude off first, then aiand claude on for the new CLAUDE_CONFIG_DIR.",
      });
    }
    await clearAddedState(CLAUDE_ID);
  }
  const raw = await readTextIfExists(path);
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  const settings = parseSettings(path, raw);
  if (settings.env !== undefined && !asObject(settings.env)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const permissions = settings.permissions;
  if (permissions !== undefined && !asObject(permissions)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const deny = asObject(permissions)?.deny;
  if (deny !== undefined && !Array.isArray(deny)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }

  const env = asObject(settings.env) ?? {};
  const marked = env[MARKER_KEY] === ENV_ON;
  if (!marked) assertNotForeign(path, settings, env);

  // The prior on's record only describes this file while our marker is in it.
  // A marked file whose record is gone: the owned keys it holds are ours,
  // never values to hand back on off.
  const prior = marked ? await getAddedState<ClaudeRecord>(CLAUDE_ID) : null;
  const priorEnv: Env = prior?.env ?? (marked ? ownedValues(env) : {});
  const previousEnv: Env = { ...(prior?.previousEnv ?? {}) };
  const createdKeys = new Set(prior?.createdKeys ?? []);
  const warnings: string[] = [];
  const isNative = input.model === "native";
  const catalog = input.catalog;

  const desired: Env = gatewayEnv(input.apiKey, claudeBaseUrl(input.baseUrl));
  const kept: Env = {};
  if (!isNative) {
    const pinned = input.pinModel ? input.model : claudeDefaultModel(catalog, input.profileModel);
    for (const [slot, value] of Object.entries(slotEnv(pinned, fastModel(catalog, pinned)))) {
      const current = env[slot];
      if (!input.pinModel && typeof current === "string" && inCatalog(catalog, current)) {
        kept[slot] = current;
      } else {
        desired[slot] = value;
      }
    }
    // Every model Claude Code may run: each slot, and a startup model the
    // user set that ai& serves (one it cannot serve is set aside below).
    const effective = { ...kept, ...desired };
    const inPlay = [...MAIN_SLOTS, FAST_SLOT].map((slot) => effective[slot]!);
    for (const { path: at } of MODEL_SETTINGS) {
      const value = settingAt(settings, at);
      if (nonEmpty(value)) inPlay.push(value);
    }
    const tokens = contextTokens(catalog, inPlay);
    if (tokens) desired[CONTEXT_KEY] = tokens;
  } else {
    warnings.push("Claude Code's own models are not on ai&; pass --model to pick one.");
  }

  let text = raw;
  if (settings.env === undefined) createdKeys.add("env");
  for (const [key, value] of Object.entries(desired)) {
    const current = env[key];
    // Keep the user's value to hand back on off. Never the key or the stamp:
    // a foreign token was refused above, so only an empty one is theirs, and
    // a marked file's token and stamp are ours.
    const recordable = marked
      ? key !== TOKEN_KEY && key !== MARKER_KEY
      : key !== TOKEN_KEY || current === "";
    if (
      typeof current === "string" &&
      current !== priorEnv[key] &&
      !(key in previousEnv) &&
      recordable
    ) {
      previousEnv[key] = current;
    }
    text = jsoncSet(text, ["env", key], value);
  }

  const recordedEnv: Env = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key !== TOKEN_KEY) recordedEnv[key] = value;
  }
  for (const [key, value] of Object.entries(priorEnv)) {
    if (!(key in desired) && env[key] === value) recordedEnv[key] = value;
  }

  // A concrete model ai& cannot serve would fail every request: set it aside
  // for off to restore. One ai& serves is the user's choice and stays, even
  // under --model (which pins the slots, not their startup model). Aliases
  // resolve through our slots and stay.
  const removed = { removedModel: prior?.removedModel, removedEnvModel: prior?.removedEnvModel };
  for (const { path: at, label, record } of MODEL_SETTINGS) {
    const value = settingAt(settings, at);
    if (isNative || !nonEmpty(value) || isAlias(value) || inCatalog(catalog, value)) continue;
    text = jsoncDelete(text, [...at]);
    removed[record] = value;
    warnings.push(`Set aside your ${label} (${value}); aiand claude off puts it back.`);
  }

  const addedDeny = [...(prior?.addedDeny ?? [])];
  const denyList: unknown[] = Array.isArray(deny) ? deny : [];
  const missing = DENIED_TOOLS.filter((tool) => !denyList.includes(tool));
  if (missing.length > 0) {
    if (permissions === undefined) createdKeys.add("permissions");
    if (deny === undefined) createdKeys.add("permissions.deny");
    text = jsoncSet(text, ["permissions", "deny"], [...denyList, ...missing]);
    addedDeny.push(...missing);
  }

  const picker = applyModelPicker(
    text,
    settings.modelPicker,
    prior?.modelPicker,
    buildModelPicker(catalog),
  );
  text = picker.text;
  if (picker.warning) warnings.push(picker.warning);

  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    await chmod(path, PRIVATE_FILE_MODE);
  }
  await recordAddedState(CLAUDE_ID, {
    path,
    env: recordedEnv,
    previousEnv,
    ...removed,
    addedDeny,
    createdKeys: [...createdKeys],
    modelPicker: picker.recorded,
    previousMode,
    created: created || prior?.created === true,
  });

  // --model pins the slots; a model setting (concrete, or an alias resolving
  // to another slot) can still decide where Claude Code starts.
  const { model: startsOn, setting } = startupModel(parseWritten(text));
  if (input.pinModel && setting && startsOn !== input.model) {
    const shown = setting.value === startsOn ? startsOn : `${setting.value} → ${startsOn}`;
    warnings.push(
      `Claude Code still starts on your ${setting.label} setting (${shown}); remove it or use /model to switch to ${input.model}.`,
    );
  }
  return {
    model: startsOn ?? input.model,
    catalogModel: startsOn && inCatalog(catalog, startsOn) ? startsOn : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const added = await getAddedState<ClaudeRecord>(CLAUDE_ID);
  const path = added?.path ?? claudeSettingsPath();
  const raw = await readTextIfExists(path);
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(path, raw);
  } catch {
    // Keep the record: once the JSON is fixed, off can still tell our
    // values from the user's.
    return {
      stripped: false,
      notes: [`${path} is not valid JSON; fix it, then run aiand claude off again.`],
    };
  }
  const env = asObject(settings.env);
  if (env?.[MARKER_KEY] !== ENV_ON) {
    await clearAddedState(CLAUDE_ID);
    return { stripped: false };
  }

  const previousEnv = added?.previousEnv ?? {};
  const created = new Set(added?.createdKeys ?? []);
  const notes: string[] = [];
  let text = raw;

  for (const key of [TOKEN_KEY, MARKER_KEY]) text = restoreEnv(text, key, previousEnv[key]);
  // Without a record (lost state), every other key we write reads as ours.
  const ours: Env = added?.env ?? ownedValues(env);
  for (const [key, value] of Object.entries(ours)) {
    if (key === MARKER_KEY || env[key] === undefined) continue;
    if (env[key] !== value) {
      notes.push(`left env.${key} because you edited it`);
      continue;
    }
    text = restoreEnv(text, key, previousEnv[key]);
  }
  if (created.has("env") && Object.keys(asObject(parseWritten(text).env) ?? {}).length === 0) {
    text = jsoncDelete(text, ["env"]);
  }

  // Known limit: a pre-existing deny array is re-rendered on removal; keep its
  // raw slice in the record if byte-identical deny arrays ever matter.
  const addedDeny = added?.addedDeny ?? [];
  if (addedDeny.length > 0) {
    const deny = asObject(parseWritten(text).permissions)?.deny;
    if (Array.isArray(deny)) {
      const left = deny.filter((tool) => typeof tool !== "string" || !addedDeny.includes(tool));
      if (left.length === 0 && created.has("permissions.deny")) {
        text = jsoncDelete(text, ["permissions", "deny"]);
      } else if (left.length !== deny.length) {
        text = jsoncSet(text, ["permissions", "deny"], left);
      }
    }
    const permissions = asObject(parseWritten(text).permissions);
    if (permissions && Object.keys(permissions).length === 0 && created.has("permissions")) {
      text = jsoncDelete(text, ["permissions"]);
    }
  }

  for (const { path: at, label, record } of MODEL_SETTINGS) {
    const removedValue = added?.[record];
    if (!removedValue) continue;
    if (settingAt(parseWritten(text), at) === undefined) {
      text = jsoncSet(text, [...at], removedValue);
    } else {
      notes.push(`left ${label} because you set a new one (yours was ${removedValue})`);
    }
  }

  const picker = stripModelPicker(text, parseWritten(text).modelPicker, added?.modelPicker);
  text = picker.text;
  if (picker.note) notes.push(picker.note);

  if (text !== raw) {
    const empty = Object.keys(parseWritten(text)).length === 0;
    if (empty && (added?.created === true || (await fileCreatedByUs(CLAUDE_ID, path)))) {
      await unlink(path);
    } else {
      // The key left the file: hand back the mode the user had before on.
      await writeFileAtomic(path, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE });
    }
  }
  await clearAddedState(CLAUDE_ID);
  return { stripped: true, notes };
}

const CLAUDE_INSTALL = INSTALL_HINTS.claude!;

export const claudeAdapter: AgentAdapter = {
  id: CLAUDE_ID,
  label: "Claude Code",
  bin: CLAUDE_BIN,
  install: CLAUDE_INSTALL,
  aliases: ["claude-code"],
  detect(): DetectResult {
    return detectBinary(CLAUDE_BIN);
  },
  managedFiles(): string[] {
    // The wired file too, so restore works from a shell without its CLAUDE_CONFIG_DIR.
    const wired = getAddedStateSync<ClaudeRecord>(CLAUDE_ID)?.path;
    const current = claudeSettingsPath();
    return wired && wired !== current ? [current, wired] : [current];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    const path = await wiredSettingsPath();
    const raw = await readTextIfExists(path);
    const env = asObject(parseSettings(path, raw).env);
    if (env?.[MARKER_KEY] !== ENV_ON) return false;
    if (env[TOKEN_KEY] === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from another
    // profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && env[TOKEN_KEY] !== input.previousKey) return false;
    await writeFileAtomic(path, jsoncSet(raw, ["env", TOKEN_KEY], input.apiKey), {
      mode: PRIVATE_FILE_MODE,
    });
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: `--settings` layers a throwaway 0600 file over
    // the user's settings, and Claude Code loads the token from it. It then
    // exports that env block, key included, to every Bash command and hook it
    // runs, as it does after `on`; an apiKeyHelper would keep the key out.
    const main = input.model ?? claudeDefaultModel(input.catalog, input.profileModel);
    const settings = buildClaudeSettings({
      apiKey: input.apiKey,
      baseUrl: claudeBaseUrl(input.baseUrl),
      main,
      catalog: input.catalog,
    });
    const dir = await mkdtemp(join(tmpdir(), "aiand-claude-"));
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify(settings), { mode: PRIVATE_FILE_MODE });
    return {
      env: {},
      args: ["--settings", file],
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
};
