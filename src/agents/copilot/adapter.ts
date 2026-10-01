import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { detectBinary } from "../detect.js";
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
  discardSnapshot,
  fileCreatedByUs,
  getAddedState,
  hasSnapshot,
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

const COPILOT_ID = "copilot";
const COPILOT_BIN = "copilot";
const PROVIDER_NAME = "aiand";
// Copilot selects a providers.json model as `<provider>/<id>`.
const MODEL_PREFIX = `${PROVIDER_NAME}/`;
// Copilot keeps unknown keys on a provider entry, so the stamp sits on ours.
const MARKER_KEY = "x-aiand";
const INVALID_CONFIG_HINT = "Fix it by hand, or delete it and run aiand copilot on again.";

type Entry = Record<string, unknown>;

/** What enable() recorded so off can leave hand-edited values alone. */
type CopilotRecord = {
  provider?: unknown; // our provider entry as written, minus apiKey
  model?: string;
  previousModel?: string;
  previousMode?: number; // providers.json mode before `on` locked it to 0600
};

const copilotHome = (): string => process.env.COPILOT_HOME || join(agentHome(), ".copilot");
// The same lookup Copilot does, so `on` writes the file Copilot will read.
const providersPath = (): string =>
  process.env.COPILOT_PROVIDERS_CONFIG?.trim() || join(copilotHome(), "providers.json");
const settingsPath = (): string => join(copilotHome(), "settings.json");

/** The one builder for our providers.json entries, shared by `on` and the launcher. */
function buildProviders({
  apiKey,
  baseUrl,
  catalog,
}: {
  apiKey: string;
  baseUrl?: string;
  catalog: Model[];
}): { provider: Entry; models: Entry[] } {
  return {
    provider: {
      name: PROVIDER_NAME,
      type: "openai",
      baseUrl: `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`,
      // Pinned rather than left to Copilot's default: chat completions is the
      // dialect OpenCode already proves against ai&.
      wireApi: "completions",
      // providers.json takes no key command (copilot-cli#4936), so the key is baked.
      apiKey,
      [MARKER_KEY]: true,
    },
    models: catalog.map((model) => ({ provider: PROVIDER_NAME, id: model.id, name: model.name })),
  };
}

async function readJson(path: string): Promise<{ raw: string; doc: Entry }> {
  const raw = await readTextIfExists(path);
  if (!raw.trim()) return { raw, doc: {} };
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw notValidJsonError(path, INVALID_CONFIG_HINT);
    throw error;
  }
  const doc = asObject(parsed);
  if (!doc) throw notValidJsonError(path, INVALID_CONFIG_HINT);
  return { raw, doc };
}

function list(doc: Entry, key: "providers" | "models", path: string): unknown[] {
  const value = doc[key] ?? [];
  if (!Array.isArray(value)) throw notValidJsonError(path, INVALID_CONFIG_HINT);
  return value;
}

const isOurName = (entry: unknown): boolean => asObject(entry)?.name === PROVIDER_NAME;
const onOurProvider = (entry: unknown): boolean => asObject(entry)?.provider === PROVIDER_NAME;
const marked = (entry: Entry | undefined): entry is Entry => entry?.[MARKER_KEY] === true;
const ourProvider = (providers: unknown[]): Entry | undefined =>
  asObject(providers.find(isOurName));

function withoutApiKey(entry: Entry): Entry {
  const { apiKey: _apiKey, ...rest } = entry;
  return rest;
}

const setList = (text: string, key: string, entries: unknown[]): string =>
  entries.length > 0 ? jsoncSet(text, [key], entries) : jsoncDelete(text, [key]);

async function probe(): Promise<ProbeResult> {
  try {
    const path = providersPath();
    const provider = ourProvider(list((await readJson(path)).doc, "providers", path));
    if (!marked(provider) || !isRoutableBaseUrl(provider.baseUrl)) {
      return { active: false, model: null };
    }
    const model = (await readJson(settingsPath())).doc.model;
    return { active: true, model: typeof model === "string" ? model : null };
  } catch {
    // A file mid-edit must not wedge `copilot status`.
    return { active: false, model: null };
  }
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const path = providersPath();
  const settings = settingsPath();
  // Both parsed before either is written, so a broken file refuses `on` cleanly.
  const current = await readJson(settings);
  const { raw, doc } = await readJson(path);
  const providers = list(doc, "providers", path);
  const models = list(doc, "models", path);
  const existing = ourProvider(providers);
  if (existing && !marked(existing)) {
    throw new CliError(`${path} already has an "aiand" provider that ai& does not manage.`, {
      hint: "Remove or rename it by hand, then run aiand copilot on again.",
    });
  }

  const built = buildProviders(input);
  let text = jsoncSet(
    raw,
    ["providers"],
    [...providers.filter((p) => !isOurName(p)), built.provider],
  );
  text = jsoncSet(text, ["models"], [...models.filter((m) => !onOurProvider(m)), ...built.models]);
  const prior = await getAddedState<CopilotRecord>(COPILOT_ID);
  // A re-on finds the file at our 0600; carry the first on's mode so off restores the user's.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  if (text !== raw) await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  else await chmod(path, PRIVATE_FILE_MODE);
  const filesWritten = [path];

  const currentModel = typeof current.doc.model === "string" ? current.doc.model : "";
  const priorLive = prior?.model !== undefined && currentModel === prior.model;
  let model = priorLive ? prior?.model : undefined;
  let previousModel = priorLive ? prior?.previousModel : undefined;
  // A retired ai& model would fail every request, so it is replaced like an empty slot.
  const stale =
    currentModel.startsWith(MODEL_PREFIX) &&
    !input.catalog.some((entry) => `${MODEL_PREFIX}${entry.id}` === currentModel);
  const warnings: string[] = [];
  let effective = currentModel;
  if (input.model === "native") {
    // leave Copilot's own default
  } else if (currentModel && !input.pinModel && !stale) {
    if (!currentModel.startsWith(MODEL_PREFIX)) {
      warnings.push(`Left your existing model (${currentModel}). Pass --model to switch.`);
    }
  } else {
    effective = `${MODEL_PREFIX}${input.model}`;
    if (!currentModel.startsWith(MODEL_PREFIX)) previousModel = currentModel || undefined;
    model = effective;
    await writeFileAtomic(settings, jsoncSet(current.raw, ["model"], effective), {
      mode: (await existingFileMode(settings)) ?? DEFAULT_FILE_MODE,
    });
    filesWritten.push(settings);
  }

  await recordAddedState(COPILOT_ID, {
    provider: withoutApiKey(built.provider),
    model,
    previousModel,
    previousMode,
  } satisfies CopilotRecord);

  const reported = effective || input.model;
  return {
    model: reported,
    catalogModel: reported.startsWith(MODEL_PREFIX)
      ? reported.slice(MODEL_PREFIX.length)
      : undefined,
    filesWritten,
    warnings,
  };
}

async function writeOrUnlink(path: string, text: string, mode: number): Promise<void> {
  const empty = Object.keys(asObject(parseJsonc(text)) ?? {}).length === 0;
  if (empty && (await fileCreatedByUs(COPILOT_ID, path))) await unlink(path);
  else await writeFileAtomic(path, text, { mode });
}

async function disable(): Promise<DisableResult> {
  const path = providersPath();
  const added = await getAddedState<CopilotRecord>(COPILOT_ID);
  let read: { raw: string; doc: Entry };
  let providers: unknown[];
  let models: unknown[];
  try {
    read = await readJson(path);
    providers = list(read.doc, "providers", path);
    models = list(read.doc, "models", path);
  } catch {
    await clearAddedState(COPILOT_ID);
    return { stripped: false };
  }
  const provider = ourProvider(providers);
  if (!marked(provider)) {
    await clearAddedState(COPILOT_ID);
    return { stripped: false };
  }

  const notes: string[] = [];
  const edited =
    added?.provider !== undefined && !isDeepStrictEqual(withoutApiKey(provider), added.provider);
  let text: string;
  if (edited) {
    notes.push(`left the aiand provider in ${path} because you edited it`);
    // The rest of the entry is theirs; the session key and stamp are still ours.
    const { [MARKER_KEY]: _marker, ...theirs } = withoutApiKey(provider);
    text = jsoncSet(
      read.raw,
      ["providers"],
      providers.map((p) => (isOurName(p) ? theirs : p)),
    );
  } else {
    text = setList(
      read.raw,
      "providers",
      providers.filter((p) => !isOurName(p)),
    );
    text = setList(
      text,
      "models",
      models.filter((m) => !onOurProvider(m)),
    );
  }
  // The key left the file: hand back the mode the user had before on.
  await writeOrUnlink(path, text, added?.previousMode ?? DEFAULT_FILE_MODE);

  if (!edited) {
    // Any `aiand/` pick now names a provider that is gone, so it goes too.
    const settings = settingsPath();
    try {
      const current = await readJson(settings);
      const pick = current.doc.model;
      if (typeof pick === "string" && pick.startsWith(MODEL_PREFIX)) {
        const next = added?.previousModel
          ? jsoncSet(current.raw, ["model"], added.previousModel)
          : jsoncDelete(current.raw, ["model"]);
        await writeOrUnlink(
          settings,
          next,
          (await existingFileMode(settings)) ?? DEFAULT_FILE_MODE,
        );
      }
    } catch {
      notes.push(`left ${settings} alone because it is not valid JSON`);
    }
  }

  // A snapshot of files that did not exist holds none of the user's bytes, so the next `on`
  // may capture afresh; one holding their bytes is their only copy and outlives off.
  const created = await Promise.all(
    copilotAdapter.managedFiles().map((file) => fileCreatedByUs(COPILOT_ID, file)),
  );
  if (created.every(Boolean)) await discardSnapshot(COPILOT_ID);
  else if (await hasSnapshot(COPILOT_ID)) {
    notes.push("run aiand restore copilot --force to bring back your previous config");
  }
  await clearAddedState(COPILOT_ID);
  return { stripped: true, notes };
}

async function refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
  const path = providersPath();
  const { raw, doc } = await readJson(path);
  const providers = list(doc, "providers", path);
  const provider = ourProvider(providers);
  if (!marked(provider)) return false;
  // A same-key no-op still counts as touched: an idempotent rebake reports refreshed.
  if (provider.apiKey === input.apiKey) return true;
  // A rotation swaps only the key it replaced: a config baked from another profile keeps its org.
  if (input.previousKey !== undefined && provider.apiKey !== input.previousKey) return false;
  const next = providers.map((p) => (isOurName(p) ? { ...provider, apiKey: input.apiKey } : p));
  await writeFileAtomic(path, jsoncSet(raw, ["providers"], next), { mode: PRIVATE_FILE_MODE });
  return true;
}

const COPILOT_INSTALL = {
  command: "npm install -g @github/copilot",
  url: "https://docs.github.com/copilot/how-tos/copilot-cli",
};

export const copilotAdapter: AgentAdapter = {
  id: COPILOT_ID,
  label: "Copilot CLI",
  bin: COPILOT_BIN,
  install: COPILOT_INSTALL,
  detect(): DetectResult {
    return detectBinary(COPILOT_BIN);
  },
  managedFiles(): string[] {
    return [providersPath(), settingsPath()];
  },
  probe,
  enable,
  disable,
  refreshKey,
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on`: COPILOT_PROVIDERS_CONFIG swaps the user's
    // providers.json for a throwaway 0600 one for this session only.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const { provider, models } = buildProviders(input);
    const dir = await mkdtemp(join(tmpdir(), "aiand-copilot-"));
    const file = join(dir, "providers.json");
    await writeFile(file, JSON.stringify({ providers: [provider], models }), {
      mode: PRIVATE_FILE_MODE,
    });
    return {
      env: { COPILOT_PROVIDERS_CONFIG: file, COPILOT_MODEL: `${MODEL_PREFIX}${model}` },
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
};
