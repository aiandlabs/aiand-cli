import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

const { nextVersion, cutRelease, prebuiltReleaseManifest, readChangeNotes, releaseNotes } =
  await import("../scripts/release.mjs");

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed

- A fix.

## [0.2.0] - 2026-09-24

- Older.
`;

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "aiand-release-notes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stagePrebuiltInputs(directory, version) {
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
  for (const [index, name] of inputs.entries()) {
    writeFileSync(join(directory, name), `prebuilt asset ${index}: ${name}\n`);
  }
  return inputs;
}

describe("prebuiltReleaseManifest", () => {
  test("returns the complete asset list and deterministic lowercase SHA256SUMS", (t) => {
    const directory = temporaryDirectory(t);
    const inputs = stagePrebuiltInputs(directory, "1.2.3");

    const { assets, sha256sums } = prebuiltReleaseManifest(directory, "1.2.3");

    assert.deepEqual(assets, [...inputs, "SHA256SUMS"]);
    const expectedLines = inputs.map((name) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex");
      return `${digest}  ${name}`;
    });
    assert.deepEqual(sha256sums.split("\n"), [...expectedLines, ""]);
    assert.equal(sha256sums, `${expectedLines.join("\n")}\n`);
  });

  test("rejects missing, unexpected, and wrong-version release inputs", (t) => {
    const invalidVersion = temporaryDirectory(t);
    stagePrebuiltInputs(invalidVersion, "1.2.3");
    assert.throws(() => prebuiltReleaseManifest(invalidVersion, "1.2.3-rc.1"), /x\.y\.z/);
    assert.throws(() => prebuiltReleaseManifest(invalidVersion, "1.2.3\n"), /x\.y\.z/);

    const missing = temporaryDirectory(t);
    stagePrebuiltInputs(missing, "1.2.3");
    rmSync(join(missing, "install.sh"));
    assert.throws(() => prebuiltReleaseManifest(missing, "1.2.3"), /install\.sh/);

    const unexpected = temporaryDirectory(t);
    stagePrebuiltInputs(unexpected, "1.2.3");
    writeFileSync(join(unexpected, "unexpected.txt"), "not a release asset\n");
    assert.throws(
      () => prebuiltReleaseManifest(unexpected, "1.2.3"),
      /unexpected release asset: unexpected\.txt/,
    );

    const wrongVersion = temporaryDirectory(t);
    stagePrebuiltInputs(wrongVersion, "1.2.3");
    writeFileSync(join(wrongVersion, "aiand-cli-9.9.9.tgz"), "ambiguous tarball\n");
    assert.throws(
      () => prebuiltReleaseManifest(wrongVersion, "1.2.3"),
      /unexpected release asset: aiand-cli-9\.9\.9\.tgz/,
    );
  });

  test("rejects a non-file asset and ignores only SHA256SUMS on retry", (t) => {
    const directoryInput = temporaryDirectory(t);
    stagePrebuiltInputs(directoryInput, "1.2.3");
    rmSync(join(directoryInput, "aiand-linux-x64"));
    mkdirSync(join(directoryInput, "aiand-linux-x64"));
    assert.throws(
      () => prebuiltReleaseManifest(directoryInput, "1.2.3"),
      /aiand-linux-x64.*not a regular file/,
    );

    const symlinkInput = temporaryDirectory(t);
    stagePrebuiltInputs(symlinkInput, "1.2.3");
    rmSync(join(symlinkInput, "install.ps1"));
    symlinkSync("install.sh", join(symlinkInput, "install.ps1"));
    assert.throws(
      () => prebuiltReleaseManifest(symlinkInput, "1.2.3"),
      /install\.ps1.*not a regular file/,
    );

    const retry = temporaryDirectory(t);
    stagePrebuiltInputs(retry, "1.2.3");
    const expected = prebuiltReleaseManifest(retry, "1.2.3");
    writeFileSync(join(retry, "SHA256SUMS"), "stale contents are ignored\n");
    assert.deepEqual(prebuiltReleaseManifest(retry, "1.2.3"), expected);
    assert.equal(readFileSync(join(retry, "SHA256SUMS"), "utf8"), "stale contents are ignored\n");
  });

  test("the prebuilt-sums command prints the manifest and reports invalid staging", (t) => {
    const directory = temporaryDirectory(t);
    const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    stagePrebuiltInputs(directory, version);
    const { sha256sums } = prebuiltReleaseManifest(directory, version);
    const run = () =>
      spawnSync(process.execPath, [script, "prebuilt-sums", directory], { encoding: "utf8" });

    const success = run();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, sha256sums);
    assert.equal(success.stderr, "");
    assert.equal(existsSync(join(directory, "SHA256SUMS")), false);

    writeFileSync(join(directory, "unexpected.txt"), "invalid staging\n");
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /^release: unexpected release asset: unexpected\.txt/);
    assert.equal(existsSync(join(directory, "SHA256SUMS")), false);
  });
});

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
