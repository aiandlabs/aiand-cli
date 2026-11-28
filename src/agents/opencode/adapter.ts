import { existsSync } from "node:fs";
import { chmod, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CliError } from "../../cli/errors.js";
import { agentHome, isRoutableBaseUrl, trimSlash, writeFileAtomic } from "../../config.js";
import { DEFAULT_FILE_MODE, existingFileMode, PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import { takeFlagValues } from "../launch.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
  parseJsonc,
  readTextIfExists,
  writeKeyFile,
} from "../managed-file.js";
import { makeOverlayDir } from "../overlays.js";
import { clearAddedState, fileCreatedByUs, getAddedState, recordAddedState } from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeDetail,
  ProbeResult,
  SessionLaunchInput,
} from "../types.js";
import { getApiModels, modelsFromCatalog, type OpencodeModelEntry } from "./models.js";

type OpencodeRecord = {
  model?: string;
  previousModel?: string;
  smallModel?: string; // `small_model` (titles, summaries), written beside `model` and handed back alike.
  previousSmallModel?: string;
  previousMode?: number; // File mode before on locked it to 0600; disable() restores it.
  providerAiand?: unknown;
  permission?: Record<string, unknown>; // The complete permission object written and replaced.
  previousPermission?: Record<string, unknown>;
  created?: boolean;
};

const OPENCODE_BASE_URL = "https://api.aiand.com/v1"; // Where OpenCode dials every ai& model.

const OPENCODE_ID = "opencode"; // Adapter id and snapshot-state key.
const OPENCODE_BIN = "opencode";
const OPENCODE_ZEN_PROVIDER_ID = "opencode"; // Built-in Zen provider, hidden in the launcher.
const OPENCODE_PROVIDER_ID = "aiand"; // Config provider id and model-ref prefix.
/** Ownership marker for surgical off/logout: provider options allows extras, while strict root/provider schemas reject root keys (one breaks 1.18.15). */
const OPENCODE_MARKER_KEY = "x-aiand";
const OPENCODE_MARKER_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", OPENCODE_MARKER_KEY];
const OPENCODE_KEY_PATH = ["provider", OPENCODE_PROVIDER_ID, "options", "apiKey"];

const PROJECT_CONFIG_PATHS = [
  "opencode.json",
  "opencode.jsonc",
  join(".opencode", "opencode.json"),
  join(".opencode", "opencode.jsonc"),
];
const PROJECT_BASE_URL_HINT =
  "Remove the project baseURL override before permanent wiring, or use `aiand run-agent opencode` instead of permanent wiring.";

const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand opencode on again."; // Recovery hint.

function opencodeConfigPath(): string {
  return join(agentHome(), ".config", "opencode", "opencode.json");
}

type OpencodeProviderOptions = {
  npm: string;
  name: string;
  baseURL: string;
};

const isOpencodePermission = (value: unknown) =>
  typeof value === "string" && ["allow", "ask", "deny"].includes(value);

/** Add one deny pattern while retaining an object map or a scalar default as `*`. */
function withDeniedPattern(value: unknown, pattern: string): Record<string, unknown> {
  if (value === undefined) return { [pattern]: "deny" };
  if (isOpencodePermission(value)) return { "*": value, [pattern]: "deny" };
  const patterns = asObject(value);
  if (patterns && Object.values(patterns).every(isOpencodePermission)) {
    return { ...patterns, [pattern]: "deny" };
  }
  throw notValidJsonError(opencodeConfigPath(), INVALID_CONFIG_HINT);
}
function permissionWithCredentialDenials(
  permission: Record<string, unknown> | undefined,
  deniedPath: string,
): Record<string, unknown> {
  const { external_directory: external, webfetch } = permission ?? {};
  if ([external, webfetch].some((value) => value !== undefined && !isOpencodePermission(value)))
    throw notValidJsonError(opencodeConfigPath(), INVALID_CONFIG_HINT);
  return {
    ...permission,
    read: withDeniedPattern(permission?.read, deniedPath),
    external_directory: external === "deny" ? "deny" : "ask",
    webfetch: permission?.webfetch === "deny" ? "deny" : "ask",
    bash: withDeniedPattern(permission?.bash, "aiand key export*"),
  };
}

export function buildOpencodeConfig({
  apiKey,
  model,
  models,
  options,
  lockdown,
  keyFile,
}: {
  apiKey: string;
  model: string;
  models: Record<string, OpencodeModelEntry>;
  options: OpencodeProviderOptions;
  lockdown?: boolean;
  keyFile?: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: options.npm,
        name: options.name,
        options: {
          apiKey,
          baseURL: options.baseURL,
          [OPENCODE_MARKER_KEY]: true, // Nested: root/provider objects reject unknown keys.
        },
        models,
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model}`,
    permission: permissionWithCredentialDenials(undefined, keyFile ?? opencodeConfigPath()),
  };
  if (lockdown) {
    // Titles and summaries use this model too; left unset, OpenCode may pick one the user did not choose.
    config.small_model = config.model;
    config.enabled_providers = [OPENCODE_PROVIDER_ID]; // Hide every built-in provider from the picker.
    // Zen auto-loads its models; disabled_providers wins over enabled_providers, so this holds either way.
    config.disabled_providers = [OPENCODE_ZEN_PROVIDER_ID];
  }
  return config;
}

const OPENCODE_OPTIONS: OpencodeProviderOptions = {
  npm: "@ai-sdk/openai-compatible",
  name: "ai&",
  baseURL: OPENCODE_BASE_URL,
};

function opencodeBaseURL(baseUrl?: string): string {
  const base = trimSlash(baseUrl ?? "");
  return base ? `${base}/v1` : OPENCODE_BASE_URL;
}

function aiandProviderField(
  parsed: Record<string, unknown>,
  field: "options" | "models",
): Record<string, unknown> | undefined {
  const provider = parsed.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const aiand = (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];
  if (!aiand || typeof aiand !== "object" || Array.isArray(aiand)) return undefined;
  const value = (aiand as Record<string, unknown>)[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

const providerOptions = (parsed: Record<string, unknown>) => aiandProviderField(parsed, "options");

/** Project overrides through the nearest Git root, or only cwd outside Git; bad files fail closed. */
async function projectBaseUrlOverrides(cwd: string): Promise<string[]> {
  const start = resolve(cwd);
  const directories = [start];
  for (
    let directory = start;
    !existsSync(join(directory, ".git"));
    directory = dirname(directory)
  ) {
    if (dirname(directory) === directory) {
      directories.splice(1);
      break;
    }
    directories.push(dirname(directory));
  }
  const overrides: string[] = [];
  for (const directory of directories) {
    for (const relative of PROJECT_CONFIG_PATHS) {
      const path = join(directory, relative);
      const text = await readTextIfExists(path);
      if (!text.trim()) continue;
      let parsed: unknown;
      try {
        parsed = parseJsonc(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw notValidJsonError(path, PROJECT_BASE_URL_HINT);
      }
      const config = asObject(parsed);
      if (config === undefined) throw notValidJsonError(path, PROJECT_BASE_URL_HINT);
      const options = providerOptions(config);
      // Substitution does not make a project-selected {env:...}/{file:...} endpoint safe.
      if (typeof options?.baseURL === "string" && options.baseURL.length > 0) {
        overrides.push(path);
      }
    }
  }
  return overrides;
}

async function enableGuard({ force }: { force: boolean }): Promise<void> {
  if (force) return;
  const [override] = await projectBaseUrlOverrides(process.cwd());
  if (override === undefined) return;
  throw new CliError(
    `${override} sets a project provider.aiand.options.baseURL that can redirect your ai& session key.`,
    { hint: PROJECT_BASE_URL_HINT },
  );
}

function hasOwnershipMarker(parsed: Record<string, unknown>): boolean {
  return providerOptions(parsed)?.[OPENCODE_MARKER_KEY] === true;
}

/** Active routing needs our marker and a routable URL; foreign names and unusable marked URLs read inactive. */
function configIsOurs(parsed: Record<string, unknown>): boolean {
  if (!hasOwnershipMarker(parsed)) return false;
  return isRoutableBaseUrl(providerOptions(parsed)?.baseURL);
}

function withoutApiKey(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const clone = structuredClone(block) as Record<string, unknown>;
  const options = clone.options;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const rest = { ...(options as Record<string, unknown>) };
    delete rest.apiKey;
    clone.options = rest;
  }
  return clone;
}
async function readOpencodeConfig(): Promise<Record<string, unknown>> {
  const path = opencodeConfigPath();
  const text = await readTextIfExists(path);
  if (!text.trim()) return {};
  try {
    const parsed: unknown = parseJsonc(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
}
async function probeDetail(): Promise<ProbeDetail> {
  let parsed: Record<string, unknown>;
  try {
    parsed = await readOpencodeConfig();
  } catch {
    return { active: false, model: null };
  }
  const active = configIsOurs(parsed);
  const current = String(providerOptions(parsed)?.baseURL);
  const added = await getAddedState<OpencodeRecord>(OPENCODE_ID).catch(() => null);
  const expected = asObject(asObject(added?.providerAiand)?.options)?.baseURL;
  return {
    active,
    model: active && typeof parsed.model === "string" && parsed.model ? parsed.model : null,
    ...(active ? { baseUrl: current } : {}),
    ...(active && typeof expected === "string" && expected && expected !== current
      ? { changedOutsideAiand: { baseUrl: current } }
      : {}),
  };
}
async function probe(): Promise<ProbeResult> {
  const { active, model, changedOutsideAiand } = await probeDetail();
  return { active, model, ...(changedOutsideAiand ? { changedOutsideAiand } : {}) };
}
async function enable(input: EnableInput): Promise<EnableResult> {
  const path = opencodeConfigPath();
  const raw = await readTextIfExists(path);
  let created = false; // Only a missing file is ours to unlink; a pre-existing empty file is the user's.
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  let current: Record<string, unknown> = {};
  if (raw.trim().length !== 0) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw notValidJsonError(path, INVALID_CONFIG_HINT);
    }
    current = parsed as Record<string, unknown>;
  }

  if (current.provider !== undefined && asObject(current.provider) === undefined) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }

  const existingPermission = asObject(current.permission);
  if (current.permission !== undefined && existingPermission === undefined) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const nextPermission = permissionWithCredentialDenials(existingPermission, path);

  const currentProviders = (current.provider ?? {}) as Record<string, unknown>;
  const existingAiand = currentProviders[OPENCODE_PROVIDER_ID];
  const marked = hasOwnershipMarker(current);
  const foreignAiand = Boolean(existingAiand) && !marked;

  if (foreignAiand) {
    throw new CliError("OpenCode already has a provider.aiand block that ai& does not manage.", {
      hint: "Remove or rename the foreign block by hand, then run aiand opencode on again.",
    });
  }

  const models = await getApiModels(input.baseUrl);
  const isNative = input.model === "native";
  const built = buildOpencodeConfig({
    apiKey: input.apiKey,
    model: isNative ? "" : input.model,
    models,
    options: { ...OPENCODE_OPTIONS, baseURL: opencodeBaseURL(input.baseUrl) },
  });
  const providerBlock = (built.provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID];

  let text = raw;
  const warnings: string[] = [];
  if (!isDeepStrictEqual(existingAiand, providerBlock)) {
    text = jsoncSet(text, ["provider", OPENCODE_PROVIDER_ID], providerBlock);
  }
  if (!isDeepStrictEqual(existingPermission, nextPermission)) {
    text = jsoncSet(text, ["permission"], nextPermission);
  }

  const existingModel = typeof current.model === "string" ? current.model : "";
  // The prior model record is live only while the file holds what it wrote; off or a hand edit makes it stale.
  const prior = await getAddedState<OpencodeRecord>(OPENCODE_ID);
  const permissionLive =
    prior?.permission !== undefined && isDeepStrictEqual(existingPermission, prior.permission);
  const previousPermission = permissionLive ? prior?.previousPermission : existingPermission;
  const priorModel = prior?.model;
  const priorLive = priorModel !== undefined && existingModel === priorModel;
  let recorded: string | undefined;
  let modelWritten: string | undefined;
  let previousModel: string | undefined;
  const existingSmall = typeof current.small_model === "string" ? current.small_model : "";
  const smallLive = prior?.smallModel !== undefined && existingSmall === prior.smallModel;
  let recordedSmall = smallLive ? prior?.smallModel : undefined;
  let previousSmall = smallLive ? prior?.previousSmallModel : undefined;
  if (isNative) {
    recorded = priorLive ? priorModel : undefined; // Leave the agent's own default.
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else if (existingModel && !input.pinModel) {
    if (!existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      warnings.push(
        `Left your existing model (${existingModel}). Switch with aiand opencode on --model <id>.`,
      );
    } else if (existingSmall === "" || smallLive) {
      // A kept ai& model supplies titles and summaries too; old configs may predate small_model.
      text = jsoncSet(text, ["small_model"], existingModel);
      recordedSmall = existingModel;
    }
    recorded = priorLive ? priorModel : undefined;
    previousModel = priorLive ? prior?.previousModel : undefined;
  } else {
    // OpenCode substitutes `{env:}`/`{file:}` in the root model, so write only an id from the cleaned map.
    if (!Object.hasOwn(models, input.model)) {
      throw new CliError(`OpenCode cannot be pointed at ${input.model}.`, {
        hint: "Pass --model with an id from `aiand models`.",
      });
    }
    const nextModel = `${OPENCODE_PROVIDER_ID}/${input.model}`;
    if (existingModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
      // Already our ref: restore the prior target, never our own ref chained onto itself; no record restores to nothing.
      previousModel = priorLive ? prior?.previousModel : undefined;
    } else {
      previousModel = existingModel || undefined;
    }
    text = jsoncSet(text, ["model"], nextModel);
    recorded = nextModel;
    modelWritten = nextModel;
    previousSmall = smallLive ? prior?.previousSmallModel : existingSmall || undefined;
    text = jsoncSet(text, ["small_model"], nextModel);
    recordedSmall = nextModel;
  }

  // Re-on finds our 0600 lock; carry the first recorded mode so off restores the user's original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) {
    await writeKeyFile(path, text, { mode: PRIVATE_FILE_MODE, agentId: OPENCODE_ID });
  } else {
    // Unchanged bytes still re-tighten a loosened file: the baked Session key must stay 0600.
    await chmod(path, PRIVATE_FILE_MODE);
  }
  // A file our prior on created is still ours while it carries the marker and no off has stripped it.
  await recordAddedState(OPENCODE_ID, {
    model: recorded,
    previousModel,
    smallModel: recordedSmall,
    previousSmallModel: previousSmall,
    previousMode,
    providerAiand: withoutApiKey(providerBlock),
    permission: nextPermission,
    previousPermission,
    created: created || (prior?.created === true && marked),
  });

  const reportedModel = modelWritten ? modelWritten : existingModel ? existingModel : input.model; // Report written, existing, or requested default model.
  const ourPrefix = `${OPENCODE_PROVIDER_ID}/`;
  return {
    model: reportedModel,
    catalogModel: reportedModel.startsWith(ourPrefix)
      ? reportedModel.slice(ourPrefix.length)
      : undefined,
    filesWritten: [path],
    warnings,
  };
}

/**
 * The OpenCode release CI and the install hint pin (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OPENCODE_VERSION = "1.18.32";

const OPENCODE_INSTALL = {
  command: `npm install -g opencode-ai@${OPENCODE_VERSION}`,
  url: "https://opencode.ai",
};

export const opencodeAdapter: AgentAdapter = {
  id: OPENCODE_ID,
  label: "OpenCode",
  bin: OPENCODE_BIN,
  install: OPENCODE_INSTALL,
  launchModelFlags: ["--model", "-m"],
  aliases: ["code"],
  detect(): DetectResult {
    return detectBinary(OPENCODE_BIN);
  },
  carriesWiring: (text) => text.includes(`"${OPENCODE_MARKER_KEY}"`),
  managedFiles(): string[] {
    return [opencodeConfigPath()];
  },
  probe,
  bakedBaseUrl: async () => (await probeDetail()).baseUrl,
  enableGuard,
  enable,
  async disable(): Promise<DisableResult> {
    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    if (!raw.trim()) {
      await clearAddedState(OPENCODE_ID);
      return { stripped: false };
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asObject(parseJsonc(raw));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      // Unreadable is not "nothing to turn off": retain the record so off can distinguish our key after a fix.
      return {
        stripped: false,
        notes: [
          `${path} is not valid JSON and may still hold your ai& key; fix it, then run aiand opencode off again.`,
        ],
      };
    }

    const added = await getAddedState<OpencodeRecord>(OPENCODE_ID);
    const notes: string[] = [];
    let text = raw;
    let stripped = false;

    // Our stamp gates everything below: foreign `aiand` providers and already-stripped files are left alone.
    if (hasOwnershipMarker(parsed)) {
      const provider = parsed.provider;
      const currentBlock =
        provider && typeof provider === "object" && !Array.isArray(provider)
          ? (provider as Record<string, unknown>)[OPENCODE_PROVIDER_ID]
          : undefined;
      if (currentBlock !== undefined) {
        const expected = added?.providerAiand;
        const edited =
          expected !== undefined
            ? !isDeepStrictEqual(withoutApiKey(currentBlock), withoutApiKey(expected))
            : !configIsOurs(parsed);
        if (edited) {
          notes.push("left provider.aiand because you edited it");
          text = jsoncDelete(text, OPENCODE_KEY_PATH); // Their block; our key/stamp.
          text = jsoncDelete(text, OPENCODE_MARKER_PATH);
        } else {
          text = jsoncDelete(text, ["provider", OPENCODE_PROVIDER_ID]);
          const left = (parseJsonc(text) as Record<string, unknown>).provider;
          if (
            left &&
            typeof left === "object" &&
            !Array.isArray(left) &&
            Object.keys(left).length === 0
          ) {
            text = jsoncDelete(text, ["provider"]);
          }
        }
      }
      stripped = true;

      const live = parseJsonc(text) as Record<string, unknown>; // Provider edits leave the root model untouched.
      const rootModel = typeof live.model === "string" ? live.model : "";
      // An unpinned pre-existing `aiand/…` root model is the user's (added.model unset); its prefix is not ownership.
      if (added?.model) {
        if (rootModel === added.model) {
          if (added.previousModel) text = jsoncSet(text, ["model"], added.previousModel);
          else text = jsoncDelete(text, ["model"]);
        } else if (rootModel) {
          notes.push("left model because you edited it");
        }
      }
      const small = typeof live.small_model === "string" ? live.small_model : "";
      if (added?.smallModel) {
        if (small === added.smallModel) {
          if (added.previousSmallModel) {
            text = jsoncSet(text, ["small_model"], added.previousSmallModel);
          } else text = jsoncDelete(text, ["small_model"]);
        } else if (small) {
          notes.push("left small_model because you edited it");
        }
      }

      if (added?.permission !== undefined) {
        if (isDeepStrictEqual(asObject(live.permission), added.permission)) {
          if (added.previousPermission !== undefined) {
            text = jsoncSet(text, ["permission"], added.previousPermission);
          } else {
            text = jsoncDelete(text, ["permission"]);
          }
        } else {
          notes.push("left permission because you edited it");
        }
      }
    }

    if (text !== raw) {
      const next = parseJsonc(text) as Record<string, unknown>;
      const empty = Object.keys(next).length === 0;
      const created = added?.created === true || (await fileCreatedByUs(OPENCODE_ID, path));
      if (empty && created) {
        await unlink(path);
      } else {
        await writeFileAtomic(path, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE }); // Key left: restore the user's mode.
      }
    }

    await clearAddedState(OPENCODE_ID); // Next on must record the current mode, not the first-on mode.
    return { stripped, notes };
  },

  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    // Marker-gated like disable(): marked configs holding our key are swapped; foreign unmarked keys are untouched.
    const current = await readOpencodeConfig();
    const options = hasOwnershipMarker(current) ? providerOptions(current) : undefined;
    if (!options) return false;
    if (options.apiKey === input.apiKey) return true; // Same-key idempotent rebake still reports refreshed.
    // Rotation swaps only the key it replaced; another profile's config keeps routing to that profile's org.
    if (input.previousKey !== undefined && options.apiKey !== input.previousKey) return false;

    const path = opencodeConfigPath();
    const raw = await readTextIfExists(path);
    await writeKeyFile(path, jsoncSet(raw, OPENCODE_KEY_PATH, input.apiKey), {
      mode: PRIVATE_FILE_MODE,
      agentId: OPENCODE_ID,
    });
    // Rebake swaps only the key literal; refresh AddedState so disable() does not treat it as a user edit.
    const added = await getAddedState<OpencodeRecord>(OPENCODE_ID);
    if (added?.providerAiand !== undefined) {
      const provider = (await readOpencodeConfig()).provider as Record<string, unknown>;
      await recordAddedState(OPENCODE_ID, {
        ...added,
        providerAiand: withoutApiKey(provider[OPENCODE_PROVIDER_ID]),
      });
    }
    return true;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works without on: inline OPENCODE_CONFIG_CONTENT uses a throwaway 0600 {file:} key instead of child env, cleaned after exit; inline config needs a concrete model.
    const models = modelsFromCatalog(input.catalog);
    const servable = input.catalog.filter((entry) => Object.hasOwn(models, entry.id));
    const model = input.model ?? resolveDefault(servable, input.profileModel);
    if (!Object.hasOwn(models, model)) {
      throw new CliError(`OpenCode cannot be pointed at ${model}.`, {
        hint: "Pass --model with an id from `aiand models`.",
      });
    }
    const dir = await makeOverlayDir("aiand-opencode-");
    const keyFile = join(dir, "key");
    try {
      await writeFile(keyFile, input.apiKey, { mode: PRIVATE_FILE_MODE, flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    const config = buildOpencodeConfig({
      apiKey: `{file:${keyFile}}`,
      model,
      models,
      options: { ...OPENCODE_OPTIONS, baseURL: opencodeBaseURL(input.baseUrl) },
      lockdown: true,
      keyFile,
    });
    return {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
  async openExtras(input) {
    // A user-named model stands; an ai& one takes titles and summaries too.
    const [named] = takeFlagValues(input.args, ["--model", "-m"]).values.slice(-1);
    if (named !== undefined) {
      if (!named.startsWith(`${OPENCODE_PROVIDER_ID}/`) || process.env.OPENCODE_CONFIG_CONTENT) {
        return {};
      }
      return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ small_model: named }) } };
    }
    const config = await readOpencodeConfig();
    const model = typeof config.model === "string" ? config.model : "";
    if (!model || model.startsWith(`${OPENCODE_PROVIDER_ID}/`)) return {};
    if (process.env.OPENCODE_CONFIG_CONTENT) return {};
    const wired = Object.keys(aiandProviderField(config, "models") ?? {}).map((id) => ({ id }));
    const ref = `${OPENCODE_PROVIDER_ID}/${resolveDefault(wired, input.profileModel)}`;
    return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: ref, small_model: ref }) } };
  },
};
