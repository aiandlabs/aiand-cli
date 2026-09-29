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
import {
  clearAddedState,
  discardSnapshot,
  fileCreatedByUs,
  getAddedState,
  hasSnapshot,
  recordAddedState,
} from "./snapshot.js";
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

const CODEX_ID = "codex";
const CODEX_BIN = "codex";
const PROFILE = "aiand";
const PROVIDER_ID = "aiand";
const PROVIDER_TABLE = `model_providers.${PROVIDER_ID}`;
const AUTH_TABLE = `${PROVIDER_TABLE}.auth`;
// Also the ownership marker: --strict-config rejects unknown keys, so no marker key can be added.
const AUTH_COMMAND = "aiand";
const AUTH_ARGS = ["key", "export"];
const WIRE_API = "responses";
// ai& serves function tools only; a hosted tool fails the whole request.
const HOSTED_OFF: TomlTable = { web_search: "disabled" };
// The guide's `[tools] view_image` is not a Codex setting (0.152 ignores it,
// 0.158 warns, --strict-config rejects it); the switch lives under features.
const FEATURES: TomlTable = {
  unified_exec: false,
  apps: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  image_generation: false,
  multi_agent: false,
  in_app_browser: false,
  view_image: false,
};
// Codex's /model writes these into the profile: a pick, not an edit to ai&'s settings.
const PICK_KEYS = new Set(["model", "model_reasoning_effort", "plan_mode_reasoning_effort"]);
// Preferred over the catalog default, which can be the model's most expensive level.
const PREFERRED_EFFORT = "high";
const isCodexWritten = (section: TomlSection): boolean => section.name.startsWith("projects.");

type CodexRecord = {
  codexOwned?: string;
};

const HEADER =
  "# Managed by aiand: `aiand codex off` removes it. Use with `codex --profile aiand`.\n";

function codexProfilePath(): string {
  const dir = process.env.CODEX_HOME || join(agentHome(), ".codex");
  return join(dir, `${PROFILE}.config.toml`);
}

const codexBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

// Codex spawns the auth command without a PATHEXT lookup, so bare `aiand` misses `aiand.cmd`.
export function windowsLauncher(whereOutput: string): string | null {
  return (
    whereOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /\.(?:cmd|exe|bat)$/i.test(line)) ?? null
  );
}

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

// `/v1/responses` rejects a level the model does not publish, so one it does is always pinned.
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
  // Plan Mode ignores `model_reasoning_effort` and falls back to `medium`, which most ai& models
  // don't publish.
  planEffort?: string;
  baseUrl?: string;
  command: string;
  profileName: string;
};

function ownedTables(session: Session): [string, TomlTable][] {
  return [
    [
      "",
      {
        model: session.model,
        ...(session.effort ? { model_reasoning_effort: session.effort } : {}),
        ...(session.planEffort ? { plan_mode_reasoning_effort: session.planEffort } : {}),
        model_provider: PROVIDER_ID,
        ...HOSTED_OFF,
      },
    ],
    [PROVIDER_TABLE, { name: "ai&", base_url: codexBaseUrl(session.baseUrl), wire_api: WIRE_API }],
    [
      AUTH_TABLE,
      { command: session.command, args: [...AUTH_ARGS, "--profile", session.profileName] },
    ],
    ["features", FEATURES],
  ];
}

const OWNED_KEYS = new Map(
  ownedTables({ model: "", effort: "x", planEffort: "x", command: "", profileName: "" }).map(
    ([name, table]) => [name, new Set(Object.keys(table))],
  ),
);

const KEY_LINE = /^\s*([A-Za-z0-9_-]+)\s*=/;

function ownedKey(table: string, line: string): string | null {
  const key = KEY_LINE.exec(line)?.[1];
  return key !== undefined && OWNED_KEYS.get(table)?.has(key) ? key : null;
}

function theirLines(section: TomlSection): string {
  return section.text
    .split(/(?<=\n)/)
    .filter((_line, index) => !(section.name && index === 0))
    .filter((line) => line !== HEADER && ownedKey(section.name, line) === null)
    .join("")
    .replace(/\s+$/, "");
}

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

function leftover(section: TomlSection): string {
  const lines = OWNED_KEYS.has(section.name) ? theirLines(section) : section.text.trim();
  if (!hasContent(lines)) return "";
  const header = OWNED_KEYS.has(section.name) && section.name ? `[${section.name}]\n` : "";
  return `${header}${lines.trim()}\n`;
}

function markedByUs(keys: Record<string, Record<string, unknown>>): boolean {
  const auth = keys[AUTH_TABLE];
  const args = auth?.args;
  // Other args could select another credential, so they read as someone else's profile.
  return (
    isAuthCommand(auth?.command) &&
    Array.isArray(args) &&
    args.length === AUTH_ARGS.length + 2 &&
    AUTH_ARGS.every((arg, index) => args[index] === arg) &&
    args[AUTH_ARGS.length] === "--profile" &&
    typeof args[AUTH_ARGS.length + 1] === "string" &&
    args[AUTH_ARGS.length + 1] !== ""
  );
}

function routesElsewhere(sections: TomlSection[], keys: Record<string, Record<string, unknown>>) {
  if (markedByUs(keys)) return false;
  return (
    keys[""]?.model_provider !== undefined ||
    sections.some((section) => section.name === PROVIDER_TABLE || section.name === AUTH_TABLE)
  );
}

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

  const current = keys[""]?.model;
  const keep = !input.pinModel && marked && inCatalog(input.catalog, current);
  const model = keep ? current : input.model;
  const command = resolveAuthCommand();
  if (command === null) {
    warnings.push("Codex runs `aiand key export` for the key, so aiand must be on its PATH.");
  }
  const catalogModel = input.catalog.find((entry) => entry.id === model);
  const tables = ownedTables({
    model,
    effort: effortFor(catalogModel, keep ? keys[""]?.model_reasoning_effort : undefined),
    planEffort: effortFor(catalogModel, keep ? keys[""]?.plan_mode_reasoning_effort : undefined),
    baseUrl: input.baseUrl,
    command: command ?? AUTH_COMMAND,
    profileName: input.profileName,
  });

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
    // No key lives in the file, so it keeps its mode rather than 0600.
    await writeFileAtomic(path, text, { mode: (await existingFileMode(path)) ?? 0o644 });
  }
  await recordAddedState(CODEX_ID, {
    codexOwned: ownedText(splitSections(text)),
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
  // A snapshot holding a profile's bytes is the user's only copy, so it outlives off.
  if (await fileCreatedByUs(CODEX_ID, path)) {
    await discardSnapshot(CODEX_ID);
  } else if (await hasSnapshot(CODEX_ID)) {
    notes.push("run aiand restore codex --force to bring back your previous profile");
  }
  await clearAddedState(CODEX_ID);
  return { stripped: true, notes };
}

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
  async refreshKey(): Promise<boolean> {
    return false;
  },
  async sessionLaunch(input: SessionLaunchInput) {
    const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
    const effort = effortFor(input.catalog.find((entry) => entry.id === model));
    const tables = ownedTables({
      model,
      effort,
      planEffort: effort,
      baseUrl: input.baseUrl,
      command: resolveAuthCommand() ?? AUTH_COMMAND,
      profileName: input.profileName,
    });
    // Codex's `aiand key export` runs as its child and can only find an AIAND_API_KEY session
    // there.
    const env: Record<string, string> = process.env.AIAND_API_KEY
      ? { AIAND_API_KEY: input.apiKey }
      : {};
    return { env, args: codexOverrides(tables) };
  },
};
