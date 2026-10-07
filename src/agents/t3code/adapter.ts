import { mkdir, stat, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { CliError } from "../../cli/errors.js";
import { isRoutableBaseUrl, writeFileAtomic } from "../../config.js";
import {
  DEFAULT_FILE_MODE,
  existingFileMode,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
} from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { detectBinary } from "../detect.js";
import {
  asObject,
  jsoncDelete,
  jsoncSet,
  notValidJsonError,
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
} from "../types.js";
import {
  BASE_URL_KEY,
  DRIVER,
  fastModel,
  INSTANCE_ID,
  INVALID_CONFIG_HINT,
  inCatalog,
  instanceAt,
  instanceEnv,
  isOurs,
  markedFile,
  parseSettings,
  parseWritten,
  secretPathFor,
  secretsDirFor,
  settingsPath,
  stripOurEnv,
  T3CODE_ID,
  type T3codeRecord,
  TOKEN_KEY,
  t3BaseUrl,
  wiredSettingsPath,
  withoutTokenValue,
} from "./settings.js";

const T3CODE_BIN = "t3";

/**
 * The T3 Code CLI release the install hint pins. t3's own install.sh serves a
 * mutable script from t3.codes, so the hint installs the versioned npm build
 * that script names as its fallback — the same pinned package shape opencode
 * and copilot use.
 */
const T3CODE_VERSION = "0.0.45";

const T3CODE_INSTALL = {
  command: `npm install -g t3@${T3CODE_VERSION}`,
  url: "https://t3.codes",
};

/** Remove a file if it is there; anything but ENOENT is a real error. */
async function unlinkIfExists(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Best-effort removal: even a directory squatting on the name must not fail. */
async function unlinkBestEffort(file: string): Promise<void> {
  await unlink(file).catch(() => {});
}

async function probe(): Promise<ProbeResult> {
  let settings: Record<string, unknown>;
  try {
    const path = await wiredSettingsPath();
    settings = parseSettings(path, await readTextIfExists(path));
  } catch {
    // A file mid-edit must not wedge `t3code status`.
    return { active: false, model: null };
  }
  const instance = instanceAt(settings);
  if (!isOurs(instance)) return { active: false, model: null };
  // Like the sibling adapters, active needs a routable gateway
  // base URL: another origin would send Claude Code elsewhere
  // whatever the marker says.
  const baseUrl = (Array.isArray(instance.environment) ? instance.environment : [])
    .map((entry) => asObject(entry))
    .find((entry) => entry?.name === BASE_URL_KEY)?.value;
  if (typeof baseUrl !== "string" || !isRoutableBaseUrl(baseUrl)) {
    return { active: false, model: null };
  }
  const selection = asObject(settings.defaultModelSelection);
  return {
    active: true,
    model:
      selection?.instanceId === INSTANCE_ID && typeof selection.model === "string"
        ? selection.model
        : null,
  };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  // t3's per-driver default models are its own, never ai&-servable.
  if (input.model === "native") {
    throw new CliError("T3 Code's own default models are not on ai&; pass --model to pick one.");
  }
  const path = settingsPath();
  const wired = await getAddedState<T3codeRecord>(T3CODE_ID);
  if (wired?.path && wired.path !== path) {
    // Two wired files would share one record, and off would hand one
    // file's values to the other. A record whose file lost our
    // marker is stale.
    if (await markedFile(wired.path)) {
      throw new CliError(`T3 Code is already wired through ${wired.path}.`, {
        hint: "Run aiand t3code off first, then aiand t3code on for the new T3CODE_HOME.",
      });
    }
    await clearAddedState(T3CODE_ID);
  }
  // Stat before reading: a path we cannot stat is the actionable
  // error, and a missing file is the one case `on` creates. Only a
  // missing file counts as created by us: a pre-existing empty file
  // belongs to the user, and `off` must never unlink it.
  let created = false;
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      created = true;
    } else {
      // ENOTDIR (T3CODE_HOME pointed at a regular file) or EACCES:
      // name the settings path and the env var that relocates it,
      // not a rethrown errno.
      throw new CliError(`Cannot read ${path}.`, {
        hint: "Fix permissions, or check T3CODE_HOME (it should point at a directory).",
      });
    }
  }
  const raw = await readTextIfExists(path);
  // A pre-existing empty settings.json is the user's: record its
  // exact bytes so off restores them byte-identically instead of
  // `{\n}\n` (created is false for it, so off never unlinks it).
  const emptyOriginalRaw = !created && raw.trim() === "" ? raw : undefined;
  const settings = parseSettings(path, raw);
  if (settings.providerInstances !== undefined && !asObject(settings.providerInstances)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }
  const existing = instanceAt(settings);
  if (existing !== undefined && !isOurs(existing)) {
    throw new CliError("T3 Code already has an aiand provider instance that ai& does not manage.", {
      hint: `Remove it from ${path} by hand, then run aiand t3code on again.`,
    });
  }
  const selection = settings.defaultModelSelection;
  if (selection !== undefined && selection !== null && !asObject(selection)) {
    throw notValidJsonError(path, INVALID_CONFIG_HINT);
  }

  // The prior on's record only describes this instance while our
  // marker is in it.
  const marked = existing !== undefined;
  const prior = marked ? await getAddedState<T3codeRecord>(T3CODE_ID) : null;
  const catalog = input.catalog;
  const warnings: string[] = [];

  let model: string;
  if (input.pinModel) {
    model = input.model;
  } else {
    // A selection already naming aiand with a model ai& serves is
    // the user's standing choice; anything else falls back to the
    // catalog default.
    const standing = asObject(selection);
    const standingModel = typeof standing?.model === "string" ? standing.model : "";
    if (
      standing?.instanceId === INSTANCE_ID &&
      standingModel !== "" &&
      !inCatalog(catalog, standingModel)
    ) {
      // A model the gateway cannot serve fails every request:
      // set it aside for off to restore.
      warnings.push(
        `Set aside your default model selection (${standingModel}); aiand t3code off puts it back.`,
      );
    }
    model =
      standing?.instanceId === INSTANCE_ID &&
      standingModel !== "" &&
      inCatalog(catalog, standingModel)
        ? standingModel
        : resolveDefault(catalog, input.profileModel);
  }
  const fast = fastModel(catalog, model);
  const instance: Record<string, unknown> = {
    driver: DRIVER,
    displayName: "ai&",
    environment: instanceEnv(t3BaseUrl(input.baseUrl), model, fast),
  };

  let text = raw;
  text = jsoncSet(text, ["providerInstances", INSTANCE_ID], instance);
  // A selection naming another instance is the user's: leave it and
  // say so. Otherwise `on` owns the selection, and off restores what
  // was there (hadSelection false means the key was absent).
  const selectionObject = asObject(selection);
  const selectionForeign =
    selection !== undefined && selection !== null && selectionObject?.instanceId !== INSTANCE_ID;
  if (selectionForeign) {
    warnings.push(
      `T3 Code still starts on your default instance selection (${String(selectionObject?.instanceId ?? selection)}); pick the aiand instance in T3 Code to use ai&.`,
    );
  } else {
    text = jsoncSet(text, ["defaultModelSelection"], { instanceId: INSTANCE_ID, model });
  }

  // A re-on finds the file at the mode the first on left it: carry
  // the first on's recorded mode so off still restores the user's
  // original.
  const previousMode = prior?.previousMode ?? (await existingFileMode(path)) ?? DEFAULT_FILE_MODE;
  const secret = secretPathFor(path, TOKEN_KEY);
  try {
    // The session key rides in its own 0600 file; settings.json only
    // names it, so the wiring is written once the key exists.
    await mkdir(secretsDirFor(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFileAtomic(secret, input.apiKey, { mode: PRIVATE_FILE_MODE });
    await writeFileAtomic(path, text, { mode: previousMode });
  } catch {
    // A secret file with no settings.json wiring would be orphaned.
    // Best-effort cleanup: a failure here (e.g. EISDIR when a
    // directory squats on the secret path) must not mask the write
    // error, which is the one the user needs to act on.
    await unlinkIfExists(secret).catch(() => {});
    throw new CliError(`Could not write the session key file ${secret}.`, {
      hint: "Something is occupying that path — remove it and run aiand t3code on again.",
    });
  }
  await recordAddedState(T3CODE_ID, {
    path,
    // A re-on over our own wiring chains the first on's record:
    // its fields describe what the user had before the FIRST on,
    // so they survive every later on verbatim (undefined included).
    // Only a first on records what it found — otherwise a re-on
    // records our own wired instance as the "previous" one, and one
    // off "restores" our wiring instead of the user's pre-on state.
    previousInstance: marked ? (prior ? prior.previousInstance : existing) : undefined,
    writtenInstance: instance,
    ...(selectionForeign && !prior
      ? {}
      : {
          // Same chaining: the first on knew whether the user had a
          // selection, so off restores (or removes) what the first
          // on displaced, even when a later on found a foreign one.
          hadSelection: prior ? prior.hadSelection : selection !== undefined,
          previousSelection: prior ? prior.previousSelection : selectionObject,
        }),
    previousMode,
    created: created || prior?.created === true,
    secretPaths: [secret],
    emptyOriginalRaw,
  });
  return { model, catalogModel: model, filesWritten: [path, secret], warnings };
}

async function disable(): Promise<DisableResult> {
  const added = await getAddedState<T3codeRecord>(T3CODE_ID);
  const path = added?.path ?? settingsPath();
  const raw = await readTextIfExists(path);
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(path, raw);
  } catch {
    // Keep the record: once the JSON is fixed, off can still tell our
    // values from the user's.
    return {
      stripped: false,
      notes: [`${path} is not valid JSON; fix it, then run aiand t3code off again.`],
    };
  }
  const instance = instanceAt(settings);
  // The session key lives only in its own 0600 file; a re-on writes
  // the same name, so the recorded paths cover every on. They are
  // only ever ours, so they go even when the file no longer holds
  // our marker: the .bin would otherwise be orphaned.
  const recorded = added?.secretPaths ?? [];
  for (const secret of recorded) {
    await unlinkIfExists(secret);
  }
  // The record itself can be lost (snapshots/t3code deleted), and
  // our secret filename is deterministic for this instance and var,
  // so sweep it too: without it, a lost record leaves the real API
  // key in a 0600 file nothing will ever remove. Best-effort: a
  // directory squatting on the name must not crash off.
  const unrecorded = secretPathFor(path, TOKEN_KEY);
  if (!recorded.includes(unrecorded)) {
    await unlinkBestEffort(unrecorded);
  }
  if (!isOurs(instance)) {
    await clearAddedState(T3CODE_ID);
    return { stripped: false };
  }

  const notes: string[] = [];
  let text = raw;

  const written = added?.writtenInstance;
  const previousInstance = added?.previousInstance;
  const previousSelection = added?.previousSelection;
  const hadSelection = added?.hadSelection;
  // A current instance that no longer matches what `on` wrote was
  // edited by hand: keep it, minus our stamp and the token entry (its
  // key file is gone). Without a record (lost state), everything reads
  // as ours.
  const edited =
    written !== undefined &&
    !isDeepStrictEqual(withoutTokenValue(instance), withoutTokenValue(written));
  if (edited) {
    notes.push("left the aiand instance because you edited it");
    text = jsoncSet(text, ["providerInstances", INSTANCE_ID, "environment"], stripOurEnv(instance));
  } else if (previousInstance !== undefined) {
    // A re-on over our own earlier instance: put what was there
    // before that on back.
    text = jsoncSet(text, ["providerInstances", INSTANCE_ID], previousInstance);
  } else {
    text = jsoncDelete(text, ["providerInstances", INSTANCE_ID]);
    if (Object.keys(asObject(parseWritten(text).providerInstances) ?? {}).length === 0) {
      text = jsoncDelete(text, ["providerInstances"]);
    }
  }

  // The selection is ours to restore only when `on` wrote it; one
  // that names another instance was always the user's.
  const selection = settings.defaultModelSelection;
  if (hadSelection !== undefined) {
    if (asObject(selection)?.instanceId === INSTANCE_ID) {
      if (hadSelection) {
        // Present before `on`: put its value back. A recorded absence
        // of previousSelection means it was JSON null.
        text =
          previousSelection !== undefined
            ? jsoncSet(text, ["defaultModelSelection"], previousSelection)
            : jsoncSet(text, ["defaultModelSelection"], null);
      } else {
        // `on` created the selection: take it away.
        text = jsoncDelete(text, ["defaultModelSelection"]);
      }
    } else if (selection !== undefined) {
      notes.push("left defaultModelSelection because you set a new one");
    }
  }

  if (text !== raw) {
    const empty = Object.keys(parseWritten(text)).length === 0;
    if (added?.emptyOriginalRaw !== undefined && empty) {
      // The user's own empty settings.json: its exact bytes
      // come back, and the file is never unlinked — a
      // 0-byte file is the user's, not one `on` created.
      await writeFileAtomic(path, added.emptyOriginalRaw, {
        mode: added?.previousMode ?? DEFAULT_FILE_MODE,
      });
    } else if (empty && (added?.created === true || (await fileCreatedByUs(T3CODE_ID, path)))) {
      await unlink(path);
    } else {
      // Our vars left the file: hand back the mode the user had before on.
      await writeFileAtomic(path, text, { mode: added?.previousMode ?? DEFAULT_FILE_MODE });
    }
  }
  await clearAddedState(T3CODE_ID);
  return { stripped: true, notes };
}

export const t3codeAdapter: AgentAdapter = {
  id: T3CODE_ID,
  label: "T3 Code",
  bin: T3CODE_BIN,
  install: T3CODE_INSTALL,
  detect(): DetectResult {
    return detectBinary(T3CODE_BIN);
  },
  managedFiles(): string[] {
    // The session key's .bin rides along: restore --force replays
    // every managed file and removes the ones `on` created, so a
    // pre-on snapshot takes the key away with the settings file.
    // The wired file (and the secret beside it) too, so restore
    // works from a shell without its T3CODE_HOME.
    const wired = getAddedStateSync<T3codeRecord>(T3CODE_ID)?.path;
    const current = settingsPath();
    const files = [current, secretPathFor(current, TOKEN_KEY)];
    if (wired && wired !== current) {
      files.push(wired, secretPathFor(wired, TOKEN_KEY));
    }
    return [...new Set(files)];
  },
  probe,
  enable,
  disable,
  async refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
    const path = await wiredSettingsPath();
    const raw = await readTextIfExists(path);
    // Invalid JSON is the user's to fix, like the sibling adapters.
    const settings = parseSettings(path, raw);
    // Marker-gated like disable(): a foreign aiand instance (no
    // marker) keeps its own key untouched.
    if (!isOurs(instanceAt(settings))) return false;
    // The secret sits next to the wired file, so a rotation finds it
    // from the recorded path, not the current T3CODE_HOME.
    const secret = secretPathFor(path, TOKEN_KEY);
    const current = await readTextIfExists(secret);
    // A same-key no-op still counts as touched: an idempotent rebake
    // reports refreshed.
    if (current === input.apiKey) return true;
    // A rotation swaps only the key it replaced: a config baked from
    // another profile keeps routing to that profile's org.
    if (input.previousKey !== undefined && current !== input.previousKey) return false;
    await mkdir(secretsDirFor(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFileAtomic(secret, input.apiKey, { mode: PRIVATE_FILE_MODE });
    return true;
  },
};
