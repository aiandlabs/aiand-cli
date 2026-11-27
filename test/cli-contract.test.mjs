import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AGENTS, findAgent } from "../dist/agents/registry.js";
import { agentHelp } from "../dist/commands/agent.js";
import { COMMANDS, findCommand } from "../dist/commands/index.js";
import { configDir, configPath, credentialsPath } from "../dist/config.js";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

const { EXIT } = await import("../dist/cli/errors.js");

/**
 * @param {URL} url
 * @param {string} heading
 * @returns {Array<{ key: string, code: number }>}
 */
function readExitContract(url, heading) {
  const lines = readFileSync(url, "utf8").split(/\r?\n/);
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Missing exit-code section ${heading} in ${url}`);

  const nextSection = lines.slice(start + 1).findIndex((line) => /^##(?!#)\s/.test(line));
  const end = nextSection === -1 ? lines.length : start + 1 + nextSection;
  const section = lines.slice(start + 1, end);
  const tableStart = section.findIndex((line) => line.trimStart().startsWith("|"));
  let tableEnd = tableStart;
  while (tableEnd !== -1 && tableEnd < section.length) {
    if (!section[tableEnd].trimStart().startsWith("|")) break;
    tableEnd += 1;
  }

  const rows = [];
  const keys = new Set();
  const codes = new Set();
  for (const line of section.slice(tableStart + 2, tableEnd)) {
    const cells = line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const codeCell = /^`([^`]*)`$/.exec(cells[0] ?? "")?.[1];
    const key = /^`([^`]*)`$/.exec(cells.at(-1) ?? "")?.[1];
    if (codeCell === undefined || !key) {
      throw new Error(`Malformed exit-code contract row in ${url}: ${line}`);
    }
    if (!/^\d+$/.test(codeCell)) {
      throw new Error(`Malformed numeric exit code in ${url}: ${codeCell}`);
    }
    const code = Number(codeCell);
    if (!Number.isSafeInteger(code)) {
      throw new Error(`Malformed numeric exit code in ${url}: ${codeCell}`);
    }
    if (keys.has(key)) throw new Error(`Duplicate exit contract key ${key} in ${url}`);
    if (codes.has(code)) throw new Error(`Duplicate exit contract code ${code} in ${url}`);
    keys.add(key);
    codes.add(code);
    rows.push({ key, code });
  }
  if (rows.length === 0) throw new Error(`No exit-code contract rows in ${url}`);
  return rows;
}

/**
 * @param {URL} url
 * @param {string} heading
 * @returns {Array<{ kind: "command" | "agent", name: string, aliases: string[] }>}
 */
function readDispatchContract(url, heading) {
  const lines = readFileSync(url, "utf8").split(/\r?\n/);
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`Missing dispatch contract subsection ${heading} in ${url}`);

  const nextSection = lines.slice(start + 1).findIndex((line) => /^#{1,3}(?!#)\s/.test(line));
  const end = nextSection === -1 ? lines.length : start + 1 + nextSection;
  const section = lines.slice(start + 1, end);
  const tableStart = section.findIndex((line) => line.trimStart().startsWith("|"));
  if (tableStart === -1) throw new Error(`No dispatch contract table in ${heading} in ${url}`);
  let tableEnd = tableStart;
  while (tableEnd < section.length && section[tableEnd].trimStart().startsWith("|")) {
    tableEnd += 1;
  }
  const table = section.slice(tableStart, tableEnd);
  if (table.length < 3) throw new Error(`Malformed dispatch contract table in ${url}`);

  const cellsFor = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error(`Malformed dispatch contract row in ${url}: ${line}`);
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  };

  const header = cellsFor(table[0]);
  const kindColumn = header.indexOf("Kind");
  const nameColumn = header.indexOf("Name");
  const aliasesColumn = header.indexOf("Aliases");
  if (header.length !== 4 || kindColumn === -1 || nameColumn === -1 || aliasesColumn === -1) {
    throw new Error(`Malformed dispatch contract header in ${url}: ${table[0]}`);
  }
  const separator = cellsFor(table[1]);
  if (separator.length !== header.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`Malformed dispatch contract separator in ${url}: ${table[1]}`);
  }

  const rows = [];
  const names = new Set();
  for (const line of table.slice(2)) {
    const cells = cellsFor(line);
    const kind = cells[kindColumn];
    const name = /^`([^`]+)`$/.exec(cells[nameColumn] ?? "")?.[1];
    if (cells.length !== header.length || (kind !== "command" && kind !== "agent") || !name) {
      throw new Error(`Malformed dispatch contract row in ${url}: ${line}`);
    }
    if (names.has(name)) throw new Error(`Duplicate dispatch contract name ${name} in ${url}`);

    const aliasesCell = cells[aliasesColumn];
    const aliases =
      aliasesCell === "" || aliasesCell === "-"
        ? []
        : aliasesCell.split(",").map((cell) => {
            const alias = /^`([^`]+)`$/.exec(cell)?.[1];
            if (!alias) throw new Error(`Malformed dispatch contract alias in ${url}: ${line}`);
            return alias;
          });
    if (new Set(aliases).size !== aliases.length) {
      throw new Error(`Duplicate dispatch contract alias in ${url}: ${line}`);
    }
    names.add(name);
    rows.push({ kind, name, aliases: aliases.sort() });
  }
  if (rows.length === 0) throw new Error(`No dispatch contract rows in ${url}`);
  return rows;
}

/**
 * @param {Array<{ kind: "command" | "agent", name: string, aliases: string[] }>} rows
 * @returns {Array<{ kind: "command" | "agent", name: string, aliases: string[] }>}
 */
function normalizeDispatch(rows) {
  return rows
    .map(({ kind, name, aliases }) => ({ kind, name, aliases: [...aliases].sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/**
 * @returns {Array<{ kind: "command" | "agent", name: string, aliases: string[] }>}
 */
function runtimeDispatchContract() {
  return normalizeDispatch([
    ...COMMANDS.map((command) => ({
      kind: "command",
      name: command.name,
      aliases: command.aliases ?? [],
    })),
    ...AGENTS.map((agent) => ({
      kind: "agent",
      name: agent.id,
      aliases: agent.aliases ?? [],
    })),
  ]);
}

const english = readExitContract(new URL("../README.md", import.meta.url), "Exit codes");
const japanese = readExitContract(new URL("../README.ja.md", import.meta.url), "終了コード");
const original = {
  OK: 0,
  ERROR: 1,
  NOT_SIGNED_IN: 2,
  LOGIN_DENIED: 3,
  BUG: 70,
  NOT_FOUND: 127,
  INTERRUPTED: 130,
  SIGTERM: 143,
};

for (const { key, code } of english) {
  test(`exit contract ${key} is ${code}`, () => {
    if (key === "SIGTERM") {
      assert.equal(code, 128 + constants.signals.SIGTERM);
      return;
    }
    assert.equal(Object.hasOwn(EXIT, key), true, `EXIT has its own ${key} property`);
    assert.equal(EXIT[key], code);
  });
}

test("exit-code references agree in English and Japanese", () => {
  const byKey = (a, b) => a.key.localeCompare(b.key);
  assert.deepEqual([...english].sort(byKey), [...japanese].sort(byKey));
});

test("the original exit-code reference is only extended", () => {
  for (const [language, rows] of [
    ["English", english],
    ["Japanese", japanese],
  ]) {
    for (const [key, code] of Object.entries(original)) {
      assert.ok(
        rows.some((row) => row.key === key && row.code === code),
        `${language} retains ${key} as ${code}`,
      );
    }
  }
});

const englishDispatch = readDispatchContract(
  new URL("../README.md", import.meta.url),
  "Command and agent name contract",
);
const japaneseDispatch = readDispatchContract(
  new URL("../README.ja.md", import.meta.url),
  "コマンド名とエージェント名のコントラクト",
);

// Frozen pre-1.0 baseline: a pure addition updates the registries and both references,
// but does not rewrite or regenerate originalDispatch.
const originalDispatch = [
  { kind: "command", name: "login", aliases: [] },
  { kind: "command", name: "logout", aliases: [] },
  { kind: "command", name: "whoami", aliases: [] },
  { kind: "command", name: "run", aliases: ["ask"] },
  { kind: "command", name: "chat", aliases: [] },
  { kind: "command", name: "models", aliases: ["ls-models"] },
  { kind: "command", name: "logs", aliases: [] },
  { kind: "command", name: "usage", aliases: ["analytics"] },
  { kind: "command", name: "orgs", aliases: [] },
  { kind: "command", name: "config", aliases: [] },
  { kind: "command", name: "init", aliases: [] },
  { kind: "command", name: "restore", aliases: [] },
  { kind: "command", name: "status", aliases: [] },
  { kind: "command", name: "run-agent", aliases: [] },
  { kind: "command", name: "key", aliases: [] },
  { kind: "agent", name: "opencode", aliases: ["code"] },
  { kind: "agent", name: "claude", aliases: ["claude-code"] },
  { kind: "agent", name: "codex", aliases: [] },
  { kind: "agent", name: "pi", aliases: [] },
  { kind: "agent", name: "omp", aliases: ["oh-my-pi"] },
  { kind: "agent", name: "copilot", aliases: [] },
  { kind: "agent", name: "copilot-app", aliases: [] },
  { kind: "agent", name: "hermes", aliases: ["hermes-agent"] },
  { kind: "agent", name: "jouzu", aliases: ["jz"] },
];

for (const { kind, name, aliases } of englishDispatch) {
  test(`dispatch contract ${kind}:${name} resolves to its runtime owner`, () => {
    const expected =
      kind === "command"
        ? COMMANDS.find((command) => command.name === name)
        : AGENTS.find((agent) => agent.id === name);
    assert.ok(expected, `${kind} ${name} is registered`);

    for (const dispatchName of [name, ...aliases]) {
      const owner = kind === "command" ? findCommand(dispatchName) : findAgent(dispatchName);
      assert.equal(owner, expected, `${dispatchName} resolves to the documented ${kind} ${name}`);
      assert.equal(kind === "command" ? owner?.name : owner?.id, name);
    }
  });
}

test("English dispatch reference matches the command and agent registries", () => {
  assert.deepEqual(normalizeDispatch(englishDispatch), runtimeDispatchContract());
});

test("command and agent name references agree in English and Japanese", () => {
  assert.deepEqual(normalizeDispatch(englishDispatch), normalizeDispatch(japaneseDispatch));
});

test("the original command and agent name reference is only extended", () => {
  for (const [inventory, rows] of [
    ["English", englishDispatch],
    ["Japanese", japaneseDispatch],
    ["runtime", runtimeDispatchContract()],
  ]) {
    for (const originalRow of originalDispatch) {
      assert.ok(
        rows.some(
          (row) =>
            row.kind === originalRow.kind &&
            row.name === originalRow.name &&
            originalRow.aliases.every((alias) => row.aliases.includes(alias)),
        ),
        `${inventory} retains ${originalRow.kind}:${originalRow.name} and its original aliases`,
      );
    }
  }
});

test("command and agent names and aliases have one dispatch owner", () => {
  const owners = new Map([
    ["help", "top-level help"],
    ["banner", "top-level banner"],
  ]);
  for (const command of COMMANDS) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      assert.ok(!owners.has(name), `${name} is already owned by ${owners.get(name)}`);
      owners.set(name, `command:${command.name}`);
    }
  }
  for (const agent of AGENTS) {
    for (const name of [agent.id, ...(agent.aliases ?? [])]) {
      assert.ok(!owners.has(name), `${name} is already owned by ${owners.get(name)}`);
      owners.set(name, `agent:${agent.id}`);
    }
  }
});

/** @typedef {{ owner: string, long: string, short: string | null, takesValue: boolean }} FlagRow */

/**
 * @param {URL} url
 * @param {string} heading
 * @returns {FlagRow[]}
 */
function readFlagContract(url, heading) {
  const lines = readFileSync(url, "utf8").split(/\r?\n/);
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`Missing flag contract subsection ${heading} in ${url}`);

  const nextSection = lines.slice(start + 1).findIndex((line) => /^#{1,3}(?!#)\s/.test(line));
  const end = nextSection === -1 ? lines.length : start + 1 + nextSection;
  const section = lines.slice(start + 1, end);
  const tableStart = section.findIndex((line) => line.trimStart().startsWith("|"));
  if (tableStart === -1) throw new Error(`No flag contract table in ${heading} in ${url}`);
  let tableEnd = tableStart;
  while (tableEnd < section.length && section[tableEnd].trimStart().startsWith("|")) {
    tableEnd += 1;
  }
  const table = section.slice(tableStart, tableEnd);
  if (table.length < 3) throw new Error(`Malformed flag contract table in ${url}`);

  const cellsFor = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error(`Malformed flag contract row in ${url}: ${line}`);
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  };

  const header = cellsFor(table[0]);
  const expectedColumns = ["Owner", "Long flag", "Short flag", "Takes value"];
  if (
    header.length !== expectedColumns.length + 1 ||
    expectedColumns.some((column, index) => header[index] !== column) ||
    header.at(-1) === ""
  ) {
    throw new Error(`Malformed flag contract header in ${url}: ${table[0]}`);
  }
  const separator = cellsFor(table[1]);
  if (separator.length !== header.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`Malformed flag contract separator in ${url}: ${table[1]}`);
  }

  const rows = [];
  const longFlags = new Set();
  const shortFlags = new Set();
  for (const line of table.slice(2)) {
    const cells = cellsFor(line);
    const [owner, longCell, shortCell, takesValueCell, description] = cells;
    const long = /^`(--[a-z0-9]+(?:-[a-z0-9]+)*)`$/.exec(longCell ?? "")?.[1];
    const short =
      shortCell === "-" ? null : (/^`(-[a-z0-9])`$/i.exec(shortCell ?? "")?.[1] ?? undefined);
    if (
      cells.length !== header.length ||
      !/^(?:top-level|(?:command|agent):[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(owner ?? "") ||
      long === undefined ||
      short === undefined ||
      description === ""
    ) {
      throw new Error(`Malformed flag contract row in ${url}: ${line}`);
    }
    if (takesValueCell !== "yes" && takesValueCell !== "no") {
      throw new Error(`Malformed takes-value cell in ${url}: ${line}`);
    }

    const longKey = `${owner} ${long}`;
    if (longFlags.has(longKey)) throw new Error(`Duplicate flag contract row ${longKey} in ${url}`);
    longFlags.add(longKey);
    if (short !== null) {
      const shortKey = `${owner} ${short}`;
      if (shortFlags.has(shortKey)) {
        throw new Error(`Duplicate flag contract short alias ${shortKey} in ${url}`);
      }
      shortFlags.add(shortKey);
    }
    rows.push({ owner, long, short, takesValue: takesValueCell === "yes" });
  }
  if (rows.length === 0) throw new Error(`No flag contract rows in ${url}`);
  return rows;
}

/**
 * @param {string} owner
 * @param {string} help
 * @param {string} [heading="Options"]
 * @returns {FlagRow[]}
 */
function readHelpFlags(owner, help, heading = "Options") {
  const lines = stripVTControlCharacters(help).split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start === -1) return [];

  const rows = [];
  const longFlags = new Set();
  const shortFlags = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    const option =
      /^\s+(?:(-[a-z0-9]),\s+)?(--[a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+(<[^>]+>))?(?:\s+|$)/i.exec(line);
    if (!option) {
      if (/^\s+(?:-\S+,\s+)?--/.test(line)) {
        throw new Error(`Malformed help flag for ${owner}: ${line}`);
      }
      continue;
    }
    const [, short = null, long, value] = option;
    if (longFlags.has(long)) throw new Error(`Duplicate help flag ${owner} ${long}`);
    longFlags.add(long);
    if (short !== null) {
      if (shortFlags.has(short)) throw new Error(`Duplicate help short alias ${owner} ${short}`);
      shortFlags.add(short);
    }
    rows.push({ owner, long, short, takesValue: value !== undefined });
  }
  return rows;
}

/**
 * @param {FlagRow[]} rows
 * @returns {FlagRow[]}
 */
function normalizeFlags(rows) {
  return rows
    .map(({ owner, long, short, takesValue }) => ({ owner, long, short, takesValue }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.long.localeCompare(b.long));
}

/** @returns {Promise<FlagRow[]>} */
async function runtimeFlagContract() {
  const topLevel = await runCli(["--help"], { env: cliEnv() });
  assert.equal(topLevel.code, 0, `top-level help exits successfully: ${topLevel.stderr}`);
  return [
    ...readHelpFlags("top-level", `${topLevel.stdout}\n${topLevel.stderr}`, "Global options"),
    ...COMMANDS.flatMap((command) => readHelpFlags(`command:${command.name}`, command.help)),
    ...AGENTS.flatMap((agent) => readHelpFlags(`agent:${agent.id}`, agentHelp(agent))),
  ];
}

const sandbox = withTestEnv("aiand-cli-contract-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "config");
});

const englishFlags = readFlagContract(new URL("../README.md", import.meta.url), "Flag contract");
const japaneseFlags = readFlagContract(
  new URL("../README.ja.md", import.meta.url),
  "フラグのコントラクト",
);

// Frozen pre-1.0 baseline: a pure addition updates the help and both references,
// but does not rewrite or regenerate originalFlags.
const originalFlags = [
  { owner: "top-level", long: "--profile", short: null, takesValue: true },
  { owner: "top-level", long: "--base-url", short: null, takesValue: true },
  { owner: "top-level", long: "--json", short: null, takesValue: false },
  { owner: "top-level", long: "--help", short: "-h", takesValue: false },
  { owner: "top-level", long: "--version", short: "-v", takesValue: false },
  { owner: "command:login", long: "--base-url", short: null, takesValue: true },
  { owner: "command:login", long: "--profile", short: null, takesValue: true },
  { owner: "command:login", long: "--force", short: null, takesValue: false },
  { owner: "command:login", long: "--keep-remote", short: null, takesValue: false },
  { owner: "command:login", long: "--paste", short: null, takesValue: false },
  { owner: "command:login", long: "--with-token", short: null, takesValue: false },
  { owner: "command:logout", long: "--profile", short: null, takesValue: true },
  { owner: "command:logout", long: "--keep-remote", short: null, takesValue: false },
  { owner: "command:logout", long: "--revoke", short: null, takesValue: false },
  { owner: "command:logout", long: "--all", short: null, takesValue: false },
  { owner: "command:logout", long: "--force", short: null, takesValue: false },
  { owner: "command:whoami", long: "--json", short: null, takesValue: false },
  { owner: "command:whoami", long: "--local", short: null, takesValue: false },
  { owner: "command:whoami", long: "--profile", short: null, takesValue: true },
  { owner: "command:run", long: "--model", short: "-m", takesValue: true },
  { owner: "command:run", long: "--system", short: null, takesValue: true },
  { owner: "command:run", long: "--max-tokens", short: null, takesValue: true },
  { owner: "command:run", long: "--temperature", short: null, takesValue: true },
  { owner: "command:run", long: "--top-p", short: null, takesValue: true },
  { owner: "command:run", long: "--reasoning-effort", short: null, takesValue: true },
  { owner: "command:run", long: "--stop", short: null, takesValue: true },
  { owner: "command:run", long: "--show-reasoning", short: null, takesValue: false },
  { owner: "command:run", long: "--no-stream", short: null, takesValue: false },
  { owner: "command:run", long: "--json", short: null, takesValue: false },
  { owner: "command:run", long: "--quiet", short: "-q", takesValue: false },
  { owner: "command:chat", long: "--model", short: "-m", takesValue: true },
  { owner: "command:chat", long: "--system", short: null, takesValue: true },
  { owner: "command:chat", long: "--max-tokens", short: null, takesValue: true },
  { owner: "command:chat", long: "--temperature", short: null, takesValue: true },
  { owner: "command:chat", long: "--reasoning-effort", short: null, takesValue: true },
  { owner: "command:chat", long: "--show-reasoning", short: null, takesValue: false },
  { owner: "command:models", long: "--search", short: null, takesValue: true },
  { owner: "command:models", long: "--capability", short: null, takesValue: true },
  { owner: "command:models", long: "--sort", short: null, takesValue: true },
  { owner: "command:models", long: "--long", short: null, takesValue: false },
  { owner: "command:models", long: "--json", short: null, takesValue: false },
  { owner: "command:logs", long: "--range", short: null, takesValue: true },
  { owner: "command:logs", long: "--errors", short: null, takesValue: false },
  { owner: "command:logs", long: "--limit", short: null, takesValue: true },
  { owner: "command:logs", long: "--follow", short: null, takesValue: false },
  { owner: "command:logs", long: "--interval", short: null, takesValue: true },
  { owner: "command:logs", long: "--json", short: null, takesValue: false },
  { owner: "command:usage", long: "--range", short: null, takesValue: true },
  { owner: "command:usage", long: "--metrics", short: null, takesValue: false },
  { owner: "command:usage", long: "--json", short: null, takesValue: false },
  { owner: "command:orgs", long: "--json", short: null, takesValue: false },
  { owner: "command:init", long: "--all", short: null, takesValue: false },
  { owner: "command:init", long: "--off", short: null, takesValue: false },
  { owner: "command:init", long: "--force", short: null, takesValue: false },
  { owner: "command:init", long: "--json", short: null, takesValue: false },
  { owner: "command:init", long: "--profile", short: null, takesValue: true },
  { owner: "command:restore", long: "--force", short: null, takesValue: false },
  { owner: "command:restore", long: "--json", short: null, takesValue: false },
  { owner: "command:restore", long: "--help", short: "-h", takesValue: false },
  { owner: "command:status", long: "--json", short: null, takesValue: false },
  { owner: "command:status", long: "--local", short: null, takesValue: false },
  { owner: "command:status", long: "--profile", short: null, takesValue: true },
  { owner: "command:run-agent", long: "--model", short: null, takesValue: true },
  { owner: "command:run-agent", long: "--fast-model", short: null, takesValue: true },
  { owner: "command:run-agent", long: "--profile", short: null, takesValue: true },
  { owner: "command:run-agent", long: "--base-url", short: null, takesValue: true },
  { owner: "command:run-agent", long: "--help", short: "-h", takesValue: false },
  { owner: "command:key", long: "--profile", short: null, takesValue: true },
  { owner: "command:key", long: "--base-url", short: null, takesValue: true },
  { owner: "command:key", long: "--for", short: null, takesValue: true },
  { owner: "command:key", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:opencode", long: "--model", short: null, takesValue: true },
  { owner: "agent:opencode", long: "--force", short: null, takesValue: false },
  { owner: "agent:opencode", long: "--json", short: null, takesValue: false },
  { owner: "agent:opencode", long: "--profile", short: null, takesValue: true },
  { owner: "agent:opencode", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:opencode", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:claude", long: "--model", short: null, takesValue: true },
  { owner: "agent:claude", long: "--fast-model", short: null, takesValue: true },
  { owner: "agent:claude", long: "--force", short: null, takesValue: false },
  { owner: "agent:claude", long: "--json", short: null, takesValue: false },
  { owner: "agent:claude", long: "--profile", short: null, takesValue: true },
  { owner: "agent:claude", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:claude", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:codex", long: "--model", short: null, takesValue: true },
  { owner: "agent:codex", long: "--force", short: null, takesValue: false },
  { owner: "agent:codex", long: "--json", short: null, takesValue: false },
  { owner: "agent:codex", long: "--profile", short: null, takesValue: true },
  { owner: "agent:codex", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:codex", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:pi", long: "--model", short: null, takesValue: true },
  { owner: "agent:pi", long: "--force", short: null, takesValue: false },
  { owner: "agent:pi", long: "--json", short: null, takesValue: false },
  { owner: "agent:pi", long: "--profile", short: null, takesValue: true },
  { owner: "agent:pi", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:pi", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:omp", long: "--model", short: null, takesValue: true },
  { owner: "agent:omp", long: "--force", short: null, takesValue: false },
  { owner: "agent:omp", long: "--json", short: null, takesValue: false },
  { owner: "agent:omp", long: "--profile", short: null, takesValue: true },
  { owner: "agent:omp", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:omp", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:copilot", long: "--model", short: null, takesValue: true },
  { owner: "agent:copilot", long: "--force", short: null, takesValue: false },
  { owner: "agent:copilot", long: "--json", short: null, takesValue: false },
  { owner: "agent:copilot", long: "--profile", short: null, takesValue: true },
  { owner: "agent:copilot", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:copilot", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:copilot-app", long: "--model", short: null, takesValue: true },
  { owner: "agent:copilot-app", long: "--force", short: null, takesValue: false },
  { owner: "agent:copilot-app", long: "--json", short: null, takesValue: false },
  { owner: "agent:copilot-app", long: "--profile", short: null, takesValue: true },
  { owner: "agent:copilot-app", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:copilot-app", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:hermes", long: "--model", short: null, takesValue: true },
  { owner: "agent:hermes", long: "--force", short: null, takesValue: false },
  { owner: "agent:hermes", long: "--json", short: null, takesValue: false },
  { owner: "agent:hermes", long: "--profile", short: null, takesValue: true },
  { owner: "agent:hermes", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:hermes", long: "--help", short: "-h", takesValue: false },
  { owner: "agent:jouzu", long: "--model", short: null, takesValue: true },
  { owner: "agent:jouzu", long: "--force", short: null, takesValue: false },
  { owner: "agent:jouzu", long: "--json", short: null, takesValue: false },
  { owner: "agent:jouzu", long: "--profile", short: null, takesValue: true },
  { owner: "agent:jouzu", long: "--base-url", short: null, takesValue: true },
  { owner: "agent:jouzu", long: "--help", short: "-h", takesValue: false },
];

test("English flag reference matches top-level, command, and agent help", async () => {
  assert.deepEqual(normalizeFlags(englishFlags), normalizeFlags(await runtimeFlagContract()));
});

test("flag references agree in English and Japanese", () => {
  assert.deepEqual(normalizeFlags(englishFlags), normalizeFlags(japaneseFlags));
});

test("the original flag reference is only extended", async () => {
  for (const [inventory, rows] of [
    ["English", englishFlags],
    ["Japanese", japaneseFlags],
    ["runtime", await runtimeFlagContract()],
  ]) {
    for (const originalRow of originalFlags) {
      assert.ok(
        rows.some(
          (row) =>
            row.owner === originalRow.owner &&
            row.long === originalRow.long &&
            row.short === originalRow.short &&
            row.takesValue === originalRow.takesValue,
        ),
        `${inventory} retains ${originalRow.owner} ${originalRow.long} with its original short alias and value arity`,
      );
    }
  }
});

/** @typedef {{ key: string, path: string }} PathRow */

/**
 * @param {URL} url
 * @param {string} heading
 * @returns {PathRow[]}
 */
function readPathContract(url, heading) {
  const lines = readFileSync(url, "utf8").split(/\r?\n/);
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`Missing path contract subsection ${heading} in ${url}`);

  const nextSection = lines.slice(start + 1).findIndex((line) => /^#{1,3}(?!#)\s/.test(line));
  const end = nextSection === -1 ? lines.length : start + 1 + nextSection;
  const section = lines.slice(start + 1, end);
  const tableStart = section.findIndex((line) => line.trimStart().startsWith("|"));
  if (tableStart === -1) throw new Error(`No path contract table in ${heading} in ${url}`);
  let tableEnd = tableStart;
  while (tableEnd < section.length && section[tableEnd].trimStart().startsWith("|")) {
    tableEnd += 1;
  }
  const table = section.slice(tableStart, tableEnd);
  if (table.length < 3) throw new Error(`Malformed path contract table in ${url}`);

  const cellsFor = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error(`Malformed path contract row in ${url}: ${line}`);
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  };

  const expectedColumns = ["Contract key", "Path", "Description"];
  const header = cellsFor(table[0]);
  if (header.length !== 3 || expectedColumns.some((column, index) => header[index] !== column)) {
    throw new Error(`Malformed path contract header in ${url}: ${table[0]}`);
  }
  const separator = cellsFor(table[1]);
  if (separator.length !== 3 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`Malformed path contract separator in ${url}: ${table[1]}`);
  }

  const rows = [];
  const keys = new Set();
  for (const line of table.slice(2)) {
    const cells = cellsFor(line);
    const key = /^`([^`]+)`$/.exec(cells[0] ?? "")?.[1];
    const path = /^`([^`]+)`$/.exec(cells[1] ?? "")?.[1];
    if (cells.length !== 3 || key === undefined || path === undefined) {
      throw new Error(`Malformed path contract row in ${url}: ${line}`);
    }
    if (keys.has(key)) throw new Error(`Duplicate path contract key ${key} in ${url}`);
    keys.add(key);
    rows.push({ key, path });
  }
  if (rows.length === 0) throw new Error(`No path contract rows in ${url}`);
  return rows;
}

/**
 * @param {PathRow[]} rows
 * @returns {PathRow[]}
 */
function normalizePaths(rows) {
  return rows.map(({ key, path }) => ({ key, path })).sort((a, b) => a.key.localeCompare(b.key));
}

const englishPaths = readPathContract(
  new URL("../README.md", import.meta.url),
  "Config file location contract",
);
const japanesePaths = readPathContract(
  new URL("../README.ja.md", import.meta.url),
  "設定ファイルの場所のコントラクト",
);

// Frozen pre-1.0 baseline: a pure addition updates both references,
// but does not rewrite or regenerate originalPaths.
const originalPaths = [
  { key: "config-dir.override", path: "$AIAND_CONFIG_DIR" },
  { key: "config-dir.xdg", path: "$XDG_CONFIG_HOME/aiand" },
  { key: "config-dir.home", path: "~/.config/aiand" },
  { key: "config-file", path: "<config-dir>/config.json" },
  { key: "credentials-file", path: "<config-dir>/credentials.json" },
];

/** @param {string} key */
function documentedPath(key) {
  const row = englishPaths.find((candidate) => candidate.key === key);
  assert.ok(row, `English path contract contains ${key}`);
  return row.path;
}

test("config-file-location references agree in English and Japanese", () => {
  assert.deepEqual(normalizePaths(englishPaths), normalizePaths(japanesePaths));
});

test("the original config-file-location reference is only extended", () => {
  for (const [language, rows] of [
    ["English", englishPaths],
    ["Japanese", japanesePaths],
  ]) {
    for (const originalRow of originalPaths) {
      assert.ok(
        rows.some((row) => row.key === originalRow.key && row.path === originalRow.path),
        `${language} retains ${originalRow.key} as ${originalRow.path}`,
      );
    }
  }
});

test("config directory resolves each documented location", async () => {
  const home = join(sandbox.dir, "directory-home");
  const override = join(sandbox.dir, "directory-override");
  const xdg = join(sandbox.dir, "directory-xdg");

  await withEnv(
    { AIAND_CONFIG_DIR: override, XDG_CONFIG_HOME: xdg, HOME: home, USERPROFILE: home },
    () => {
      assert.equal(documentedPath("config-dir.override"), "$AIAND_CONFIG_DIR");
      assert.equal(configDir(), override);
    },
  );

  await withEnv(
    { AIAND_CONFIG_DIR: undefined, XDG_CONFIG_HOME: xdg, HOME: home, USERPROFILE: home },
    () => {
      const documented = documentedPath("config-dir.xdg");
      const prefix = "$XDG_CONFIG_HOME/";
      assert.ok(documented.startsWith(prefix), "XDG row uses the documented variable");
      assert.equal(configDir(), join(xdg, ...documented.slice(prefix.length).split("/")));
    },
  );

  await withEnv(
    {
      AIAND_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
      HOME: home,
      USERPROFILE: home,
    },
    () => {
      assert.equal(documentedPath("config-dir.home"), "~/.config/aiand");
      assert.equal(configDir(), join(homedir(), ".config", "aiand"));
    },
  );
});

test("config and credential paths match the documented locations", async () => {
  const override = join(sandbox.dir, "file-override");
  await withEnv({ AIAND_CONFIG_DIR: override }, () => {
    const filename = (key) => {
      const prefix = "<config-dir>/";
      const documented = documentedPath(key);
      assert.ok(documented.startsWith(prefix), `${key} is beneath <config-dir>`);
      return documented.slice(prefix.length);
    };
    assert.equal(configPath(), join(override, filename("config-file")));
    assert.equal(credentialsPath(), join(override, filename("credentials-file")));
  });
});

test("config path --json reports the documented config and credential paths", async () => {
  const override = join(sandbox.dir, "json-override");
  await withEnv({ AIAND_CONFIG_DIR: override }, async () => {
    const result = await runCli(["config", "path", "--json"], {
      env: cliEnv({ AIAND_CONFIG_DIR: override }),
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 1);
    assert.equal(output.config, configPath());
    assert.equal(output.credentials, credentialsPath());
  });
});

/** @typedef {{ invocation: string, field: string, type: string }} JsonRow */

/**
 * @param {URL} url
 * @param {string} heading
 * @returns {JsonRow[]}
 */
function readJsonContract(url, heading) {
  const lines = readFileSync(url, "utf8").split(/\r?\n/);
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`Missing JSON output contract subsection ${heading} in ${url}`);

  const nextSection = lines.slice(start + 1).findIndex((line) => /^#{1,3}(?!#)\s/.test(line));
  const end = nextSection === -1 ? lines.length : start + 1 + nextSection;
  const section = lines.slice(start + 1, end);
  const tableStart = section.findIndex((line) => line.trimStart().startsWith("|"));
  if (tableStart === -1) throw new Error(`No JSON output contract table in ${heading} in ${url}`);
  let tableEnd = tableStart;
  while (tableEnd < section.length && section[tableEnd].trimStart().startsWith("|")) {
    tableEnd += 1;
  }
  const table = section.slice(tableStart, tableEnd);
  if (table.length < 3) throw new Error(`Malformed JSON output contract table in ${url}`);

  const cellsFor = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error(`Malformed JSON output contract row in ${url}: ${line}`);
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  };

  const expectedColumns = ["Invocation", "Field", "Type", "Description"];
  const header = cellsFor(table[0]);
  if (header.length !== 4 || expectedColumns.some((column, index) => header[index] !== column)) {
    throw new Error(`Malformed JSON output contract header in ${url}: ${table[0]}`);
  }
  const separator = cellsFor(table[1]);
  if (separator.length !== 4 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`Malformed JSON output contract separator in ${url}: ${table[1]}`);
  }

  const rows = [];
  const fields = new Set();
  for (const line of table.slice(2)) {
    const cells = cellsFor(line);
    const invocation = /^`([^`]+)`$/.exec(cells[0] ?? "")?.[1];
    const field = /^`([^`]+)`$/.exec(cells[1] ?? "")?.[1];
    const type = /^`([^`]+)`$/.exec(cells[2] ?? "")?.[1];
    if (
      cells.length !== 4 ||
      invocation === undefined ||
      field === undefined ||
      (type !== "1" && type !== "string") ||
      cells[3] === ""
    ) {
      throw new Error(`Malformed JSON output contract row in ${url}: ${line}`);
    }
    const key = `${invocation}\0${field}`;
    if (fields.has(key)) {
      throw new Error(`Duplicate JSON output contract field ${invocation} ${field} in ${url}`);
    }
    fields.add(key);
    rows.push({ invocation, field, type });
  }
  if (rows.length === 0) throw new Error(`No JSON output contract rows in ${url}`);
  return rows;
}

/**
 * @param {JsonRow[]} rows
 * @returns {JsonRow[]}
 */
function normalizeJson(rows) {
  return rows
    .map(({ invocation, field, type }) => ({ invocation, field, type }))
    .sort(
      (a, b) =>
        a.invocation.localeCompare(b.invocation) ||
        a.field.localeCompare(b.field) ||
        a.type.localeCompare(b.type),
    );
}

const englishJson = readJsonContract(
  new URL("../README.md", import.meta.url),
  "JSON output contract",
);
const japaneseJson = readJsonContract(
  new URL("../README.ja.md", import.meta.url),
  "JSON 出力コントラクト",
);

// Frozen 1.0 baseline: additions update both references, but never regenerate this list.
const originalJson = [
  { invocation: "config path --json", field: "version", type: "1" },
  { invocation: "config path --json", field: "config", type: "string" },
  { invocation: "config path --json", field: "credentials", type: "string" },
];

/**
 * @param {string} invocation
 * @returns {Promise<Record<string, unknown>>}
 */
async function jsonContractDocument(invocation) {
  const override = join(sandbox.dir, "json-contract-override");
  const result = await runCli(invocation.split(/\s+/), {
    env: cliEnv({ AIAND_CONFIG_DIR: override }),
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(
    output !== null && typeof output === "object" && !Array.isArray(output),
    `${invocation} returns a JSON object`,
  );
  return output;
}

for (const invocation of new Set(englishJson.map((row) => row.invocation))) {
  test(`JSON output ${invocation} matches its reference`, async () => {
    const output = await jsonContractDocument(invocation);
    for (const row of englishJson.filter((candidate) => candidate.invocation === invocation)) {
      assert.ok(Object.hasOwn(output, row.field), `${invocation} includes ${row.field}`);
      if (row.type === "1") {
        assert.equal(output[row.field], 1, `${invocation} ${row.field} is literal 1`);
      } else {
        assert.equal(row.type, "string", `Unsupported documented type ${row.type}`);
        assert.equal(typeof output[row.field], "string", `${invocation} ${row.field} is a string`);
      }
    }
  });
}

test("JSON-output references agree in English and Japanese", () => {
  assert.deepEqual(normalizeJson(englishJson), normalizeJson(japaneseJson));
});

test("the original JSON-output reference is only extended", () => {
  for (const [language, rows] of [
    ["English", englishJson],
    ["Japanese", japaneseJson],
  ]) {
    for (const originalRow of originalJson) {
      assert.ok(
        rows.some(
          (row) =>
            row.invocation === originalRow.invocation &&
            row.field === originalRow.field &&
            row.type === originalRow.type,
        ),
        `${language} retains ${originalRow.invocation} ${originalRow.field} as ${originalRow.type}`,
      );
    }
  }
});
