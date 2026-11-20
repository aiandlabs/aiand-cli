import { CliError } from "../../cli/errors.js";
import { isRoutableBaseUrl, trimSlash } from "../../config.js";
import { SECOND_MS } from "../../time.js";

/**
 * Open WebUI's admin API for its OpenAI connections (backend
 * routers/openai.py): `GET /openai/config` reads the whole list and
 * `POST /openai/config/update` replaces it. Both need an admin's API key or
 * session token as a bearer credential.
 */

/** The instance aiand talks to when OPENWEBUI_URL is unset (Docker quick start). */
export const DEFAULT_OPENWEBUI_URL = "http://localhost:3000";

/** The admin credential's env var. Read per call, never stored or logged. */
export const ADMIN_KEY_ENV = "OPENWEBUI_API_KEY";

const REQUEST_TIMEOUT_MS = 15 * SECOND_MS;

/** One connection's settings, keyed in the config by its list index as a string. */
export type ConnectionConfig = Record<string, unknown>;

/** The OpenAI connection config, exactly the four fields the API reads and writes. */
export type OpenAIConfig = {
  ENABLE_OPENAI_API: boolean;
  OPENAI_API_BASE_URLS: string[];
  OPENAI_API_KEYS: string[];
  OPENAI_API_CONFIGS: Record<string, ConnectionConfig>;
};

/** How to get an admin credential, for every refusal that needs one. */
export const ADMIN_KEY_HINT = [
  `Set ${ADMIN_KEY_ENV} to an Open WebUI API key that belongs to an admin.`,
  "Create one in Open WebUI under Settings › Account › API keys; an admin must",
  "first allow API keys in Admin › Settings › General. If API key endpoint",
  "restrictions are on, allow /openai/config and /openai/config/update.",
].join("\n");

/**
 * An instance URL safe to print: origin and path only, never a username,
 * password, query or fragment, which may hold a credential.
 */
export function displayUrl(raw: string): string {
  try {
    const parsed = new URL(raw.trim());
    return trimSlash(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return "(not a URL)";
  }
}

/**
 * Normalize an instance URL. It carries both the ai& key and an admin
 * credential, so it must be https, or http on loopback.
 */
export function normalizeInstanceUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliError("OPENWEBUI_URL must be an absolute URL.", {
      hint: `For example ${DEFAULT_OPENWEBUI_URL} or https://chat.example.com.`,
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError("OPENWEBUI_URL must not embed credentials.", {
      hint: `Pass the admin key in ${ADMIN_KEY_ENV} instead.`,
    });
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new CliError(
      `OPENWEBUI_URL must not have a query or fragment (got ${displayUrl(value)}?…).`,
      {
        hint: "Use the address you open Open WebUI at, e.g. https://chat.example.com.",
      },
    );
  }
  if (!isRoutableBaseUrl(value)) {
    throw new CliError(`OPENWEBUI_URL must use https (got ${displayUrl(value)}).`, {
      hint: "aiand sends your ai& key and an Open WebUI admin key to it, so plain http is allowed only on loopback (localhost, 127.0.0.1, ::1).",
    });
  }
  return trimSlash(`${parsed.origin}${parsed.pathname}`);
}

/** The admin credential from the environment, or undefined when unset. */
export function adminKey(): string | undefined {
  return process.env[ADMIN_KEY_ENV]?.trim() || undefined;
}

/** Refuse, naming what the user was trying to do, when no admin key is set. */
export function requireAdminKey(action: string): string {
  const key = adminKey();
  if (key) return key;
  throw new CliError(`Set ${ADMIN_KEY_ENV} to ${action}.`, { hint: ADMIN_KEY_HINT });
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : "")) : [];
}

/** Shape the response like the server would store it: keys padded to the URL count. */
function parseConfig(body: unknown, instance: string): OpenAIConfig {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>).OPENAI_API_BASE_URLS)
  ) {
    throw new CliError(`${instance} did not answer like Open WebUI's /openai/config.`, {
      hint: "Check that OPENWEBUI_URL is the address you open Open WebUI at.",
    });
  }
  const raw = body as Record<string, unknown>;
  const urls = asStringList(raw.OPENAI_API_BASE_URLS);
  const keys = asStringList(raw.OPENAI_API_KEYS).slice(0, urls.length);
  while (keys.length < urls.length) keys.push("");
  const configs: Record<string, ConnectionConfig> = {};
  const rawConfigs = raw.OPENAI_API_CONFIGS;
  if (rawConfigs && typeof rawConfigs === "object" && !Array.isArray(rawConfigs)) {
    for (const [index, config] of Object.entries(rawConfigs)) {
      if (config && typeof config === "object" && !Array.isArray(config)) {
        configs[index] = config as ConnectionConfig;
      }
    }
  }
  return {
    ENABLE_OPENAI_API: raw.ENABLE_OPENAI_API !== false,
    OPENAI_API_BASE_URLS: urls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  };
}

async function call(
  instance: string,
  key: string,
  path: string,
  body?: OpenAIConfig,
): Promise<OpenAIConfig> {
  let response: Response;
  try {
    response = await fetch(`${instance}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect: the admin key must reach only the URL the
      // user named, and a login-page redirect would read as a bad answer.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CliError(`Could not reach Open WebUI at ${instance}.`, {
      hint: `Check that it is running, and set OPENWEBUI_URL if it is not at ${instance}.`,
    });
  }
  if (response.status === 401 || response.status === 403) {
    await response.arrayBuffer().catch(() => {});
    throw new CliError(
      `Open WebUI at ${instance} refused ${ADMIN_KEY_ENV} (HTTP ${response.status}).`,
      { hint: ADMIN_KEY_HINT },
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CliError(`Open WebUI at ${instance} redirected ${path}.`, {
      hint: "Set OPENWEBUI_URL to the address Open WebUI is actually served at.",
    });
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => {});
    throw new CliError(`Open WebUI at ${instance} answered HTTP ${response.status} for ${path}.`, {
      hint: "Check the instance's logs, then run the command again.",
    });
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return parseConfig(parsed, instance);
}

/** Read the instance's OpenAI connection list (admin). */
export function readOpenAIConfig(instance: string, key: string): Promise<OpenAIConfig> {
  return call(instance, key, "/openai/config");
}

/** Replace the instance's OpenAI connection list (admin); resolves what it stored. */
export function writeOpenAIConfig(
  instance: string,
  key: string,
  config: OpenAIConfig,
): Promise<OpenAIConfig> {
  return call(instance, key, "/openai/config/update", config);
}
