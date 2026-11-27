import { lstatSync, readFileSync } from "node:fs";
import { CliError } from "./cli/errors.js";

export const LINUX_POLICY_PATH = "/etc/aiand/policy.json";

/**
 * Administrator-managed settings. This module validates their shapes, not
 * their membership or endpoint rules; enforcement belongs to later callers.
 * @public managed-policy schema
 */
export type ManagedPolicy = {
  /**
   * Managed gateway base URL for both API and auth resolution. Later
   * enforcement must still use assertHttpsBaseUrl and assertNoV1Suffix.
   */
  baseUrl?: string;
  /**
   * Allowlist of model ids that `aiand <agent> on` may write. Later
   * enforcement must still check membership against the catalog.
   */
  allowedModels?: string[];
  /**
   * Allowlist of registered agent ids that may be set up. Later enforcement
   * must still check membership against the agent registry.
   */
  allowedAgents?: string[];
  /** Explicitly false disables telemetry. */
  telemetry?: boolean;
  /** Explicitly false disables self-update behaviour. */
  selfUpdate?: boolean;
};

/** @public setting names that can be locked by managed policy */
export type PolicySetting = keyof ManagedPolicy;

export type LoadedPolicy = {
  settings: ManagedPolicy;
  /** The policy path locking each setting that was present. */
  sources: Partial<Record<PolicySetting, string>>;
};

export type PolicyFileSystem = {
  lstat(path: string): { isFile(): boolean; uid: number };
  readFile(path: string): string;
};

function invalidSetting(path: string, key: string): CliError {
  return new CliError(`Managed policy "${path}" has an invalid "${key}" setting.`);
}

function isPolicyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isAllowlist(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isPolicyText);
}

export function readLinuxPolicy(options?: {
  path?: string;
  fileSystem?: PolicyFileSystem;
}): LoadedPolicy {
  const path = options?.path ?? LINUX_POLICY_PATH;
  const fileSystem = options?.fileSystem ?? {
    lstat: (filePath: string) => lstatSync(filePath),
    readFile: (filePath: string) => readFileSync(filePath, "utf8"),
  };

  let stats: ReturnType<PolicyFileSystem["lstat"]>;
  try {
    stats = fileSystem.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { settings: {}, sources: {} };
    }
    throw new CliError(`Managed policy "${path}" could not be inspected.`);
  }

  // lstat, rather than stat, rejects symlinks without following them.
  if (!stats.isFile() || stats.uid !== 0) {
    throw new CliError(`Managed policy "${path}" must be a regular file owned by root.`);
  }

  let contents: string;
  try {
    contents = fileSystem.readFile(path);
  } catch {
    throw new CliError(`Managed policy "${path}" could not be read.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new CliError(`Managed policy "${path}" is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`Managed policy "${path}" must contain one JSON object.`);
  }

  const settings: ManagedPolicy = {};
  const sources: Partial<Record<PolicySetting, string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    switch (key) {
      case "baseUrl":
        if (!isPolicyText(value)) throw invalidSetting(path, key);
        settings.baseUrl = value;
        break;
      case "allowedModels":
        if (!isAllowlist(value)) throw invalidSetting(path, key);
        settings.allowedModels = value;
        break;
      case "allowedAgents":
        if (!isAllowlist(value)) throw invalidSetting(path, key);
        settings.allowedAgents = value;
        break;
      case "telemetry":
        if (typeof value !== "boolean") throw invalidSetting(path, key);
        settings.telemetry = value;
        break;
      case "selfUpdate":
        if (typeof value !== "boolean") throw invalidSetting(path, key);
        settings.selfUpdate = value;
        break;
      default:
        throw new CliError(`Managed policy "${path}" has an unknown "${key}" setting.`);
    }
    sources[key] = path;
  }

  return { settings, sources };
}
