import { chmod, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "../api/models.js";
import { CliError } from "../cli/errors.js";
import {
  agentHome,
  DEFAULT_BASE_URL,
  isLoopbackHost,
  trimSlash,
  writeFileAtomic,
} from "../config.js";
import { existingFileMode, PRIVATE_FILE_MODE } from "../fsutil.js";
import { resolveDefault } from "./catalog.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import {
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
} from "./managed-file.js";
import { clearAddedState, fileCreatedByUs, getAddedState, recordAddedState } from "./snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "./types.js";

const CLAUDE_ID = "claude";
const CLAUDE_BIN = "claude";

const MARKER_KEY = "AIAND_MANAGED";
const MARKER_VALUE = "1";
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
const MAIN_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
const ENV_MODEL_KEY = "ANTHROPIC_MODEL";
const REPORTED_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
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
const MODEL_ALIASES = new Set(["default", "best", "opus", "sonnet", "haiku", "fable", "opusplan"]);

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
  previousMode?: number;
  created?: boolean;
};

function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(agentHome(), ".claude");
  return join(dir, "settings.json");
}

/**
 * While wired, the file `on` wrote: logout, uninstall and rotation run from
 * shells that may not share the CLAUDE_CONFIG_DIR it was wired under.
 */
async function wiredSettingsPath(): Promise<string> {
  return (await getAddedState<ClaudeRecord>(CLAUDE_ID))?.path ?? claudeSettingsPath();
}

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
function claudeBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

const inCatalog = (catalog: Model[], id: string): boolean =>
  catalog.some((model) => model.id === id);

const isAlias = (model: string): boolean => MODEL_ALIASES.has(model.replace(/\[1m\]$/i, ""));

function claudeDefaultModel(catalog: Model[], profileModel?: string, fallback?: string): string {
  if (profileModel && inCatalog(catalog, profileModel)) return profileModel;
  return MAIN_PREFERRED.find((id) => inCatalog(catalog, id)) ?? fallback ?? resolveDefault(catalog);
}

function fastModel(catalog: Model[], main: string): string {
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

function gatewayEnv(apiKey: string, baseUrl: string): Env {
  return {
    [BASE_URL_KEY]: baseUrl,
    [TOKEN_KEY]: apiKey,
    [API_KEY_KEY]: "",
    [MARKER_KEY]: MARKER_VALUE,
    [ATTRIBUTION_KEY]: "0",
    [DISABLE_1M_KEY]: "1",
    // A switch left on in the shell or a lower settings file would route
    // Claude Code to that cloud whatever ANTHROPIC_BASE_URL says.
    ...Object.fromEntries(FOREIGN_PROVIDER_KEYS.map((key) => [key, "0"])),
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

/** The slot each alias reads; `default` and anything unknown start on sonnet. */
const ALIAS_SLOTS: Record<string, string> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  opusplan: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  best: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  haiku: FAST_SLOT,
};

/**
 * The model Claude Code starts on: `env.ANTHROPIC_MODEL` beats the `model`
 * setting; a concrete id is used as is, and an alias resolves through its slot.
 */
function startupModel(settings: Record<string, unknown>): string | undefined {
  const env = asObject(settings.env) ?? {};
  const envModel = env[ENV_MODEL_KEY];
  const model = nonEmpty(envModel) ? envModel : settings.model;
  if (nonEmpty(model) && !isAlias(model)) return model;
  const alias = nonEmpty(model) ? model.replace(/\[1m\]$/i, "").toLowerCase() : "";
  const slotValue = env[ALIAS_SLOTS[alias] ?? REPORTED_SLOT];
  return typeof slotValue === "string" ? slotValue : undefined;
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
  return { model: main, env, permissions: { deny: DENIED_TOOLS } };
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A file carrying our marker; one we cannot parse counts, so its record survives until it is fixed. */
async function markedFile(path: string): Promise<boolean> {
  try {
    const env = asObject(parseSettings(path, await readTextIfExists(path)).env);
    return env?.[MARKER_KEY] === MARKER_VALUE;
  } catch {
    return true;
  }
}

function routedByUs(env: Record<string, unknown> | undefined): boolean {
  if (env?.[MARKER_KEY] !== MARKER_VALUE) return false;
  const baseUrl = env[BASE_URL_KEY];
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

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

const parse = (text: string): Record<string, unknown> => asObject(parseJsonc(text)) ?? {};

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
    if (nonEmpty(env[key]) && env[key] !== "0") {
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
  const env = asObject(settings.env);
  const active = routedByUs(env);
  const model = active ? startupModel(settings) : undefined;
  return { active, model: model ?? null };
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
  const marked = env[MARKER_KEY] === MARKER_VALUE;
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
    const main = input.pinModel
      ? input.model
      : claudeDefaultModel(catalog, input.profileModel, input.model);
    for (const [slot, value] of Object.entries(slotEnv(main, fastModel(catalog, main)))) {
      const current = env[slot];
      if (!input.pinModel && typeof current === "string" && inCatalog(catalog, current)) {
        kept[slot] = current;
      } else {
        desired[slot] = value;
      }
    }
    const effective = { ...kept, ...desired };
    const slots = [...MAIN_SLOTS, FAST_SLOT].map((slot) => effective[slot]!);
    const tokens = contextTokens(catalog, slots);
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
  let removedModel = prior?.removedModel;
  const model = settings.model;
  if (!isNative && nonEmpty(model) && !isAlias(model)) {
    if (!inCatalog(catalog, model)) {
      text = jsoncDelete(text, ["model"]);
      removedModel = model;
      warnings.push(`Set aside your model (${model}); aiand claude off puts it back.`);
    }
  }
  // env.ANTHROPIC_MODEL outranks the `model` setting, so the same rule applies.
  let removedEnvModel = prior?.removedEnvModel;
  const envModel = env[ENV_MODEL_KEY];
  if (!isNative && nonEmpty(envModel) && !isAlias(envModel) && !inCatalog(catalog, envModel)) {
    text = jsoncDelete(text, ["env", ENV_MODEL_KEY]);
    removedEnvModel = envModel;
    warnings.push(
      `Set aside your env.${ENV_MODEL_KEY} (${envModel}); aiand claude off puts it back.`,
    );
  }

  const addedDeny = [...(prior?.addedDeny ?? [])];
  const denyList = Array.isArray(deny) ? (deny as unknown[]) : [];
  const missing = DENIED_TOOLS.filter((tool) => !denyList.includes(tool));
  if (missing.length > 0) {
    if (permissions === undefined) createdKeys.add("permissions");
    if (deny === undefined) createdKeys.add("permissions.deny");
    text = jsoncSet(text, ["permissions", "deny"], [...denyList, ...missing]);
    addedDeny.push(...missing);
  }

  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? 0o644;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    await chmod(path, PRIVATE_FILE_MODE);
  }
  await recordAddedState(CLAUDE_ID, {
    path,
    env: recordedEnv,
    previousEnv,
    removedModel,
    removedEnvModel,
    addedDeny,
    createdKeys: [...createdKeys],
    previousMode,
    created: created || prior?.created === true,
  });

  const written = parse(text);
  const main = startupModel(written);
  // --model pins the slots; a `model` setting (concrete, or an alias like
  // `haiku` resolving to another slot) can still decide where Claude Code starts.
  if (input.pinModel && main !== input.model && nonEmpty(written.model)) {
    warnings.push(
      `Claude Code still starts on your model setting (${written.model === main ? main : `${written.model} → ${main}`}); remove it or use /model to switch to ${input.model}.`,
    );
  }
  return {
    model: main ?? input.model,
    catalogModel: main && inCatalog(catalog, main) ? main : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const recorded = await getAddedState<ClaudeRecord>(CLAUDE_ID);
  const path = recorded?.path ?? claudeSettingsPath();
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
  if (env?.[MARKER_KEY] !== MARKER_VALUE) {
    await clearAddedState(CLAUDE_ID);
    return { stripped: false };
  }

  const added = recorded;
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
  if (created.has("env") && Object.keys(asObject(parse(text).env) ?? {}).length === 0) {
    text = jsoncDelete(text, ["env"]);
  }

  // Known limit: a pre-existing deny array is re-rendered on removal; keep its
  // raw slice in the record if byte-identical deny arrays ever matter.
  const addedDeny = added?.addedDeny ?? [];
  if (addedDeny.length > 0) {
    const deny = asObject(parse(text).permissions)?.deny;
    if (Array.isArray(deny)) {
      const left = deny.filter((tool) => !addedDeny.includes(tool as string));
      if (left.length === 0 && created.has("permissions.deny")) {
        text = jsoncDelete(text, ["permissions", "deny"]);
      } else if (left.length !== deny.length) {
        text = jsoncSet(text, ["permissions", "deny"], left);
      }
    }
    const permissions = asObject(parse(text).permissions);
    if (permissions && Object.keys(permissions).length === 0 && created.has("permissions")) {
      text = jsoncDelete(text, ["permissions"]);
    }
  }

  if (added?.removedModel) {
    const model = parse(text).model;
    if (model === undefined) text = jsoncSet(text, ["model"], added.removedModel);
    else notes.push(`left model because you set a new one (yours was ${added.removedModel})`);
  }
  if (added?.removedEnvModel) {
    const envModel = asObject(parse(text).env)?.[ENV_MODEL_KEY];
    if (envModel === undefined) {
      text = jsoncSet(text, ["env", ENV_MODEL_KEY], added.removedEnvModel);
    } else {
      notes.push(
        `left env.${ENV_MODEL_KEY} because you set a new one (yours was ${added.removedEnvModel})`,
      );
    }
  }

  if (text !== raw) {
    const empty = Object.keys(parse(text)).length === 0;
    if (empty && (added?.created === true || (await fileCreatedByUs(CLAUDE_ID, path)))) {
      await unlink(path);
    } else {
      // The key left the file: hand back the mode the user had before on.
      await writeFileAtomic(path, text, { mode: added?.previousMode ?? 0o644 });
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
    return [claudeSettingsPath()];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    const path = await wiredSettingsPath();
    const raw = await readTextIfExists(path);
    const env = asObject(parseSettings(path, raw).env);
    if (env?.[MARKER_KEY] !== MARKER_VALUE) return false;
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
    // Works with no prior `on`: `--settings` layers a throwaway 0600 file
    // over the user's settings. The launcher's child env stays key-free;
    // Claude Code loads the token from the file itself, as it does after `on`.
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
      clear: [],
      args: ["--settings", file],
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
};
