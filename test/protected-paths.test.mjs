// .github/scripts/protected_paths.py against a stand-in `gh` on PATH, so the
// check's verdicts are pinned without GitHub: in particular, a PR whose file
// list GitHub cut short fails instead of reporting that nothing protected
// changed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "..", ".github", "scripts", "protected_paths.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const skip =
  process.platform === "win32"
    ? "the stand-in gh is a shebang script"
    : PYTHON
      ? false
      : "no python3";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const CODEOWNERS = "/install.sh @owner-one\n/.github/ @owner-one\n";

// The stand-in answers `gh api --paginate --slurp <path>` from a JSON map of
// path (query string dropped) to the pages to print. A value of
// { sequence: [...] } answers each call with the next entry.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[process.argv.length - 1].split("?")[0];
const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, "utf8"));
let answer = map[path];
if (answer === undefined) {
  process.stderr.write("no fixture for " + path + "\\n");
  process.exit(1);
}
if (answer && answer.sequence) {
  const counter = process.env.FAKE_GH_MAP + "." + Buffer.from(path).toString("hex");
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  answer = answer.sequence[Math.min(n, answer.sequence.length - 1)];
}
process.stdout.write(JSON.stringify(answer));
`;

const pr = (changedFiles, head = HEAD) => ({
  base: { sha: "c".repeat(40) },
  head: { sha: head },
  user: { login: "someone", type: "User" },
  ...(changedFiles === undefined ? {} : { changed_files: changedFiles }),
});

const fileRows = (names) => names.map((filename) => ({ filename }));

// Split rows into pages of 100, the way `--slurp` returns them.
const pages = (rows) => {
  const out = [];
  for (let i = 0; i < rows.length; i += 100) out.push(rows.slice(i, i + 100));
  return out.length ? out : [[]];
};

function runCheck({ prAnswer, files, reviews = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "aiand-protected-paths-"));
  try {
    const bin = join(dir, "bin");
    const gh = join(dir, "bin", "gh");
    mkdirSync(bin);
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    const map = join(dir, "map.json");
    writeFileSync(
      map,
      JSON.stringify({
        "repos/o/r/pulls/7": prAnswer,
        "repos/o/r/contents/.github/CODEOWNERS": [
          { content: Buffer.from(CODEOWNERS).toString("base64") },
        ],
        "repos/o/r/pulls/7/files": pages(files),
        "repos/o/r/pulls/7/reviews": [reviews],
      }),
    );
    const run = spawnSync("python3", ["-I", SCRIPT], {
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        REPO: "o/r",
        PR: "7",
        FAKE_GH_MAP: map,
      },
      encoding: "utf8",
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unprotected PR whose full list arrived passes", { skip }, () => {
  const names = Array.from({ length: 250 }, (_, i) => `src/agents/f${i}.ts`);
  const run = runCheck({ prAnswer: [pr(250)], files: fileRows(names) });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /No protected path changed\./);
});

test("a protected path without an owner's approval fails", { skip }, () => {
  const run = runCheck({ prAnswer: [pr(2)], files: fileRows(["README.md", "install.sh"]) });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /::error::install\.sh needs approval/);
});

test("a protected path approved by an owner at the head passes", { skip }, () => {
  const run = runCheck({
    prAnswer: [pr(1)],
    files: fileRows(["install.sh"]),
    reviews: [{ user: { login: "owner-one" }, state: "APPROVED", commit_id: HEAD }],
  });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /install\.sh: approved by owner-one/);
});

// GitHub stops the list at 3000 files; the protected path is past the cut.
test("a list cut short of changed_files fails closed", { skip }, () => {
  const names = Array.from({ length: 3000 }, (_, i) => `docs/f${i}.md`);
  const run = runCheck({ prAnswer: [pr(3001)], files: fileRows(names) });
  assert.equal(run.status, 1, run.out);
  assert.match(
    run.out,
    /::error::Could not list every changed file: GitHub listed 3000 of the 3001/,
  );
  assert.doesNotMatch(run.out, /No protected path changed/);
});

test("a PR without changed_files fails closed", { skip }, () => {
  const run = runCheck({ prAnswer: [pr(undefined)], files: fileRows(["README.md"]) });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /::error::Could not list every changed file: GitHub did not report/);
});

test("a push while the files were listed fails closed", { skip }, () => {
  const run = runCheck({
    prAnswer: { sequence: [[pr(1)], [pr(1, OTHER_HEAD)]] },
    files: fileRows(["README.md"]),
  });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /::error::Could not list every changed file: the PR changed/);
});

test("a renamed file counts once and both its names are judged", { skip }, () => {
  const run = runCheck({
    prAnswer: [pr(1)],
    files: [{ filename: "docs/old-installer.sh", previous_filename: "install.sh" }],
  });
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /::error::install\.sh needs approval/);
});
