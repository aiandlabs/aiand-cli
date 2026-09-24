import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

const { nextVersion, cutRelease, releaseNotes } = await import("../scripts/release.mjs");

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- A fix.

## [0.2.0] - 2026-09-24

- Older.
`;

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

describe("cutRelease", () => {
  test("dates the Unreleased entries and leaves an empty Unreleased above", () => {
    const cut = cutRelease(CHANGELOG, "0.2.1", "2026-10-01");
    assert.match(
      cut,
      /## \[Unreleased\]\n\n## \[0\.2\.1\] - 2026-10-01\n\n### Fixed\n\n- A fix\.\n\n## \[0\.2\.0\]/,
    );
    assert.equal(releaseNotes(cut, "0.2.1"), "### Fixed\n\n- A fix.");
    assert.equal(releaseNotes(cut, "Unreleased"), "");
  });
  test("refuses an empty Unreleased section", () => {
    const cut = cutRelease(CHANGELOG, "0.2.1", "2026-10-01");
    assert.throws(() => cutRelease(cut, "0.2.2", "2026-10-02"), /has no entries to release/);
  });
  test("refuses a version that already has a section", () => {
    assert.throws(
      () => cutRelease(CHANGELOG, "0.2.0", "2026-10-01"),
      /already has a \[0\.2\.0\] section/,
    );
  });
  test("refuses a changelog without Unreleased", () => {
    assert.throws(
      () => cutRelease("# Changelog\n", "0.2.1", "2026-10-01"),
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
