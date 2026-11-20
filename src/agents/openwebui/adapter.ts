import { CliError } from "../../cli/errors.js";
import { DEFAULT_BASE_URL, isRoutableBaseUrl, trimSlash } from "../../config.js";
import { detectBinary } from "../detect.js";
import {
  clearAddedState,
  getAddedState,
  getAddedStateSync,
  recordAddedState,
} from "../snapshot.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableInput,
  DisableResult,
  EnableInput,
  EnableResult,
  OpenTarget,
  ProbeResult,
} from "../types.js";
import {
  ADMIN_KEY_ENV,
  ADMIN_KEY_HINT,
  adminKey,
  type ConnectionConfig,
  DEFAULT_OPENWEBUI_URL,
  displayUrl,
  normalizeInstanceUrl,
  type OpenAIConfig,
  readOpenAIConfig,
  requireAdminKey,
  writeOpenAIConfig,
} from "./api.js";
import {
  aiandConnectionConfig,
  appendConnection,
  findByUrl,
  findOurs,
  keyFingerprint,
  removeConnection,
  replaceKey,
  sameUrl,
  secretsOf,
  withoutSecrets,
} from "./connections.js";

/**
 * Open WebUI is a self-hosted chat web app, usually shared. Its OpenAI
 * connections live in the instance's database, reached through the admin
 * API, so this adapter's managed config is remote: no managed files, and
 * snapshot/restore go through snapshotRemote/restore. See
 * docs/adr/0001-open-webui-support.md.
 */
const OPENWEBUI_ID = "openwebui";

/**
 * What `on` recorded. The connection editor rebuilds each connection's
 * settings from scratch on save, so an in-band marker would not survive:
 * ownership is the recorded base URL plus the SHA-256 of the key `on` baked.
 * The key itself is never recorded.
 */
type OpenWebUIRecord = {
  instanceUrl: string;
  baseUrl: string;
  keySha256: string;
  /** `on` turned ENABLE_OPENAI_API on; `off` hands that back. */
  enabledApi?: boolean;
  /**
   * The connection URLs (never keys) when `on` turned the API on. `off`
   * turns it back off only while no connection outside this list exists:
   * one the user added since would go dark with it.
   */
  previousUrls?: string[];
};

/** The pre-`on` capture: every key literal left out. */
type OpenWebUISnapshot = {
  instanceUrl: string;
  enable: boolean;
  urls: string[];
  /** Which connections had a key, so restore warns only about a lost one. */
  keyed: boolean[];
  configs: Record<string, ConnectionConfig>;
};

/** The record's fields, or null when there is none or it is not ours to trust. */
function asRecord(value: unknown): OpenWebUIRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.instanceUrl !== "string" ||
    typeof raw.baseUrl !== "string" ||
    typeof raw.keySha256 !== "string" ||
    !isRoutableBaseUrl(raw.baseUrl)
  ) {
    return null;
  }
  return {
    // A hand-edited record must not point the admin key at plain http.
    instanceUrl: normalizeInstanceUrl(raw.instanceUrl),
    baseUrl: raw.baseUrl,
    keySha256: raw.keySha256,
    enabledApi: raw.enabledApi === true,
    ...(Array.isArray(raw.previousUrls) && raw.previousUrls.every((url) => typeof url === "string")
      ? { previousUrls: raw.previousUrls as string[] }
      : {}),
  };
}

async function loadRecord(): Promise<OpenWebUIRecord | null> {
  return asRecord(await getAddedState<object>(OPENWEBUI_ID));
}

/** OPENWEBUI_URL, normalized, or undefined when unset. */
function envInstance(): string | undefined {
  const raw = process.env.OPENWEBUI_URL?.trim();
  return raw ? normalizeInstanceUrl(raw) : undefined;
}

/**
 * The instance `on` targets: OPENWEBUI_URL, else the recorded one, else
 * the default. One instance at a time: a different OPENWEBUI_URL while
 * another instance is still wired refuses, so the record never loses
 * track of a live key.
 */
async function targetInstance(): Promise<string> {
  const fromEnv = envInstance();
  const record = await loadRecord();
  if (record && fromEnv && fromEnv !== record.instanceUrl) {
    throw new CliError(`Open WebUI at ${record.instanceUrl} is still wired to ai&.`, {
      hint: `Run \`aiand openwebui off\` first (it unwires ${record.instanceUrl}), then wire ${fromEnv}.`,
    });
  }
  return fromEnv ?? record?.instanceUrl ?? DEFAULT_OPENWEBUI_URL;
}

const gatewayBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

async function probe(): Promise<ProbeResult> {
  // No record means nothing of ours to look for: no network call at all.
  const record = await loadRecord();
  if (!record) return { active: false, model: null };
  const key = adminKey();
  if (!key) {
    throw new CliError(`Set ${ADMIN_KEY_ENV} to check Open WebUI at ${record.instanceUrl}.`, {
      hint: ADMIN_KEY_HINT,
    });
  }
  const config = await readOpenAIConfig(record.instanceUrl, key);
  const ours = findOurs(config, record.baseUrl, record.keySha256);
  // Routing needs the OpenAI API on and our connection enabled: an admin
  // can switch either off in Admin › Settings › Connections.
  const live =
    ours !== -1 &&
    config.ENABLE_OPENAI_API === true &&
    config.OPENAI_API_CONFIGS[String(ours)]?.enable !== false;
  // Open WebUI picks the model per chat, so there is no model in effect.
  return { active: live, model: null };
}

async function snapshotRemote(): Promise<OpenWebUISnapshot> {
  const instance = await targetInstance();
  const key = requireAdminKey(`wire Open WebUI at ${instance}`);
  const config = await readOpenAIConfig(instance, key);
  const configs: Record<string, ConnectionConfig> = {};
  for (const [index, settings] of Object.entries(config.OPENAI_API_CONFIGS)) {
    configs[index] = withoutSecrets(settings);
  }
  return {
    instanceUrl: instance,
    enable: config.ENABLE_OPENAI_API,
    urls: config.OPENAI_API_BASE_URLS,
    keyed: config.OPENAI_API_KEYS.map((value) => value !== ""),
    configs,
  };
}

async function enable(input: EnableInput): Promise<EnableResult> {
  const instance = await targetInstance();
  const key = requireAdminKey(`wire Open WebUI at ${instance}`);
  const baseUrl = gatewayBaseUrl(input.baseUrl);
  const record = await loadRecord();
  const current = await readOpenAIConfig(instance, key);

  // Re-`on` while ours is there replaces its key (and URL, after a profile
  // switch) in place: position and the user's settings for it are kept.
  const ours = record ? findOurs(current, record.baseUrl, record.keySha256) : -1;
  const foreign = findByUrl(current, baseUrl).filter((index) => index !== ours);
  if (foreign.length > 0) {
    throw new CliError(`Open WebUI at ${instance} already has a connection to ${baseUrl}.`, {
      hint: "That connection already routes to ai&, and aiand did not add it, so aiand leaves it alone. To have aiand manage it instead, remove it in Admin › Settings › Connections, then run `aiand openwebui on` again.",
    });
  }

  let next =
    ours === -1
      ? appendConnection(current, baseUrl, input.apiKey, aiandConnectionConfig())
      : replaceKey(current, ours, input.apiKey, baseUrl);
  if (ours !== -1 && next.OPENAI_API_CONFIGS[String(ours)]?.enable === false) {
    // `on` routes: a connection of ours an admin switched off goes back on.
    next = {
      ...next,
      OPENAI_API_CONFIGS: {
        ...next.OPENAI_API_CONFIGS,
        [String(ours)]: { ...next.OPENAI_API_CONFIGS[String(ours)], enable: true },
      },
    };
  }
  let enabledApi = ours !== -1 && record?.enabledApi === true;
  let previousUrls = enabledApi ? record?.previousUrls : undefined;
  if (!next.ENABLE_OPENAI_API) {
    next = { ...next, ENABLE_OPENAI_API: true };
    enabledApi = true;
    // The connections that were there before, never ours: a later one to
    // the same URL is the user's.
    previousUrls = current.OPENAI_API_BASE_URLS.filter((_, index) => index !== ours);
  }

  // Recorded before the write: a write the instance applies but whose
  // response is lost must still leave off able to find the connection. A
  // record of a write that never landed matches nothing and clears itself.
  const keySha256 = keyFingerprint(input.apiKey);
  await recordAddedState(OPENWEBUI_ID, {
    instanceUrl: instance,
    baseUrl,
    keySha256,
    enabledApi,
    ...(previousUrls ? { previousUrls } : {}),
  } satisfies OpenWebUIRecord);
  const stored = await writeOpenAIConfig(instance, key, next);
  if (findOurs(stored, baseUrl, keySha256) === -1) {
    throw new CliError(`Open WebUI at ${instance} did not keep the ai& connection.`, {
      hint: "Check Admin › Settings › Connections, then run `aiand openwebui on` again.",
    });
  }

  return {
    // Informational: Open WebUI picks the model per chat.
    model: input.model,
    filesWritten: [`${instance} (OpenAI connections)`],
    warnings: [
      `Everyone on Open WebUI at ${instance} who can use these models spends this org's ai& credit.`,
      "Open WebUI picks the model per chat: choose an ai& model when you start one.",
    ],
  };
}

async function disable(input?: DisableInput): Promise<DisableResult> {
  const record = await loadRecord();
  if (!record) return { stripped: false };
  const key = adminKey();
  if (!key) {
    const message = `${ADMIN_KEY_ENV} is not set, so the ai& key is still on Open WebUI at ${record.instanceUrl}.`;
    // A silent skip would leave a live key on a shared server, and let
    // uninstall carry on past it. Logout calls disable directly; `off`
    // reaches here only through offGuard with --force, which forgets.
    if (input?.loggingOut !== undefined) throw new CliError(message, { hint: ADMIN_KEY_HINT });
    await clearAddedState(OPENWEBUI_ID);
    return {
      stripped: false,
      notes: [
        `${message} aiand forgot it (--force). Remove the ai& connection in Admin › Settings › Connections, and revoke the key in the ai& console.`,
      ],
    };
  }

  let current: OpenAIConfig;
  try {
    current = await readOpenAIConfig(record.instanceUrl, key);
  } catch (error) {
    // --force means the instance is out of reach: forget it, and say what
    // is still there. Without --force the failure stops `off`.
    if (!input?.force || !(error instanceof CliError)) throw error;
    await clearAddedState(OPENWEBUI_ID);
    return {
      stripped: false,
      notes: [
        `aiand could not reach Open WebUI at ${record.instanceUrl} (${error.message}), so the ai& key is still there. aiand forgot it (--force). Remove the ai& connection in Admin › Settings › Connections, and revoke the key in the ai& console.`,
      ],
    };
  }
  const ours = findOurs(current, record.baseUrl, record.keySha256);
  if (ours === -1) {
    await clearAddedState(OPENWEBUI_ID);
    // Same URL, another key: the user edited our connection, so it is theirs.
    if (findByUrl(current, record.baseUrl).length > 0) {
      return {
        stripped: false,
        notes: ["Left the ai& connection in Open WebUI because you edited it."],
      };
    }
    return { stripped: false };
  }

  let next = removeConnection(current, ours);
  const notes: string[] = [];
  // Hand ENABLE_OPENAI_API back only when `on` flipped it, it is still on,
  // and no connection appeared since: that one would go dark with it.
  if (record.enabledApi && next.ENABLE_OPENAI_API) {
    const before = record.previousUrls ?? [];
    const added = next.OPENAI_API_BASE_URLS.filter(
      (url) => !before.some((old) => sameUrl(old, url)),
    );
    if (added.length === 0) next = { ...next, ENABLE_OPENAI_API: false };
    else
      notes.push("left the OpenAI API on because connections were added after aiand turned it on");
  }
  await writeOpenAIConfig(record.instanceUrl, key, next);
  await clearAddedState(OPENWEBUI_ID);
  return { stripped: true, ...(notes.length > 0 ? { notes } : {}) };
}

async function refreshKey(input: { apiKey: string; previousKey?: string }): Promise<boolean> {
  const record = await loadRecord();
  if (!record) return false;
  const fresh = keyFingerprint(input.apiKey);
  // A rotation swaps only the key it replaced; the fingerprint answers that
  // without the network.
  if (
    input.previousKey !== undefined &&
    keyFingerprint(input.previousKey) !== record.keySha256 &&
    fresh !== record.keySha256
  ) {
    return false;
  }
  const key = adminKey();
  if (!key) {
    throw new CliError(
      `Set ${ADMIN_KEY_ENV} and run \`aiand openwebui on\` to refresh the ai& key on Open WebUI at ${record.instanceUrl}.`,
    );
  }
  const current = await readOpenAIConfig(record.instanceUrl, key);
  const ours = findOurs(current, record.baseUrl, record.keySha256);
  if (ours === -1) return false;
  if (fresh === record.keySha256) return true;
  await writeOpenAIConfig(record.instanceUrl, key, replaceKey(current, ours, input.apiKey));
  await recordAddedState(OPENWEBUI_ID, { ...record, keySha256: fresh } satisfies OpenWebUIRecord);
  return true;
}

function asSnapshot(value: object): OpenWebUISnapshot {
  const raw = value as Record<string, unknown>;
  const configs = raw.configs;
  if (
    typeof raw.instanceUrl !== "string" ||
    !Array.isArray(raw.urls) ||
    !raw.urls.every((url) => typeof url === "string") ||
    !configs ||
    typeof configs !== "object" ||
    Array.isArray(configs)
  ) {
    throw new CliError("The Open WebUI snapshot is corrupt.", {
      hint: "Delete the openwebui snapshot directory under the aiand config dir, or restore the connections in Admin › Settings › Connections.",
    });
  }
  return {
    instanceUrl: normalizeInstanceUrl(raw.instanceUrl),
    enable: raw.enable !== false,
    urls: raw.urls as string[],
    keyed: Array.isArray(raw.keyed) ? raw.keyed.map((flag) => flag === true) : [],
    configs: configs as Record<string, ConnectionConfig>,
  };
}

/**
 * `restore --force`: put back the captured URL list, per-connection settings
 * and enabled flag. The snapshot holds no keys, so each restored connection
 * takes the key the instance holds now for that URL; ours is never one.
 */
async function restore(value: object): Promise<string[]> {
  const snapshot = asSnapshot(value);
  const key = requireAdminKey(`restore Open WebUI at ${snapshot.instanceUrl}`);
  const live = await readOpenAIConfig(snapshot.instanceUrl, key);
  const record = await loadRecord();
  const ours =
    record && record.instanceUrl === snapshot.instanceUrl
      ? findOurs(live, record.baseUrl, record.keySha256)
      : -1;

  const used = new Set<number>([ours]);
  const keys: string[] = [];
  const configs: Record<string, ConnectionConfig> = {};
  const warnings: string[] = [];
  snapshot.urls.forEach((url, index) => {
    const match = live.OPENAI_API_BASE_URLS.findIndex(
      (liveUrl, at) => !used.has(at) && sameUrl(liveUrl, url),
    );
    if (match !== -1) used.add(match);
    const liveKey = match === -1 ? "" : (live.OPENAI_API_KEYS[match] ?? "");
    if (liveKey === "" && snapshot.keyed[index]) {
      warnings.push(
        `Open WebUI no longer holds a key for ${url}: add it in Admin › Settings › Connections.`,
      );
    }
    keys.push(liveKey);
    const settings = snapshot.configs[String(index)];
    if (settings) {
      configs[String(index)] = {
        ...settings,
        ...secretsOf(match === -1 ? undefined : live.OPENAI_API_CONFIGS[String(match)]),
      };
    }
  });

  await writeOpenAIConfig(snapshot.instanceUrl, key, {
    ENABLE_OPENAI_API: snapshot.enable,
    OPENAI_API_BASE_URLS: snapshot.urls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  });
  return warnings;
}

/** The instance a record or the environment names, without the network. */
function knownInstance(): string | undefined {
  const fromEnv = process.env.OPENWEBUI_URL?.trim();
  // `status` prints this: never a username, password or query from the URL.
  if (fromEnv) return displayUrl(fromEnv);
  const recorded = getAddedStateSync<{ instanceUrl?: unknown }>(OPENWEBUI_ID)?.instanceUrl;
  if (typeof recorded === "string") return recorded;
  // An admin key with no URL means the default instance.
  return adminKey() ? DEFAULT_OPENWEBUI_URL : undefined;
}

/**
 * `off` without the admin key cannot reach the instance. It refuses unless
 * --force, which forgets the record and says the key is still there.
 */
async function offGuard({ force }: { force: boolean }): Promise<void> {
  const record = await loadRecord();
  if (!record || adminKey() || force) return;
  throw new CliError(
    `${ADMIN_KEY_ENV} is not set, so aiand cannot remove the ai& key from Open WebUI at ${record.instanceUrl}.`,
    {
      hint: `${ADMIN_KEY_HINT}\nIf you can no longer reach that instance, \`aiand openwebui off --force\` forgets it; then revoke the key in the ai& console.`,
    },
  );
}

/** A capture of another instance is not this one's: `on` takes a fresh one. */
async function remoteSnapshotCovers(snapshot: object): Promise<boolean> {
  const instance = (snapshot as { instanceUrl?: unknown }).instanceUrl;
  return (
    typeof instance === "string" && normalizeInstanceUrl(instance) === (await targetInstance())
  );
}

async function openConfigured(): Promise<OpenTarget> {
  const record = await loadRecord();
  return {
    url: record?.instanceUrl ?? (await targetInstance()),
    message: "Open WebUI picks the model per chat: choose an ai& model when you start one.",
  };
}

export const openwebuiAdapter: AgentAdapter = {
  id: OPENWEBUI_ID,
  label: "Open WebUI",
  bin: "open-webui",
  // Open WebUI installs with pip or Docker, never npm: the hint is printed
  // with no offer to run it.
  install: {
    command: "pip install open-webui",
    url: "https://docs.openwebui.com/getting-started/quick-start/",
  },
  // The CLI never runs or manages the server: open wires it and opens the
  // browser.
  configOnly: true,
  helpNotes: `Environment
  OPENWEBUI_URL       the Open WebUI to wire (default ${DEFAULT_OPENWEBUI_URL});
                      https, or http on loopback. \`on\` records it, so later
                      commands reach the same instance without it.
  ${ADMIN_KEY_ENV}   an Open WebUI API key that belongs to an admin. aiand
                      reads it for each command and never stores it.

  \`on\` adds an ai& connection to the instance's OpenAI connections and
  leaves the others as they are. On a shared instance, everyone who can use
  these models spends your org's ai& credit, and Open WebUI keeps chats in
  its own database. Open WebUI is third-party software that ai& does not
  control.`,
  detect(): DetectResult {
    // A named or recorded instance counts as installed: it is usually a
    // Docker container or a server, with no binary on this machine.
    const instance = knownInstance();
    if (instance) return { installed: true, path: instance };
    return detectBinary("open-webui");
  },
  managedFiles(): string[] {
    return [];
  },
  probe,
  enable,
  disable,
  refreshKey,
  snapshotRemote,
  remoteSnapshotCovers,
  offGuard,
  restore,
  openConfigured,
};
