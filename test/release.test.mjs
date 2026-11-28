import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

const {
  nextVersion,
  cutRelease,
  readChangeNotes,
  releaseNotes,
  nextChannelVersion,
  compareVersions,
  stableDistTag,
  releaseBranchAllows,
} = await import("../scripts/release.mjs");

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- A fix.

## [0.2.0] - 2026-09-24

- Older.
`;

const ROOT = join(import.meta.dirname, "..");

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "aiand-release-notes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

describe("nextVersion", () => {
  test("bumps each part and resets the lower ones", () => {
    assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  });
  test("takes an explicit x.y.z", () => {
    assert.equal(nextVersion("1.2.3", "1.4.0"), "1.4.0");
  });
  test("rejects anything else", () => {
    assert.throws(() => nextVersion("1.2.3", "next"), /expected major\|minor\|patch or x\.y\.z/);
    assert.throws(() => nextVersion("1.2.3-rc.1", "patch"), /is not x\.y\.z/);
  });
});

describe("nextChannelVersion", () => {
  // 2026-11-28T09:05:03Z
  const AT = Date.UTC(2026, 10, 28, 9, 5, 3) / 1000;
  const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

  test("is the next patch, the commit's UTC time, and the short sha", () => {
    assert.equal(nextChannelVersion("0.8.0", AT, SHA), "0.8.1-next.20261128090503.g1a2b3c4");
  });
  test("sorts above the current release and below every next one", () => {
    const next = nextChannelVersion("0.8.0", AT, SHA);
    assert.ok(compareVersions(next, "0.8.0") > 0);
    assert.ok(compareVersions(next, "0.8.1") < 0);
    assert.ok(compareVersions(next, "0.9.0") < 0);
  });
  test("a later commit sorts above an earlier one", () => {
    const earlier = nextChannelVersion("0.8.0", AT, SHA);
    const later = nextChannelVersion("0.8.0", AT + 1, "f".repeat(40));
    assert.ok(compareVersions(later, earlier) > 0);
  });
  test("is the same for the same commit, so a re-run asks for the same version", () => {
    assert.equal(nextChannelVersion("0.8.0", AT, SHA), nextChannelVersion("0.8.0", AT, SHA));
  });
  test("is valid semver when the short sha is all digits with a leading zero", () => {
    const version = nextChannelVersion("0.8.0", AT, "0123456789".repeat(4));
    assert.equal(version, "0.8.1-next.20261128090503.g0123456");
    // No numeric prerelease identifier may start with 0.
    for (const id of version.split("-")[1].split(".")) assert.doesNotMatch(id, /^0\d+$/);
  });
  test("rejects a bad commit time or sha, and a version that is not x.y.z", () => {
    assert.throws(() => nextChannelVersion("0.8.0", 0, SHA), /commit time/);
    assert.throws(() => nextChannelVersion("0.8.0", AT, "not-a-sha"), /git sha/);
    assert.throws(() => nextChannelVersion("0.8.1-next.1.gabc1234", AT, SHA), /is not x\.y\.z/);
  });
  test("the CLI prints a next version for this checkout", () => {
    const run = spawnSync(process.execPath, ["scripts/release.mjs", "next-version"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout.trim(), /^\d+\.\d+\.\d+-next\.\d{14}\.g[0-9a-f]{7}$/);
  });
});

describe("compareVersions", () => {
  test("follows semver precedence", () => {
    const ordered = [
      "0.8.0",
      "0.8.1-next.20261128090503.g1a2b3c4",
      "0.8.1-next.20261128090504.g0000000",
      "0.8.1",
      "0.10.0",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      assert.ok(
        compareVersions(ordered[i], ordered[i + 1]) < 0,
        `${ordered[i]} < ${ordered[i + 1]}`,
      );
      assert.ok(
        compareVersions(ordered[i + 1], ordered[i]) > 0,
        `${ordered[i + 1]} > ${ordered[i]}`,
      );
    }
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });
  test("the CLI's is-newer exits 0 only when the first sorts above the second", () => {
    const isNewer = (a, b) =>
      spawnSync(process.execPath, ["scripts/release.mjs", "is-newer", a, b], { cwd: ROOT }).status;
    assert.equal(isNewer("0.8.1-next.2.gabcdef0", "0.8.1-next.1.gabcdef0"), 0);
    assert.equal(isNewer("0.8.1-next.1.gabcdef0", "0.8.1-next.1.gabcdef0"), 1);
    assert.equal(isNewer("0.8.0", "0.8.1-next.1.gabcdef0"), 1);
  });
});

describe("stableDistTag", () => {
  test("is latest for a release at or above npm's latest, or with none yet", () => {
    assert.equal(stableDistTag("0.8.1", "0.8.0"), "latest");
    assert.equal(stableDistTag("0.8.1", "0.8.1"), "latest");
    assert.equal(stableDistTag("0.8.1", ""), "latest");
    assert.equal(stableDistTag("0.8.1", undefined), "latest");
  });
  test("is latest-<major> for a fix to an older major, so latest never moves back", () => {
    assert.equal(stableDistTag("1.4.2", "2.0.0"), "latest-1");
  });
  test("refuses a version that is not x.y.z", () => {
    assert.throws(() => stableDistTag("0.8.1-next.1.gabcdef0", "0.8.0"), /x\.y\.z/);
  });
});

describe("releaseBranchAllows", () => {
  test("main releases any version", () => {
    assert.ok(releaseBranchAllows("main", "0.8.1"));
    assert.ok(releaseBranchAllows("main", "2.0.0"));
  });
  test("release/<major>.x releases only its own major", () => {
    assert.ok(releaseBranchAllows("release/1.x", "1.0.0"));
    assert.ok(releaseBranchAllows("release/1.x", "1.4.2"));
    assert.ok(!releaseBranchAllows("release/1.x", "2.0.0"));
    assert.ok(!releaseBranchAllows("release/1.x", "0.8.1"));
  });
  test("no other branch releases", () => {
    assert.ok(!releaseBranchAllows("release/v1.0.1", "1.0.1"));
    assert.ok(!releaseBranchAllows("feature/x", "1.0.1"));
  });
});

describe("readChangeNotes", () => {
  test("groups entries by category and keeps filename order within categories", (t) => {
    const directory = temporaryDirectory(t);
    writeFileSync(
      join(directory, "20-second.md"),
      `### Fixed

- Second fix.

### Added

- Second addition.

### Removed

- Second removal.

### Changed

- Second change.
`,
    );
    writeFileSync(
      join(directory, "10-first.md"),
      `### Removed

- First removal.

### Changed

- First change.

### Added

- First addition.

### Fixed

- First fix.
`,
    );

    assert.deepEqual(readChangeNotes(directory), {
      files: [join(directory, "10-first.md"), join(directory, "20-second.md")],
      body: `### Added

- First addition.
- Second addition.

### Changed

- First change.
- Second change.

### Fixed

- First fix.
- Second fix.

### Removed

- First removal.
- Second removal.`,
    });
  });

  test("returns an empty collection when there are no Markdown notes", (t) => {
    const directory = temporaryDirectory(t);
    writeFileSync(join(directory, "notes.txt"), "### Added\n\n- Not Markdown.\n");

    assert.deepEqual(readChangeNotes(directory), { files: [], body: "" });
    assert.deepEqual(readChangeNotes(join(directory, "missing")), { files: [], body: "" });
  });

  test("rejects unknown headings and notes without entries", (t) => {
    const directory = temporaryDirectory(t);
    const note = join(directory, "invalid.md");
    writeFileSync(note, "### Deprecated\n\n- An entry.\n");
    assert.throws(() => readChangeNotes(directory), /unknown heading/i);

    writeFileSync(note, "### Added\n\nNo release-note entries here.\n");
    assert.throws(() => readChangeNotes(directory), /no release-note entries/i);
  });

  test("reports the exact Markdown files to consume", (t) => {
    const directory = temporaryDirectory(t);
    writeFileSync(join(directory, "b-second.md"), "### Fixed\n\n- Second.\n");
    writeFileSync(join(directory, "a-first.md"), "### Added\n\n- First.\n");
    writeFileSync(join(directory, "ignored.txt"), "### Added\n\n- Ignored.\n");
    mkdirSync(join(directory, "directory.md"));

    const notes = readChangeNotes(directory);
    assert.deepEqual(notes.files, [join(directory, "a-first.md"), join(directory, "b-second.md")]);
    assert.equal(notes.body, "### Added\n\n- First.\n\n### Fixed\n\n- Second.");
  });
});

describe("cutRelease", () => {
  test("dates the Unreleased entries and leaves an empty Unreleased above", () => {
    const cut = cutRelease(CHANGELOG, "", "0.2.1", "2026-10-01");
    assert.match(
      cut,
      /## \[Unreleased\]\n\n## \[0\.2\.1\] - 2026-10-01\n\n### Fixed\n\n- A fix\.\n\n## \[0\.2\.0\]/,
    );
    assert.equal(releaseNotes(cut, "0.2.1"), "### Fixed\n\n- A fix.");
    assert.equal(releaseNotes(cut, "Unreleased"), "");
  });
  test("renders pending notes when legacy Unreleased is empty", () => {
    const changelog = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-09-24

- Older.
`;
    const pending = "### Added\n\n- A pending addition.";
    const cut = cutRelease(changelog, pending, "0.2.1", "2026-10-01");

    assert.equal(releaseNotes(cut, "Unreleased"), "");
    assert.equal(releaseNotes(cut, "0.2.1"), pending);
  });
  test("combines legacy Unreleased entries with pending notes without changing released sections", () => {
    const cut = cutRelease(
      CHANGELOG,
      "\n### Added\n\n- A pending addition.\n",
      "0.2.1",
      "2026-10-01",
    );

    assert.equal(
      releaseNotes(cut, "0.2.1"),
      "### Fixed\n\n- A fix.\n\n### Added\n\n- A pending addition.",
    );
    const released = CHANGELOG.slice(CHANGELOG.indexOf("## [0.2.0]"));
    assert.ok(cut.endsWith(released));
  });
  test("refuses when neither legacy nor pending notes have entries", () => {
    const cut = cutRelease(CHANGELOG, "", "0.2.1", "2026-10-01");
    assert.throws(() => cutRelease(cut, "", "0.2.2", "2026-10-02"), /has no entries to release/);
  });
  test("refuses a version that already has a section", () => {
    assert.throws(
      () => cutRelease(CHANGELOG, "", "0.2.0", "2026-10-01"),
      /already has a \[0\.2\.0\] section/,
    );
  });
  test("refuses a changelog without Unreleased", () => {
    assert.throws(
      () => cutRelease("# Changelog\n", "", "0.2.1", "2026-10-01"),
      /no ## \[Unreleased\] section/,
    );
  });
});

describe("releaseNotes", () => {
  test("returns null for a missing version", () => {
    assert.equal(releaseNotes(CHANGELOG, "9.9.9"), null);
  });
  test("the real CHANGELOG has notes for the package.json version", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.ok(releaseNotes(changelog, version), `CHANGELOG.md needs a [${version}] section`);
    assert.notEqual(
      releaseNotes(changelog, "Unreleased"),
      null,
      "CHANGELOG.md needs an [Unreleased] section",
    );
  });
});
