#!/usr/bin/env node
/**
 * Release helper. Publishing itself is publish.yml, on a pushed v<version> tag.
 *
 *   node scripts/release.mjs prepare <patch|minor|major|x.y.z>
 *     From an up-to-date main: bump package.json, combine changes/*.md notes
 *     and CHANGELOG's [Unreleased] body into the new version's section, consume
 *     the notes, run the checks, commit on release/v<version>, push it, and
 *     open the PR.
 *   node scripts/release.mjs tag
 *     On main once that PR merged and CI passed: tag v<package.json version>
 *     and push the tag, which publishes.
 *   node scripts/release.mjs notes <version>
 *     Print that version's CHANGELOG section (publish.yml's release notes).
 *   node scripts/release.mjs prebuilt-sums <directory>
 *     Print SHA256SUMS for the validated prebuilt release assets in directory.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const BUMPS = ["major", "minor", "patch"];
const CATEGORIES = ["Added", "Changed", "Fixed", "Removed"];
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

/** Validate a prebuilt release directory and return its assets and SHA256SUMS body. */
export function prebuiltReleaseManifest(directory, version) {
  const match = SEMVER.exec(version);
  if (!match || match[0] !== version) throw new Error(`version ${version} is not x.y.z`);
  const inputs = [
    `aiand-cli-${version}.tgz`,
    "install.sh",
    "install.ps1",
    "aiand-darwin-arm64",
    "aiand-darwin-x64",
    "aiand-linux-x64",
    "aiand-linux-arm64",
    "aiand-win32-x64.exe",
  ];
  const assets = [...inputs, "SHA256SUMS"];
  const allowed = new Set(assets);
  const root = resolve(directory);
  for (const name of readdirSync(root).sort()) {
    if (!allowed.has(name)) throw new Error(`unexpected release asset: ${name}`);
  }

  for (const name of inputs) {
    let stat;
    try {
      stat = lstatSync(join(root, name));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`missing release asset: ${name}`);
      throw error;
    }
    if (!stat.isFile()) throw new Error(`release asset ${name} is not a regular file`);
  }

  const sha256sums = inputs
    .map((name) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex");
      return `${digest}  ${name}\n`;
    })
    .join("");
  return { assets, sha256sums };
}

/** Read and combine per-change release notes, returning the exact files consumed. */
export function readChangeNotes(directory) {
  const root = resolve(directory);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { files: [], body: "" };
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(root, entry.name))
    .sort();
  const grouped = new Map(CATEGORIES.map((category) => [category, []]));

  for (const file of files) {
    let category = null;
    let lines = [];
    let hasEntries = false;
    const flush = () => {
      if (!category) return;
      const body = lines.join("\n").trim();
      if (body) grouped.get(category).push(body);
    };

    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)) {
        flush();
        const heading = /^### (Added|Changed|Fixed|Removed)[ \t]*$/.exec(line);
        if (!heading) throw new Error(`${file} has an unknown heading: ${line.trim()}`);
        category = heading[1];
        lines = [];
        continue;
      }
      if (category) {
        lines.push(line);
        if (line.startsWith("- ")) hasEntries = true;
      }
    }
    flush();
    if (!hasEntries) throw new Error(`${file} has no release-note entries`);
  }

  const body = CATEGORIES.flatMap((category) => {
    const bodies = grouped.get(category);
    return bodies.length ? [`### ${category}\n\n${bodies.join("\n")}`] : [];
  }).join("\n\n");
  return { files, body: body.trim() };
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
 * Date the legacy [Unreleased] entries and pending notes as `version`, and
 * leave an empty [Unreleased] above them. Refuses no entries or a duplicate version.
 */
export function cutRelease(changelog, pendingBody, version, date) {
  const lines = changelog.split("\n");
  if (sectionRange(lines, version))
    throw new Error(`CHANGELOG.md already has a [${version}] section`);
  const range = sectionRange(lines, "Unreleased");
  if (!range) throw new Error(`CHANGELOG.md has no ${UNRELEASED} section`);
  const legacyBody = lines
    .slice(...range)
    .join("\n")
    .trim();
  const pending = pendingBody.trim();
  const hasEntries = (body) => body.split("\n").some((line) => line.startsWith("- "));
  if (!hasEntries(legacyBody) && !hasEntries(pending)) {
    throw new Error(`CHANGELOG.md's ${UNRELEASED} section has no entries to release`);
  }
  const body = [legacyBody, pending].filter(Boolean).join("\n\n");
  lines.splice(
    range[0] - 1,
    range[1] - range[0] + 1,
    UNRELEASED,
    "",
    `## [${version}] - ${date}`,
    "",
    ...body.split("\n"),
    "",
  );
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
  const pending = readChangeNotes(join(ROOT, "changes"));
  const changelog = cutRelease(readFileSync(CHANGELOG, "utf8"), pending.body, version, date);

  const branch = `release/v${version}`;
  git("switch", "--create", branch);
  run("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts"]);
  writeFileSync(CHANGELOG, changelog);
  for (const file of pending.files) unlinkSync(file);
  for (const args of CHECKS) run("npm", args);

  git("add", "package.json", "package-lock.json", "CHANGELOG.md", ...pending.files);
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

function prebuiltSums(directory) {
  if (!directory) fail("usage: release.mjs prebuilt-sums <directory>");
  const { sha256sums } = prebuiltReleaseManifest(directory, readVersion());
  process.stdout.write(sha256sums);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === "prepare") prepare(arg);
    else if (command === "tag") tag();
    else if (command === "notes") notes(arg);
    else if (command === "prebuilt-sums") prebuiltSums(arg);
    else fail("usage: release.mjs <prepare <bump>|tag|notes <version>|prebuilt-sums <directory>>");
  } catch (error) {
    fail(error.message);
  }
}
