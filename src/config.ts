import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { CliError } from "./cli/errors.js";

export const DEFAULT_BASE_URL = "https://api.aiand.com";

export type Profile = {
  authUrl?: string;
  apiUrl?: string;

  model?: string;
};

export type Config = {
  profile: string;
  profiles: Record<string, Profile>;
};

export type Credential = {
  access_token: string;
  refresh_token: string;

  expires_at: number;
  user?: { id: string; email: string };
  org?: { id: string; name: string };
};

const DEFAULT_PROFILE: Profile = {};

export function configDir(): string {
  if (process.env.AIAND_CONFIG_DIR) return process.env.AIAND_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "aiand") : join(homedir(), ".config", "aiand");
}

export const configPath = (): string => join(configDir(), "config.json");
export const credentialsPath = (): string => join(configDir(), "credentials.json");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (e instanceof SyntaxError) {
      throw new CliError(`${path} is not valid JSON.`, {
        hint: "Fix it by hand, or delete it to start over.",
      });
    }
    throw e;
  }
}

function writeJson(path: string, value: unknown, mode: number): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode });

  chmodSync(path, mode);
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(configPath());
  return {
    profile: raw?.profile ?? "default",
    profiles: raw?.profiles ?? { default: { ...DEFAULT_PROFILE } },
  };
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config, 0o600);
}

export function activeProfileName(override?: string): string {
  return override ?? process.env.AIAND_PROFILE ?? loadConfig().profile;
}

export type ResolvedProfile = Profile & { name: string; authUrl: string; apiUrl: string };

export function resolveProfile(override?: string): ResolvedProfile {
  const name = activeProfileName(override);
  const stored = loadConfig().profiles[name] ?? { ...DEFAULT_PROFILE };
  const base = process.env.AIAND_BASE_URL;

  return {
    ...stored,
    name,
    authUrl: trimSlash(
      process.env.AIAND_AUTH_URL ?? base ?? stored.authUrl ?? DEFAULT_BASE_URL
    ),
    apiUrl: trimSlash(base ?? stored.apiUrl ?? DEFAULT_BASE_URL),
  };
}

export function updateProfile(name: string, patch: Partial<Profile>): void {
  const config = loadConfig();
  config.profiles[name] = { ...DEFAULT_PROFILE, ...config.profiles[name], ...patch };
  saveConfig(config);
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

function loadAllCredentials(): Record<string, Credential> {
  return readJson<Record<string, Credential>>(credentialsPath()) ?? {};
}

export function loadCredential(profile: string): Credential | null {
  return loadAllCredentials()[profile] ?? null;
}

export function saveCredential(profile: string, credential: Credential): void {
  const all = loadAllCredentials();
  all[profile] = credential;
  writeJson(credentialsPath(), all, 0o600);
}

export function clearCredential(profile: string): void {
  const all = loadAllCredentials();
  delete all[profile];
  if (Object.keys(all).length === 0) {
    try {
      unlinkSync(credentialsPath());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  writeJson(credentialsPath(), all, 0o600);
}

export function maskKey(key: string): string {
  if (key.length <= 11) return "sk-***";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}
