import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import test from "node:test";

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
