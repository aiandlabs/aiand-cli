import { lstatSync, readFileSync } from "node:fs";
import { CliError } from "./cli/errors.js";
import { windowsSystemTool } from "./cli/win-spawn.js";
import { runTool } from "./fsutil.js";

export const LINUX_POLICY_PATH = "/etc/aiand/policy.json";
export const MACOS_POLICY_PATH = "/Library/Managed Preferences/com.aiand.cli.plist";
export const WINDOWS_MACHINE_POLICY_KEY = "HKLM\\Software\\Policies\\aiand\\cli";
export const WINDOWS_USER_POLICY_KEY = "HKCU\\Software\\Policies\\aiand\\cli";

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
  /**
   * The PAC file URL every request is routed by, or `auto` for WPAD. Ignored
   * while HTTPS_PROXY or HTTP_PROXY is set.
   */
  proxyPac?: string;
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

function validatePolicySettings(source: string, entries: [string, unknown][]): LoadedPolicy {
  const settings: ManagedPolicy = {};
  const sources: Partial<Record<PolicySetting, string>> = {};
  for (const [key, value] of entries) {
    switch (key) {
      case "baseUrl":
        if (!isPolicyText(value)) throw invalidSetting(source, key);
        settings.baseUrl = value;
        break;
      case "allowedModels":
        if (!isAllowlist(value)) throw invalidSetting(source, key);
        settings.allowedModels = value;
        break;
      case "allowedAgents":
        if (!isAllowlist(value)) throw invalidSetting(source, key);
        settings.allowedAgents = value;
        break;
      case "telemetry":
        if (typeof value !== "boolean") throw invalidSetting(source, key);
        settings.telemetry = value;
        break;
      case "selfUpdate":
        if (typeof value !== "boolean") throw invalidSetting(source, key);
        settings.selfUpdate = value;
        break;
      case "proxyPac":
        if (!isPolicyText(value)) throw invalidSetting(source, key);
        settings.proxyPac = value;
        break;
      default:
        throw new CliError(`Managed policy "${source}" has an unknown "${key}" setting.`);
    }
    sources[key] = source;
  }

  return { settings, sources };
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

  return validatePolicySettings(path, Object.entries(parsed as Record<string, unknown>));
}

export async function readMacOSPolicy(options?: {
  path?: string;
  fileSystem?: Pick<PolicyFileSystem, "lstat">;
  run?: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string }>;
}): Promise<LoadedPolicy> {
  const path = options?.path ?? MACOS_POLICY_PATH;
  const fileSystem = options?.fileSystem ?? {
    lstat: (filePath: string) => lstatSync(filePath),
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

  const run = options?.run ?? runTool;
  let result: { code: number | null; stdout: string };
  try {
    result = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      timeoutMs: 10_000,
    });
  } catch {
    throw new CliError(`Managed policy "${path}" could not be read with plutil.`);
  }
  if (result.code !== 0) {
    throw new CliError(`Managed policy "${path}" could not be read with plutil.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new CliError(`Managed policy "${path}" is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`Managed policy "${path}" must contain one JSON object.`);
  }

  return validatePolicySettings(path, Object.entries(parsed as Record<string, unknown>));
}

const WINDOWS_POLICY_TIMEOUT_MS = 10_000;

function invalidWindowsOutput(key: string): CliError {
  return new CliError(`Managed policy "${key}" has invalid reg.exe query output.`);
}

function registryDword(key: string, name: string, data: string): boolean {
  const match = /^0x0{0,7}([01])$/i.exec(data);
  if (match === null) throw invalidSetting(key, name);
  return match[1] === "1";
}

function registryMultiString(data: string): string[] {
  const values = data === "" ? [] : data.split("\\0");
  while (values.at(-1) === "") values.pop();
  return values;
}

function registrySetting(key: string, name: string, type: string, data: string): unknown {
  switch (name) {
    case "baseUrl":
    case "proxyPac":
      if (type !== "REG_SZ") throw invalidSetting(key, name);
      return data;
    case "allowedModels":
    case "allowedAgents":
      if (type !== "REG_MULTI_SZ") throw invalidSetting(key, name);
      return registryMultiString(data);
    case "telemetry":
    case "selfUpdate":
      if (type !== "REG_DWORD") throw invalidSetting(key, name);
      return registryDword(key, name, data);
    default:
      return undefined;
  }
}

function parseWindowsPolicy(key: string, stdout: string): LoadedPolicy {
  const fullKey =
    key === WINDOWS_USER_POLICY_KEY
      ? `HKEY_CURRENT_USER${WINDOWS_USER_POLICY_KEY.slice("HKCU".length)}`
      : `HKEY_LOCAL_MACHINE${WINDOWS_MACHINE_POLICY_KEY.slice("HKLM".length)}`;
  const acceptedHeaders = new Set([key.toLowerCase(), fullKey.toLowerCase()]);
  const entries: [string, unknown][] = [];
  const seen = new Set<string>();
  let foundHeader = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (!foundHeader) {
      if (!acceptedHeaders.has(line.toLowerCase())) throw invalidWindowsOutput(key);
      foundHeader = true;
      continue;
    }

    // reg.exe separates a root value's name, type and data with four spaces.
    // Consuming exactly four keeps any additional data whitespace visible to
    // the same trimmed-string validation used for Linux policy.
    const match = /^ {4}(\S+) {4}(\S+)(?: {4}(.*))?$/.exec(line);
    if (match === null) throw invalidWindowsOutput(key);
    const name = match[1]!;
    const type = match[2]!;
    const rawData = match[3];
    if (seen.has(name)) {
      throw new CliError(`Managed policy "${key}" has a duplicate "${name}" setting.`);
    }
    seen.add(name);
    entries.push([name, registrySetting(key, name, type, rawData ?? "")]);
  }

  if (!foundHeader) throw invalidWindowsOutput(key);
  return validatePolicySettings(key, entries);
}

async function readWindowsHive(
  key: string,
  command: string,
  run: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string }>,
): Promise<LoadedPolicy> {
  let result: { code: number | null; stdout: string };
  try {
    result = await run(command, ["query", key], { timeoutMs: WINDOWS_POLICY_TIMEOUT_MS });
  } catch {
    throw new CliError(`Managed policy "${key}" could not be read with reg.exe.`);
  }

  if (result.code === 1 && result.stdout === "") return { settings: {}, sources: {} };
  if (result.code !== 0) {
    throw new CliError(`Managed policy "${key}" could not be read with reg.exe.`);
  }
  return parseWindowsPolicy(key, result.stdout);
}

export async function readWindowsPolicy(options?: {
  env?: NodeJS.ProcessEnv;
  run?: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ code: number | null; stdout: string }>;
}): Promise<LoadedPolicy> {
  const command = windowsSystemTool("reg.exe", options?.env ?? process.env);
  const run = options?.run ?? runTool;
  const user = await readWindowsHive(WINDOWS_USER_POLICY_KEY, command, run);
  const machine = await readWindowsHive(WINDOWS_MACHINE_POLICY_KEY, command, run);

  return {
    settings: { ...user.settings, ...machine.settings },
    sources: { ...user.sources, ...machine.sources },
  };
}
