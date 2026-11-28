#!/usr/bin/env node
/**
 * Release helper. Publishing itself is publish.yml: a pushed v<version> tag
 * publishes a stable release, and every push to main publishes to npm's `next`.
 *
 *   node scripts/release.mjs prepare <patch|minor|major|x.y.z>
 *     From an up-to-date main (or release/<major>.x): bump package.json,
 *     combine changes/*.md notes and CHANGELOG's [Unreleased] body into the new
 *     version's section, consume the notes, run the checks, commit on
 *     release/v<version>, push it, and open the PR against that branch.
 *   node scripts/release.mjs tag
 *     On that branch once the PR merged and CI passed: tag
 *     v<package.json version> and push the tag, which publishes.
 *   node scripts/release.mjs notes <version>
 *     Print that version's CHANGELOG section (publish.yml's release notes).
 *   node scripts/release.mjs next-version
 *     Print the `next` version for HEAD (publish.yml, on a push to main).
 *   node scripts/release.mjs dist-tag <version> [<version npm calls latest>]
 *     Print the npm dist-tag a stable release goes out under.
 *   node scripts/release.mjs is-newer <a> <b>
 *     Exit 0 when version a sorts above version b, 1 otherwise.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const BUMPS = ["major", "minor", "patch"];
const CATEGORIES = ["Added", "Changed", "Fixed", "Removed"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ANY_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MAINTENANCE = /^release\/(\d+)\.x$/;
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

/**
 * The version a push to main publishes under npm's `next` dist-tag:
 * `<next patch>-next.<UTC commit time, YYYYMMDDHHmmss>.g<short sha>`.
 * It is above the current release and below the next one, and it comes from
 * the commit alone, so a re-run of the same commit asks for the same version.
 * The `g` keeps a sha made only of digits from reading as a number, which
 * semver forbids to start with 0.
 */
export function nextChannelVersion(current, commitSeconds, sha) {
  const base = nextVersion(current, "patch");
  if (!Number.isSafeInteger(commitSeconds) || commitSeconds <= 0) {
    throw new Error(`expected a commit time in seconds, got ${commitSeconds}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`expected a git sha, got ${sha}`);
  const stamp = new Date(commitSeconds * 1000).toISOString().replace(/\D/g, "").slice(0, 14);
  return `${base}-next.${stamp}.g${sha.slice(0, 7)}`;
}

/** Semver precedence: <0 when a sorts below b, 0 when equal, >0 above. */
export function compareVersions(a, b) {
  const parse = (version) => {
    const match = ANY_VERSION.exec(version);
    if (!match) throw new Error(`${version} is not a version`);
    return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum && p !== q) return Number(p) < Number(q) ? -1 : 1;
    if (pNum !== qNum) return pNum ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The npm dist-tag for a stable release: `latest` unless npm's latest is
 * already newer, as for a fix released from release/1.x after 2.0.0 is out.
 * That one goes out as `latest-1`, so `npm install @aiand/cli` never moves back.
 */
export function stableDistTag(version, npmLatest) {
  const parts = SEMVER.exec(version);
  if (!parts) throw new Error(`a stable release is x.y.z, got ${version}`);
  if (!npmLatest || compareVersions(version, npmLatest) >= 0) return "latest";
  return `latest-${parts[1]}`;
}

/**
 * The branch a release is cut from: main, or release/<major>.x for fixes to an
 * older major. A maintenance branch only releases its own major.
 */
export function releaseBranchAllows(branch, version) {
  if (branch === "main") return true;
  const maintenance = MAINTENANCE.exec(branch);
  return Boolean(maintenance) && SEMVER.exec(version)?.[1] === maintenance[1];
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

/** Clean tree, on main or release/<major>.x, and exactly at its origin. Returns the branch. */
function assertAtOriginBranch() {
  if (git("status", "--porcelain")) fail("the working tree has uncommitted changes");
  const branch = git("branch", "--show-current");
  if (branch !== "main" && !MAINTENANCE.test(branch)) {
    fail("switch to main (or a release/<major>.x branch) first");
  }
  git("fetch", "--quiet", "origin", branch);
  if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${branch}`)) {
    fail(`${branch} is not at origin/${branch}; pull (or push) first`);
  }
  return branch;
}

function assertBranchReleases(branch, version) {
  if (!releaseBranchAllows(branch, version)) {
    fail(`${branch} releases only its own major version, not ${version}`);
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
  const base = assertAtOriginBranch();
  const version = nextVersion(readVersion(), target);
  assertBranchReleases(base, version);
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
    "--base",
    base,
    "--title",
    `release: v${version}`,
    "--body",
    `Bumps to ${version} and dates its CHANGELOG section. After merge and a green CI run on ${base}: \`node scripts/release.mjs tag\`.`,
  ]);
}

function tag() {
  const branch = assertAtOriginBranch();
  const version = readVersion();
  assertBranchReleases(branch, version);
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
  if (passed === "0") fail(`no successful CI run on ${branch} for ${head.slice(0, 7)} yet`);
  git("tag", name);
  run("git", ["push", "origin", name]);
  console.log(`Pushed ${name}; publish.yml takes it from here.`);
}

function notes(version) {
  const body = version && releaseNotes(readFileSync(CHANGELOG, "utf8"), version);
  if (!body) fail(`CHANGELOG.md has no [${version}] section`);
  console.log(body);
}

function printNextVersion() {
  const seconds = Number(git("log", "-1", "--format=%ct", "HEAD"));
  console.log(nextChannelVersion(readVersion(), seconds, git("rev-parse", "HEAD")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg, other] = process.argv.slice(2);
  try {
    if (command === "prepare") prepare(arg);
    else if (command === "tag") tag();
    else if (command === "notes") notes(arg);
    else if (command === "next-version") printNextVersion();
    else if (command === "dist-tag") console.log(stableDistTag(arg, other));
    else if (command === "is-newer") process.exitCode = compareVersions(arg, other) > 0 ? 0 : 1;
    else {
      fail(
        "usage: release.mjs <prepare <bump>|tag|notes <version>|next-version|dist-tag <version> [<npm latest>]|is-newer <a> <b>>",
      );
    }
  } catch (error) {
    fail(error.message);
  }
}
