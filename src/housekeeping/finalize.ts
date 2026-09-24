import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { VERSION } from "../api/client.js";
import { configDir, writeFileAtomic } from "../config.js";

type FinalizeState = {
  lastVersion: string;
};

function finalizePath(): string {
  return join(configDir(), "finalize.json");
}

function readState(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(finalizePath(), "utf8")) as Partial<FinalizeState>;
    return typeof parsed.lastVersion === "string" ? parsed.lastVersion : null;
  } catch {
    return null;
  }
}

async function writeState(lastVersion: string): Promise<void> {
  const state: FinalizeState = { lastVersion };
  await writeFileAtomic(finalizePath(), `${JSON.stringify(state)}\n`);
}

/** A path in the package root, found the same way client.ts finds package.json for VERSION. */
function packageRootPath(name: string): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("../../package.json");
  return join(dirname(packagePath), name);
}

/** How many changelog bullets the "what's new" note shows. */
const MAX_NOTES = 4;

/**
 * Collect the `- ` bullets of one changelog section. A bullet wrapped over
 * several lines is joined back into one; a blank line or any `#` heading
 * (`### Added` and friends) ends it.
 */
export function changelogBullets(lines: string[]): string[] {
  const bullets: string[] = [];
  let current: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      if (current !== null) bullets.push(current);
      current = line;
    } else if (line === "" || line.startsWith("#")) {
      if (current !== null) bullets.push(current);
      current = null;
    } else if (current !== null) {
      current += ` ${line}`;
    }
  }
  if (current !== null) bullets.push(current);
  return bullets;
}

/**
 * The first MAX_NOTES bullets of CHANGELOG.md's `## [<VERSION>]` section, or
 * `null` when the section is missing or unreadable.
 */
async function releaseNotesForVersion(): Promise<string[] | null> {
  try {
    const changelog = await readFile(packageRootPath("CHANGELOG.md"), "utf8");
    const lines = changelog.split("\n");
    const headerRe = new RegExp(`^## \\[${escapeRe(VERSION)}\\]`);
    const startIndex = lines.findIndex((line) => headerRe.test(line));
    if (startIndex < 0) return null;
    const nextIndex = lines.findIndex((line, index) => index > startIndex && /^## \[/.test(line));
    const section = lines.slice(startIndex + 1, nextIndex < 0 ? undefined : nextIndex);
    return changelogBullets(section).slice(0, MAX_NOTES);
  } catch {
    return null;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run version-gated housekeeping when the installed version changed since the
 * last run: a "what's new" note from the changelog for the current version.
 * Returns the collected notes; never throws.
 */
export async function finalizeOnVersionChange(): Promise<string[]> {
  const lastVersion = readState();
  if (lastVersion === VERSION) return [];
  // First install: record the current version without a "what's new" dump.
  if (lastVersion === null) {
    await writeState(VERSION).catch(() => {});
    return [];
  }

  const whatsNew = await releaseNotesForVersion();
  if (whatsNew === null) {
    // Missing/unreadable changelog: keep the one-shot for a later run.
    return [];
  }

  await writeState(VERSION).catch(() => {});
  return whatsNew;
}
