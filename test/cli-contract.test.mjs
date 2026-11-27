import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import test from "node:test";
import { AGENTS, findAgent } from "../dist/agents/registry.js";
import { COMMANDS, findCommand } from "../dist/commands/index.js";

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
