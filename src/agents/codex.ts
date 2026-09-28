import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "../api/models.js";
import { CliError } from "../cli/errors.js";
import {
  agentHome,
  DEFAULT_BASE_URL,
  isLoopbackHost,
  trimSlash,
  writeFileAtomic,
} from "../config.js";
import { existingFileMode } from "../fsutil.js";
import { resolveDefault } from "./catalog.js";
import { detectBinary, INSTALL_HINTS } from "./detect.js";
import { readTextIfExists } from "./managed-file.js";
import { clearAddedState, discardSnapshot, getAddedState, recordAddedState } from "./snapshot.js";
import {
  readKeys,
  renderInline,
  renderTable,
  splitSections,
  type TomlSection,
  type TomlTable,
} from "./toml.js";
import type {
  AgentAdapter,
  DetectResult,
  DisableResult,
  EnableInput,
  EnableResult,
  ProbeResult,
  SessionLaunchInput,
} from "./types.js";

/** The adapter id (`aiand codex`), also the key for its snapshot state. */
const CODEX_ID = "codex";
const CODEX_BIN = "codex";
/** `codex --profile aiand` layers `$CODEX_HOME/aiand.config.toml` over the user's config.toml. */
const PROFILE = "aiand";
const PROVIDER_ID = "aiand";
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`;
const AUTH_TABLE = `${PROVIDER_TABLE}.auth`;
/**
 * Codex runs this for the key, so none is written anywhere. It also doubles
 * as the ownership marker: Codex's --strict-config rejects unknown keys, and a
 * hand-written profile from the docs prints the key with `sh -c echo` instead.
 */
const AUTH_COMMAND = "aiand";
const AUTH_ARGS = ["key", "export"];
/** Codex 0.141+ speaks only the Responses wire. */
const WIRE_API = "responses";
/** ai& serves function tools only; hosted tools fail every request that carries one. */
const HOSTED_OFF: TomlTable = { web_search: "disabled" };
const TOOLS: TomlTable = { view_image: false };
const FEATURES: TomlTable = {
  unified_exec: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  image_generation: false,
  multi_agent: false,
  in_app_browser: false,
};
/** Codex's /model persists these into the active profile: a pick, not an edit to ai&'s settings. */
const PICK_KEYS = new Set(["model", "model_reasoning_effort"]);
/**
 * ai&'s Codex guide pins this: every model it recommends publishes it, and a
 * catalog default can be the model's most expensive level.
 */
const PREFERRED_EFFORT = "high";
/** Codex writes `[projects."…"] trust_level` into profile files; they go with the profile. */
const isCodexWritten = (section: TomlSection): boolean => section.name.startsWith("projects.");

/** What enable() recorded so off can tell its keys from the user's. */
type CodexRecord = {
  /** Our key lines, for edit detection. */
  codexOwned?: string;
  /** `on --force` replaced a profile ai& did not write; off points at restore. */
  takenOver?: boolean;
};

const HEADER =
  "# Managed by aiand: `aiand codex off` removes it. Use with `codex --profile aiand`.\n";

function codexProfilePath(): string {
  const dir = process.env.CODEX_HOME || join(agentHome(), ".codex");
  return join(dir, `${PROFILE}.config.toml`);
}

/** Codex appends `/responses` and `/models` to the provider's base URL. */
const codexBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/**
 * The first `.cmd`/`.exe`/`.bat` in `where` output. Codex spawns the auth
 * command without a PATHEXT lookup, so on Windows a bare `aiand` would never
 * reach the `aiand.cmd` shim.
 */
export function windowsLauncher(whereOutput: string): string | null {
  return (
    whereOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\.(?:cmd|exe|bat)$/i.test(line)) ?? null
  );
}

/** What Codex can spawn for `aiand`; null when aiand is not on PATH. */
function resolveAuthCommand(): string | null {
  if (process.platform !== "win32") {
    return detectBinary(AUTH_COMMAND).installed ? AUTH_COMMAND : null;
  }
  const where = spawnSync("where", [AUTH_COMMAND], { encoding: "utf8" });
  return windowsLauncher(where.stdout ?? "");
}

const isAuthCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  command
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:cmd|exe|bat)$/, "") === AUTH_COMMAND;

/**
 * `/v1/responses` rejects a level the model does not publish, so a concrete
 * one is always pinned: a level already picked, else `high`, else the
 * model's default, else its first.
 */
function effortFor(model: Model | undefined, current?: unknown): string | undefined {
  const levels = model?.reasoning_efforts ?? [];
  if (levels.length === 0) return undefined;
  if (typeof current === "string" && levels.includes(current)) return current;
  if (levels.includes(PREFERRED_EFFORT)) return PREFERRED_EFFORT;
  const fallback = model?.reasoning_effort_default;
  return fallback && levels.includes(fallback) ? fallback : levels[0];
}

type Session = {
  model: string;
  effort?: string;
  baseUrl?: string;
  command: string;
  /** The aiand profile active at `on`, pinned like the base URL. */
  profileName: string;
};

/**
 * Every table and key `on` owns, in file order: the one description rendered
 * as a file by `on`, as `-c` flags by run-agent, and read back for edit detection.
 */
function ownedTables(session: Session): [string, TomlTable][] {
  return [
    [
      "",
      {
        model: session.model,
        ...(session.effort ? { model_reasoning_effort: session.effort } : {}),
        model_provider: PROVIDER_ID,
        ...HOSTED_OFF,
      },
    ],
    [PROVIDER_TABLE, { name: "ai&", base_url: codexBaseUrl(session.baseUrl), wire_api: WIRE_API }],
    [
      AUTH_TABLE,
      { command: session.command, args: [...AUTH_ARGS, "--profile", session.profileName] },
    ],
    ["tools", TOOLS],
    ["features", FEATURES],
  ];
}

/** Owned keys per table, from the same list `on` renders so the two cannot drift. */
const OWNED_KEYS = new Map(
  ownedTables({ model: "", effort: "x", command: "", profileName: "" }).map(([name, table]) => [
    name,
    new Set(Object.keys(table)),
  ]),
);

const KEY_LINE = /^\s*([A-Za-z0-9_-]+)\s*=/;

/** The key a line sets when that key is one of ours in `table`, else null. */
function ownedKey(table: string, line: string): string | null {
  const key = KEY_LINE.exec(line)?.[1];
  return key !== undefined && OWNED_KEYS.get(table)?.has(key) ? key : null;
}

/** Lines of an owned table that are not ours: the user's keys and comments, header dropped. */
function theirLines(section: TomlSection): string {
  return section.text
    .split(/(?<=\n)/)
    .filter((_line, index) => !(section.name && index === 0))
    .filter((line) => line !== HEADER && ownedKey(section.name, line) === null)
    .join("")
    .replace(/\s+$/, "");
}

/** Our key lines, Codex's own picks excluded, for edit detection. */
function ownedText(sections: TomlSection[]): string {
  return sections
    .filter((section) => OWNED_KEYS.has(section.name))
    .flatMap((section) =>
      section.text.split("\n").filter((line) => {
        const key = ownedKey(section.name, line);
        return key !== null && !PICK_KEYS.has(key);
      }),
    )
    .map((line) => line.trim())
    .join("\n");
}

const hasContent = (text: string): boolean =>
  text.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));

/** A table with only the user's lines left, or nothing when none are. */
function leftover(section: TomlSection): string {
  const lines = OWNED_KEYS.has(section.name) ? theirLines(section) : section.text.trim();
  if (!hasContent(lines)) return "";
  const header = OWNED_KEYS.has(section.name) && section.name ? `[${section.name}]\n` : "";
  return `${header}${lines.trim()}\n`;
}

function markedByUs(keys: Record<string, Record<string, unknown>>): boolean {
  const auth = keys[AUTH_TABLE];
  const args = auth?.args;
  return (
    isAuthCommand(auth?.command) &&
    Array.isArray(args) &&
    args[0] === AUTH_ARGS[0] &&
    args[1] === AUTH_ARGS[1]
  );
}

/** A profile that already routes somewhere: our writes would silently fight it. */
function routesElsewhere(sections: TomlSection[], keys: Record<string, Record<string, unknown>>) {
  if (markedByUs(keys)) return false;
  return (
    keys[""]?.model_provider !== undefined ||
    sections.some((section) => section.name === PROVIDER_TABLE || section.name === AUTH_TABLE)
  );
}

/** Our marker plus an https (or loopback http) base URL. */
function routedByUs(keys: Record<string, Record<string, unknown>>): boolean {
  if (!markedByUs(keys)) return false;
  const baseUrl = keys[PROVIDER_TABLE]?.base_url;
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

const inCatalog = (catalog: Model[], id: unknown): id is string =>
  typeof id === "string" && catalog.some((model) => model.id === id);

async function readProfile(): Promise<{ raw: string; sections: TomlSection[] }> {
  const raw = await readTextIfExists(codexProfilePath());
  return { raw, sections: splitSections(raw) };
}

async function probe(): Promise<ProbeResult> {
  const { sections } = await readProfile();
  const keys = readKeys(sections);
  const active = routedByUs(keys);
  const model = keys[""]?.model;
  return { active, model: active && typeof model === "string" ? model : null };
}

async function enableGuard({ force }: { force: boolean }): Promise<void> {
  const { sections } = await readProfile();
  if (force || !routesElsewhere(sections, readKeys(sections))) return;
  const path = codexProfilePath();
  throw new CliError(`${path} already routes Codex somewhere ai& does not manage.`, {
    hint: "Pass --force to take it over (aiand restore codex --force brings it back), or use aiand run-agent codex, which leaves it alone.",
  });
}

async function enable(input: EnableInput): Promise<EnableResult> {
  if (input.model === "native") {
    throw new CliError("Codex's own models are not on ai&.", {
      hint: "Pass --model with an ai& model id, or leave it out for the default.",
    });
  }
  const path = codexProfilePath();
  const { raw, sections } = await readProfile();
  const keys = readKeys(sections);
  const marked = markedByUs(keys);
  const prior = marked ? await getAddedState<CodexRecord>(CODEX_ID) : null;
  const warnings: string[] = [];

  // A model already in our profile stays unless --model: the user's /model
  // pick, or a previous on's.
  const current = keys[""]?.model;
  const keep = !input.pinModel && marked && inCatalog(input.catalog, current);
  const model = keep ? current : input.model;
  const command = resolveAuthCommand();
  if (command === null) {
    warnings.push("Codex runs `aiand key export` for the key, so aiand must be on its PATH.");
  }
  const tables = ownedTables({
    model,
    effort: effortFor(
      input.catalog.find((entry) => entry.id === model),
      keep ? keys[""]?.model_reasoning_effort : undefined,
    ),
    baseUrl: input.baseUrl,
    command: command ?? AUTH_COMMAND,
    profileName: input.profileName,
  });

  // Only our keys are rewritten: the user's own keys in the same tables, and
  // every table we do not own, stay as they were.
  const byName = new Map(sections.map((section) => [section.name, section]));
  const owned = tables.map(([name, table]) => {
    const section = byName.get(name);
    const theirs = section ? theirLines(section) : "";
    return `${renderTable(name, table)}${theirs.trim() ? `${theirs.trim()}\n` : ""}`;
  });
  const kept = sections.filter((section) => !OWNED_KEYS.has(section.name));
  const text = `${HEADER}${owned.join("\n")}${kept.map((section) => `\n${section.text.trim()}\n`).join("")}`;

  const before = ownedText(sections);
  if (
    prior?.codexOwned !== undefined &&
    before !== prior.codexOwned &&
    before !== ownedText(splitSections(text))
  ) {
    warnings.push(`Rewrote ${path}; your edits to ai&'s settings there were replaced.`);
  }
  warnings.push("Start it with `codex --profile aiand`, or `aiand run-agent codex`.");

  if (text !== raw) {
    // No key lives in the file, so it keeps the mode it had.
    await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? 0o644 });
  }
  await recordAddedState(CODEX_ID, {
    codexOwned: ownedText(splitSections(text)),
    takenOver: prior?.takenOver === true || routesElsewhere(sections, keys),
  });

  return {
    model,
    catalogModel: inCatalog(input.catalog, model) ? model : undefined,
    filesWritten: [path],
    warnings,
  };
}

async function disable(): Promise<DisableResult> {
  const path = codexProfilePath();
  const { sections } = await readProfile();
  if (!markedByUs(readKeys(sections))) {
    await clearAddedState(CODEX_ID);
    return { stripped: false };
  }
  const added = await getAddedState<CodexRecord>(CODEX_ID);
  if (added?.codexOwned !== undefined && ownedText(sections) !== added.codexOwned) {
    // Keep the record so a second off still recognises the edit.
    return { stripped: false, notes: [`left ${path} because you edited it`] };
  }

  const notes: string[] = [];
  const left = sections
    .filter((section) => !isCodexWritten(section))
    .map(leftover)
    .filter(Boolean);
  if (left.length > 0) {
    await writeFileAtomic(path, left.join("\n"), {
      mode: (await existingFileMode(path)) ?? 0o644,
    });
    notes.push(`kept your other settings in ${path}`);
  } else {
    await unlink(path);
  }
  if (added?.takenOver) {
    notes.push("run aiand restore codex --force to bring back your previous profile");
  } else {
    // What the snapshot holds is what off just left, and a stale one would
    // make a later restore undo a profile written after it.
    await discardSnapshot(CODEX_ID);
  }
  await clearAddedState(CODEX_ID);
  return { stripped: true, notes };
}

/** `-c key=value` overrides for a launch that writes no file; the provider goes as one inline table. */
function codexOverrides(tables: [string, TomlTable][]): string[] {
  const pairs: string[] = [];
  const auth = tables.find(([name]) => name === AUTH_TABLE)?.[1] ?? {};
  for (const [name, table] of tables) {
    if (name === AUTH_TABLE) continue;
    if (name === PROVIDER_TABLE) {
      pairs.push(`${name}=${renderInline({ ...table, auth })}`);
      continue;
    }
    for (const [key, value] of Object.entries(table)) {
      pairs.push(`${name ? `${name}.` : ""}${key}=${renderInline(value)}`);
    }
  }
  return pairs.flatMap((pair) => ["-c", pair]);
}

const CODEX_INSTALL = INSTALL_HINTS.codex!;

export const codexAdapter: AgentAdapter = {
  id: CODEX_ID,
  label: "Codex",
  bin: CODEX_BIN,
  install: CODEX_INSTALL,
  detect(): DetectResult {
    return detectBinary(CODEX_BIN);
  },
  managedFiles(): string[] {
    return [codexProfilePath()];
  },
  probe,
  enableGuard,
  enable,
  disable,
  // No key is baked: Codex asks `aiand key export` for the pinned profile's
  // key each time, so a rotation has nothing to swap.
  async refreshKey(): Promise<boolean> {
    return false;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    // Works with no prior `on` and writes nothing: the same settings ride in
    // as `-c` overrides.
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const tables = ownedTables({
      model,
      effort: effortFor(input.catalog.find((entry) => entry.id === model)),
      baseUrl: input.baseUrl,
      command: resolveAuthCommand() ?? AUTH_COMMAND,
      profileName: input.profileName,
    });
    // Codex's auth command is our own child's child: when the session key came
    // from AIAND_API_KEY, `aiand key export` can only find it there.
    const env: Record<string, string> = process.env.AIAND_API_KEY
      ? { AIAND_API_KEY: input.apiKey }
      : {};
    return { env, args: codexOverrides(tables) };
  },
};
