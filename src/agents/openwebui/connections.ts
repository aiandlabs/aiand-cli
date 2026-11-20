import { createHash } from "node:crypto";

import { trimSlash } from "../../config.js";
import type { ConnectionConfig, OpenAIConfig } from "./api.js";

/**
 * Pure edits on Open WebUI's OpenAI connection list. The list is three
 * parallel structures: base URLs, keys, and per-connection settings keyed by
 * the connection's index as a string. Removing a connection shifts every
 * later index down by one, settings included.
 */

/** The settings `on` writes for the ai& connection, as the connection editor would. */
export function aiandConnectionConfig(): ConnectionConfig {
  return {
    enable: true,
    tags: [],
    prefix_id: "",
    model_ids: [],
    connection_type: "external",
    auth_type: "bearer",
  };
}

/** SHA-256 hex of a key: the ownership proof kept instead of the key itself. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export const sameUrl = (a: string, b: string): boolean => trimSlash(a) === trimSlash(b);

/**
 * The index of our connection: the recorded base URL with the key whose
 * fingerprint `on` recorded. -1 when none is ours. A connection to the same
 * URL with any other key is the user's.
 */
export function findOurs(config: OpenAIConfig, baseUrl: string, keySha256: string): number {
  return config.OPENAI_API_BASE_URLS.findIndex(
    (url, index) =>
      sameUrl(url, baseUrl) && keyFingerprint(config.OPENAI_API_KEYS[index] ?? "") === keySha256,
  );
}

/** Indexes of connections to `baseUrl`, ours or not. */
export function findByUrl(config: OpenAIConfig, baseUrl: string): number[] {
  return config.OPENAI_API_BASE_URLS.flatMap((url, index) =>
    sameUrl(url, baseUrl) ? [index] : [],
  );
}

/** A copy of `config` with one more connection at the end. */
export function appendConnection(
  config: OpenAIConfig,
  url: string,
  key: string,
  settings: ConnectionConfig,
): OpenAIConfig {
  const index = config.OPENAI_API_BASE_URLS.length;
  return {
    ...config,
    OPENAI_API_BASE_URLS: [...config.OPENAI_API_BASE_URLS, url],
    OPENAI_API_KEYS: [...config.OPENAI_API_KEYS, key],
    OPENAI_API_CONFIGS: { ...config.OPENAI_API_CONFIGS, [String(index)]: settings },
  };
}

/**
 * A copy of `config` with connection `index`'s key (and, when given, its
 * URL) replaced; position and settings kept.
 */
export function replaceKey(
  config: OpenAIConfig,
  index: number,
  key: string,
  url?: string,
): OpenAIConfig {
  const keys = [...config.OPENAI_API_KEYS];
  keys[index] = key;
  const urls = [...config.OPENAI_API_BASE_URLS];
  if (url !== undefined) urls[index] = url;
  return { ...config, OPENAI_API_BASE_URLS: urls, OPENAI_API_KEYS: keys };
}

/** A copy of `config` without connection `index`; later settings move down one index. */
export function removeConnection(config: OpenAIConfig, index: number): OpenAIConfig {
  const configs: Record<string, ConnectionConfig> = {};
  for (const [key, settings] of Object.entries(config.OPENAI_API_CONFIGS)) {
    const at = Number(key);
    if (!Number.isInteger(at) || at === index) continue;
    configs[String(at > index ? at - 1 : at)] = settings;
  }
  return {
    ...config,
    OPENAI_API_BASE_URLS: config.OPENAI_API_BASE_URLS.filter((_, at) => at !== index),
    OPENAI_API_KEYS: config.OPENAI_API_KEYS.filter((_, at) => at !== index),
    OPENAI_API_CONFIGS: configs,
  };
}

/**
 * Settings fields that can carry a credential (custom headers, Azure keys,
 * tokens). They are left out of the snapshot written to disk and taken from
 * the live instance again on restore.
 */
const SECRET_FIELD = /key|token|secret|password|headers/i;

function isSecretField(name: string): boolean {
  return name !== "auth_type" && SECRET_FIELD.test(name);
}

/** A connection's settings without any field that can carry a credential. */
export function withoutSecrets(settings: ConnectionConfig): ConnectionConfig {
  return Object.fromEntries(Object.entries(settings).filter(([name]) => !isSecretField(name)));
}

/** Only the credential-bearing fields of a connection's settings. */
export function secretsOf(settings: ConnectionConfig | undefined): ConnectionConfig {
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([name]) => isSecretField(name)));
}
