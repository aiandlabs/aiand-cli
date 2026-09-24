#!/usr/bin/env node
/**
 * Release helper. Publishing itself is publish.yml, on a pushed v<version> tag.
 *
 *   node scripts/release.mjs prepare <patch|minor|major|x.y.z>
 *     From an up-to-date main: bump package.json, turn CHANGELOG's
 *     [Unreleased] section into the new version's, run the checks, commit on
 *     release/v<version>, push it, and open the PR.
 *   node scripts/release.mjs tag
 *     On main once that PR merged and CI passed: tag v<package.json version>
 *     and push the tag, which publishes.
 *   node scripts/release.mjs notes <version>
 *     Print that version's CHANGELOG section (publish.yml's release notes).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const BUMPS = ["major", "minor", "patch"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED = "## [Unreleased]";
const CHECKS = [["run", "lint"], ["test"], ["run", "check:dist"], ["run", "check:public"]];

/** The version after `current` for a bump name, or `target` itself when it is x.y.z. */
export function nextVersion(current, target) {
  const parts = SEMVER.exec(current);
  if (!parts) throw new Error(`package.json version ${current} is not x.y.z`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (target === "major") return `${major + 1}.0.0`;
  if (target === "minor") return `${major}.${minor + 1}.0`;
  if (target === "patch") return `${major}.${minor}.${patch + 1}`;
  if (!SEMVER.test(target)) throw new Error(`expected ${BUMPS.join("|")} or x.y.z, got ${target}`);
  return target;
}

/** Line range [start, end) of the `## [<name>]` section body, or null. */
function sectionRange(lines, name) {
  const start = lines.findIndex(
    (line) => line === `## [${name}]` || line.startsWith(`## [${name}] `),
  );
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  return [start + 1, next < 0 ? lines.length : next];
}

/**
 * Date the [Unreleased] entries as `version` and leave an empty [Unreleased]
 * above them. Refuses an empty [Unreleased] or a version already present.
 */
export function cutRelease(changelog, version, date) {
  const lines = changelog.split("\n");
  if (sectionRange(lines, version))
    throw new Error(`CHANGELOG.md already has a [${version}] section`);
  const range = sectionRange(lines, "Unreleased");
  if (!range) throw new Error(`CHANGELOG.md has no ${UNRELEASED} section`);
  if (!lines.slice(...range).some((line) => line.startsWith("- "))) {
    throw new Error(`CHANGELOG.md's ${UNRELEASED} section has no entries to release`);
  }
  lines.splice(range[0] - 1, 1, UNRELEASED, "", `## [${version}] - ${date}`);
  return lines.join("\n");
}

/** The body of the `## [<version>]` section, trimmed, or null when absent. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const range = sectionRange(lines, version);
  return range
    ? lines
        .slice(...range)
        .join("\n")
        .trim()
    : null;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/** Clean tree, on main, and exactly at origin/main. */
function assertAtOriginMain() {
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes");
  if (git("branch", "--show-current") !== "main") fail("switch to main first");
  git("fetch", "--quiet", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    fail("main is not at origin/main; pull (or push) first");
  }
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    // npm is npm.cmd on Windows and needs cmd.exe; a shell would re-split
    // everything else's arguments (gh's --title and --body) on spaces.
    shell: process.platform === "win32" && command === "npm",
  });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
}

function prepare(target) {
  if (!target) fail(`usage: release.mjs prepare <${BUMPS.join("|")}|x.y.z>`);
  assertAtOriginMain();
  const version = nextVersion(readVersion(), target);
  const date = new Date().toISOString().slice(0, 10);
  const changelog = cutRelease(readFileSync(CHANGELOG, "utf8"), version, date);

  const branch = `release/v${version}`;
  git("switch", "--create", branch);
  run("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts"]);
  writeFileSync(CHANGELOG, changelog);
  for (const args of CHECKS) run("npm", args);

  git("add", "package.json", "package-lock.json", "CHANGELOG.md");
  git("commit", "--quiet", "--message", `release: v${version}`);
  run("git", ["push", "--set-upstream", "origin", branch]);
  run("gh", [
    "pr",
    "create",
    "--title",
    `release: v${version}`,
    "--body",
    `Bumps to ${version} and dates its CHANGELOG section. After merge and a green CI run on main: \`node scripts/release.mjs tag\`.`,
  ]);
}

function tag() {
  assertAtOriginMain();
  const version = readVersion();
  const name = `v${version}`;
  if (git("tag", "--list", name)) fail(`${name} already exists`);
  if (!releaseNotes(readFileSync(CHANGELOG, "utf8"), version)) {
    fail(`CHANGELOG.md has no [${version}] section`);
  }
  const head = git("rev-parse", "HEAD");
  const passed = execFileSync(
    "gh",
    [
      ...["run", "list", "--workflow", "CI", "--commit", head, "--event", "push"],
      ...["--status", "success", "--json", "databaseId", "--jq", "length"],
    ],
    { cwd: ROOT, encoding: "utf8" },
  ).trim();
  if (passed === "0") fail(`no successful CI run on main for ${head.slice(0, 7)} yet`);
  git("tag", name);
  run("git", ["push", "origin", name]);
  console.log(`Pushed ${name}; publish.yml takes it from here.`);
}

function notes(version) {
  const body = version && releaseNotes(readFileSync(CHANGELOG, "utf8"), version);
  if (!body) fail(`CHANGELOG.md has no [${version}] section`);
  console.log(body);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === "prepare") prepare(arg);
    else if (command === "tag") tag();
    else if (command === "notes") notes(arg);
    else fail("usage: release.mjs <prepare <bump>|tag|notes <version>>");
  } catch (error) {
    fail(error.message);
  }
}
