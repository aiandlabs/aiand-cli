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

/** The adapter id (`aiand claude`), also the key for its snapshot state. */
const CLAUDE_ID = "claude";
const CLAUDE_BIN = "claude";

/**
 * Ownership marker, inside `env`: an unknown top-level settings key makes
 * Claude Code print a settings warning on every start, while `env` takes any
 * variable name.
 */
const MARKER_KEY = "AIAND_MANAGED";
const MARKER_VALUE = "1";
const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
/** The session key, sent as `Authorization: Bearer`; outranks ANTHROPIC_API_KEY. */
const TOKEN_KEY = "ANTHROPIC_AUTH_TOKEN";
/** Blanked so a key exported in the shell cannot win over ours. */
const API_KEY_KEY = "ANTHROPIC_API_KEY";
/**
 * The gateway flattens `system` into one string, so Claude Code's attribution
 * block would reach the model as prompt text; its docs name this variable as
 * the client-side fix for a gateway that reshapes `system`.
 */
const ATTRIBUTION_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER";
/**
 * A model id tagged `[1m]` (the plan default resolving through our sonnet
 * slot) makes Claude Code assume a 1M window and ignore CONTEXT_KEY; this
 * sizes it like the untagged id so the cap below applies.
 */
const DISABLE_1M_KEY = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
/** Model slots that get the main model: the `opus`/`sonnet`/`fable` aliases and subagents. */
const MAIN_SLOTS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];
/** Background work (titles, WebFetch summaries) runs on the `haiku` alias. */
const FAST_SLOT = "ANTHROPIC_DEFAULT_HAIKU_MODEL";
/** The slot `status` reports: the alias Claude Code starts on without a `model` setting. */
const REPORTED_SLOT = "ANTHROPIC_DEFAULT_SONNET_MODEL";
/**
 * One budget for every non-Anthropic model id: Claude Code assumes 200k
 * without it, and auto-compacts against whatever it is given.
 */
const CONTEXT_KEY = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
// ponytail: one cap for every model. Open models get unreliable at tool
// calling well before their advertised 1M window (a glm-5.3 session looped
// at ~270k), so Claude Code should compact long sessions first. A per-model
// catalog field (an "effective context") would retire it.
const CONTEXT_CAP_TOKENS = 200_000;
/** WebSearch is an Anthropic server-side tool the gateway cannot run; WebFetch runs locally. */
const DENIED_TOOLS = ["WebSearch"];
/** Routing another provider already owns: `on` refuses rather than fight it. */
const FOREIGN_PROVIDER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
/** Claude Code's model aliases (optionally `[1m]`): they resolve through our slots. */
const MODEL_ALIASES = new Set(["default", "best", "opus", "sonnet", "haiku", "fable", "opusplan"]);

// ponytail: curated lists filtered through the live catalog; a catalog
// `tier`/`default_for` field would retire them.
/** Main-model order for Claude Code when the profile names none: vision first, since pasting screenshots is routine there. */
const MAIN_PREFERRED = ["moonshotai/kimi-k3", "qwen/qwen3.8-27b", "moonshotai/kimi-k2.7-code"];
/** Fast-model order for the haiku slot; falls back to the main model. */
const FAST_PREFERRED = ["deepseek-ai/deepseek-v4-flash", "google/gemma-4-31b-it"];

const INVALID_CONFIG_HINT = "Fix it by hand, then run aiand claude on again.";

type Env = Record<string, string>;

function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(agentHome(), ".claude");
  return join(dir, "settings.json");
}

/** `--base-url` origin, or the production gateway. Claude Code appends `/v1/messages` itself. */
function claudeBaseUrl(baseUrl?: string): string {
  return trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL;
}

const inCatalog = (catalog: Model[], id: string): boolean =>
  catalog.some((model) => model.id === id);

const isAlias = (model: string): boolean => MODEL_ALIASES.has(model.replace(/\[1m\]$/i, ""));

/**
 * The profile's model when still listed, else the Claude order, else
 * `fallback` (the model setup already resolved), else the global default.
 */
function claudeDefaultModel(catalog: Model[], profileModel?: string, fallback?: string): string {
  if (profileModel && inCatalog(catalog, profileModel)) return profileModel;
  return MAIN_PREFERRED.find((id) => inCatalog(catalog, id)) ?? fallback ?? resolveDefault(catalog);
}

function fastModel(catalog: Model[], main: string): string {
  return FAST_PREFERRED.find((id) => inCatalog(catalog, id)) ?? main;
}

/** Routing plus the client settings every ai& session needs, whatever the model. */
function gatewayEnv(apiKey: string, baseUrl: string): Env {
  return {
    [BASE_URL_KEY]: baseUrl,
    [TOKEN_KEY]: apiKey,
    [API_KEY_KEY]: "",
    [MARKER_KEY]: MARKER_VALUE,
    [ATTRIBUTION_KEY]: "0",
    [DISABLE_1M_KEY]: "1",
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

/** A marked file with no record: every owned key it holds reads as ours. */
function ownedValues(env: Record<string, unknown>): Env {
  const owned: Env = {};
  for (const key of OWNED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") owned[key] = value;
  }
  return owned;
}

/** Put the user's recorded value back, or remove the key when they had none. */
const restoreEnv = (text: string, key: string, previous: string | undefined): string =>
  previous !== undefined ? jsoncSet(text, ["env", key], previous) : jsoncDelete(text, ["env", key]);

/** The model Claude Code starts on: a concrete `model` setting wins over the slots. */
function startupModel(settings: Record<string, unknown>, env: Env): string | undefined {
  const model = settings.model;
  if (nonEmpty(model) && !isAlias(model)) return model;
  return env[REPORTED_SLOT];
}

/** The smaller window of the two models in play, capped, so auto-compact is safe for both. */
function contextTokens(catalog: Model[], ids: string[]): string | undefined {
  const windows = ids
    .map((id) => catalog.find((model) => model.id === id)?.context_window)
    .filter((window): window is number => typeof window === "number" && window > 0);
  return windows.length > 0 ? String(Math.min(CONTEXT_CAP_TOKENS, ...windows)) : undefined;
}

/**
 * The one builder for a whole ai& settings object, used by sessionLaunch;
 * enable() writes the same keys one by one through the same helpers.
 */
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
  const env: Env = { ...gatewayEnv(apiKey, baseUrl), ...slotEnv(main, fast) };
  const tokens = contextTokens(catalog, [main, fast]);
  if (tokens) env[CONTEXT_KEY] = tokens;
  return { model: main, env, permissions: { deny: DENIED_TOOLS } };
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Our marker plus an https (or loopback http) base URL. */
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

/** Parse settings.json strictly: a syntax error or non-object root is a CliError. */
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

/** Refuse settings another route already owns: our writes would silently fight it. */
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
    const path = claudeSettingsPath();
    settings = parseSettings(path, await readTextIfExists(path));
  } catch {
    // A file mid-edit must not wedge `claude status`.
    return { active: false, model: null };
  }
  const env = asObject(settings.env);
  const active = routedByUs(env);
  const model = active ? startupModel(settings, ownedValues(env ?? {})) : undefined;
  return { active, model: model ?? null };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = claudeSettingsPath();
  const raw = await readTextIfExists(path);
  // Only a missing file counts as created by us; off never unlinks the user's.
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
  const prior = marked ? await getAddedState(CLAUDE_ID) : null;
  const priorEnv: Env = prior?.env ?? (marked ? ownedValues(env) : {});
  const previousEnv: Env = { ...(prior?.previousEnv ?? {}) };
  const createdKeys = new Set(prior?.createdKeys ?? []);
  const warnings: string[] = [];
  const isNative = input.model === "native";
  const catalog = input.catalog;

  const desired: Env = gatewayEnv(input.apiKey, claudeBaseUrl(input.baseUrl));
  // Slot values already naming a catalog model stay unless --model: the
  // user's choice, or a previous on's (still ours when unchanged).
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
    const tokens = contextTokens(catalog, [effective[REPORTED_SLOT]!, effective[FAST_SLOT]!]);
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

  // Everything we wrote except the key itself, plus what an earlier on wrote
  // and this one left in place (kept slots, or every slot under `native`).
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
      // What is being removed now is what off must hand back: a model set
      // after an earlier set-aside replaces the older one.
      removedModel = model;
      warnings.push(`Set aside your model (${model}); aiand claude off puts it back.`);
    } else if (input.pinModel && model !== input.model) {
      warnings.push(
        `Claude Code still starts on your model setting (${model}); remove it or use /model to switch to ${input.model}.`,
      );
    }
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

  // A re-on finds the file at 0600 (our lock); keep the first on's mode.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? 0o644;
  if (text !== raw) {
    await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  } else {
    // The baked key must stay 0600 for as long as it lives here.
    await chmod(path, PRIVATE_FILE_MODE);
  }
  await recordAddedState(CLAUDE_ID, {
    env: recordedEnv,
    previousEnv,
    removedModel,
    addedDeny,
    createdKeys: [...createdKeys],
    previousMode,
    created: created || prior?.created === true,
  });

  const written = parse(text);
  const main = startupModel(written, ownedValues(asObject(written.env) ?? {}));
  return {
    model: main ?? input.model,
    catalogModel: main && inCatalog(catalog, main) ? main : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const path = claudeSettingsPath();
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
  // Everything below is gated on our stamp.
  if (env?.[MARKER_KEY] !== MARKER_VALUE) {
    await clearAddedState(CLAUDE_ID);
    return { stripped: false };
  }

  const added = await getAddedState(CLAUDE_ID);
  const previousEnv = added?.previousEnv ?? {};
  const created = new Set(added?.createdKeys ?? []);
  const notes: string[] = [];
  let text = raw;

  // The key and the stamp are ours whatever else changed.
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

  // ponytail: a pre-existing deny array is re-rendered on removal; keep its
  // raw slice in added-state if byte-identical deny arrays ever matter.
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
    // Marker-gated like disable(): a foreign token is never touched.
    const path = claudeSettingsPath();
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
