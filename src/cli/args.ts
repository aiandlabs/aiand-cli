import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError } from "./errors.js";

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

/** Accepted by every command. */
export const GLOBAL_OPTIONS = {
  profile: { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies OptionsConfig;

export type Parsed = {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
};

/**
 * Parse one command's argv. `--base-url` is applied to the environment so
 * `resolveProfile()` stays the single place precedence lives.
 */
export function parse(argv: string[], options: OptionsConfig = {}): Parsed {
  let parsed: Parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    }) as Parsed;
  } catch (e) {
    // parseArgs appends a paragraph about `--` handling that is noise here;
    // keep the first sentence, which names the offending option.
    const [first] = (e as Error).message.split(". ");
    throw new CliError(`${(first ?? "Could not parse the arguments").replace(/\.$/, "")}.`, {
      hint: "Run the command with --help to see its flags.",
    });
  }

  const baseUrl = parsed.values["base-url"];
  if (typeof baseUrl === "string") process.env.AIAND_BASE_URL = baseUrl;

  return parsed;
}

export const str = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
};

export const bool = (parsed: Parsed, name: string): boolean => parsed.values[name] === true;

export function int(parsed: Parsed, name: string): number | undefined {
  const raw = str(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new CliError(`--${name} must be a whole number (got "${raw}").`);
  }
  return value;
}

export function float(parsed: Parsed, name: string): number | undefined {
  const raw = str(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new CliError(`--${name} must be a number (got "${raw}").`);
  }
  return value;
}

/** Validate a flag against a fixed set, with the set in the error message. */
export function oneOf<T extends string>(
  parsed: Parsed,
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = str(parsed, name);
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new CliError(`--${name} must be one of: ${allowed.join(", ")} (got "${raw}").`);
  }
  return raw as T;
}
