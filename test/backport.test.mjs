// .github/scripts/backport.sh, which backport.yml runs: real git against a
// local bare "origin", and a stub `gh` that records what it was asked to do.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", ".github", "scripts", "backport.sh");

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "aiand-backport-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(
    gitconfig,
    "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const seed = join(dir, "seed");
  git(dir, "clone", "-q", origin, seed);
  const commit = (file, body, message, cwd = seed) => {
    writeFileSync(join(cwd, file), body);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  commit("a.txt", "base\n", "Start");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  git(seed, "push", "-q", "origin", "HEAD:refs/heads/release/1.x");
  return { dir, env, git, origin, seed, commit };
}

/** Merge a one-commit feature branch into main with a merge commit; returns its sha. */
function mergeFeature(s, file = "b.txt", body = "fix\n") {
  s.git(s.seed, "switch", "-q", "-c", "feature");
  s.commit(file, body, "Fix a thing");
  s.git(s.seed, "switch", "-q", "main");
  s.git(s.seed, "merge", "-q", "--no-ff", "-m", "Merge pull request #7", "feature");
  s.git(s.seed, "push", "-q", "origin", "main");
  return s.git(s.seed, "rev-parse", "HEAD");
}

function runBackport(
  s,
  {
    mergeSha,
    labels = "backport-1.x",
    action = "closed",
    added = "",
    commits = 1,
    lastMessage = "",
    openPr = "",
  },
) {
  const work = join(s.dir, `work-${Math.random().toString(16).slice(2)}`);
  s.git(s.dir, "clone", "-q", s.origin, work);
  const bin = join(s.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(s.dir, "gh.log");
  const comments = join(s.dir, "comments.log");
  rmSync(log, { force: true });
  rmSync(comments, { force: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      // One line per call: a comment body's own lines must not read as calls.
      `printf 'gh %s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "${log}"`,
      'case "$1 $2" in',
      '  "pr view") printf "%s\\n" "$STUB_LABELS" ;;',
      '  "api --paginate") printf "%s\\n" "$STUB_LAST_MESSAGE" ;;',
      '  "pr list") printf "%s\\n" "$STUB_OPEN_PR" ;;',
      '  "pr create") echo "https://github.example/o/r/pull/99" ;;',
      '  "pr comment")',
      "    while [ $# -gt 0 ]; do",
      `      if [ "$1" = "--body" ]; then printf '%s\\n----\\n' "$2" >> "${comments}"; fi`,
      "      shift",
      "    done ;;",
      "esac",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const run = spawnSync("bash", [SCRIPT], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...s.env,
      PATH: `${bin}:${s.env.PATH}`,
      GH_TOKEN: "stub",
      REPO: "o/r",
      PR: "7",
      PR_TITLE: "Fix a thing; $(touch title-ran)",
      MERGE_SHA: mergeSha,
      PR_COMMITS: String(commits),
      ACTION: action,
      ADDED_LABEL: added,
      RUN_URL: "https://github.example/o/r/actions/runs/1",
      STUB_LABELS: labels,
      STUB_LAST_MESSAGE: lastMessage,
      STUB_OPEN_PR: openPr,
    },
  });
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const remoteBranch = (name) => {
    try {
      return s.git(s.dir, "--git-dir", s.origin, "rev-parse", "--verify", `refs/heads/${name}`);
    } catch {
      return null;
    }
  };
  return {
    status: run.status,
    output: run.stdout + run.stderr,
    calls: read(log).trim().split("\n").filter(Boolean),
    comments: read(comments),
    remoteBranch,
    show: (ref, file) => s.git(s.dir, "--git-dir", s.origin, "show", `${ref}:${file}`),
    titleRan: existsSync(join(work, "title-ran")),
  };
}

describe("backport.sh", () => {
  test("a merge commit is picked onto release/1.x and a pull request is opened there", (t) => {
    const s = sandbox(t);
    const sha = mergeFeature(s);
    const r = runBackport(s, { mergeSha: sha });
    assert.equal(r.status, 0, r.output);
    assert.ok(r.remoteBranch("backport/1.x/pr-7"), "pushed the backport branch");
    assert.equal(r.show("backport/1.x/pr-7", "b.txt"), "fix");
    const message = s.git(
      s.dir,
      "--git-dir",
      s.origin,
      "log",
      "-1",
      "--format=%B",
      "backport/1.x/pr-7",
    );
    assert.match(message, new RegExp(`cherry picked from commit ${sha}`));
    const create = r.calls.find((c) => c.startsWith("gh pr create"));
    assert.ok(create, r.calls.join(" | "));
    assert.match(
      create,
      /--base release\/1\.x --head backport\/1\.x\/pr-7 --title \[1\.x\] Fix a thing/,
    );
    assert.match(r.comments, /Opened https:\/\/github\.example\/o\/r\/pull\/99/);
    assert.ok(!r.titleRan, "the title is data, never run");
  });

  test("a conflict comments with the files and the steps, pushes nothing, and fails", (t) => {
    const s = sandbox(t);
    s.git(s.seed, "switch", "-q", "release/1.x");
    s.commit("b.txt", "something else\n", "Diverge");
    s.git(s.seed, "push", "-q", "origin", "release/1.x");
    s.git(s.seed, "switch", "-q", "main");
    const sha = mergeFeature(s);
    const r = runBackport(s, { mergeSha: sha });
    assert.notEqual(r.status, 0);
    assert.equal(r.remoteBranch("backport/1.x/pr-7"), null);
    assert.match(r.comments, /Could not cherry-pick this onto `release\/1\.x`: it conflicts in/);
    assert.match(r.comments, /- `b\.txt`/);
    assert.match(r.comments, new RegExp(`git cherry-pick -x -m 1 ${sha}`));
    assert.ok(!r.calls.some((c) => c.startsWith("gh pr create")));
  });

  test("a label for a release branch that does not exist comments and fails", (t) => {
    const s = sandbox(t);
    const sha = mergeFeature(s);
    const r = runBackport(s, { mergeSha: sha, labels: "backport-2.x" });
    assert.notEqual(r.status, 0);
    assert.match(r.comments, /`release\/2\.x`, and that branch does not exist/);
    assert.ok(!r.calls.some((c) => c.startsWith("gh pr create")));
  });

  test("a change release/1.x already has is reported, not opened as an empty pull request", (t) => {
    const s = sandbox(t);
    s.git(s.seed, "switch", "-q", "release/1.x");
    s.commit("b.txt", "fix\n", "Same fix, already here");
    s.git(s.seed, "push", "-q", "origin", "release/1.x");
    s.git(s.seed, "switch", "-q", "main");
    const sha = mergeFeature(s);
    const r = runBackport(s, { mergeSha: sha });
    assert.equal(r.status, 0, r.output);
    assert.match(r.comments, /Nothing to backport to `release\/1\.x`/);
    assert.equal(r.remoteBranch("backport/1.x/pr-7"), null);
  });

  test("a label added after the merge handles that label alone", (t) => {
    const s = sandbox(t);
    const sha = mergeFeature(s);
    const other = runBackport(s, { mergeSha: sha, action: "labeled", added: "bug", labels: "" });
    assert.equal(other.status, 0, other.output);
    assert.deepEqual(other.calls, []);
    const r = runBackport(s, {
      mergeSha: sha,
      action: "labeled",
      added: "backport-1.x",
      labels: "",
    });
    assert.equal(r.status, 0, r.output);
    assert.ok(!r.calls.some((c) => c.startsWith("gh pr view")), "the event names the label");
    assert.ok(r.remoteBranch("backport/1.x/pr-7"));
  });

  test("a squash merge of several commits picks the one squashed commit", (t) => {
    const s = sandbox(t);
    s.commit("c.txt", "one\n", "Earlier work on main");
    const squash = s.commit("b.txt", "squashed\n", "Fix a thing (#7)");
    s.git(s.seed, "push", "-q", "origin", "main");
    const r = runBackport(s, { mergeSha: squash, commits: 3, lastMessage: "wip" });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.show("backport/1.x/pr-7", "b.txt"), "squashed");
    assert.throws(() => r.show("backport/1.x/pr-7", "c.txt"), "the commit before it is not picked");
  });

  test("a rebase merge picks each of the pull request's commits", (t) => {
    const s = sandbox(t);
    s.commit("c.txt", "unrelated\n", "Earlier work on main");
    s.commit("b.txt", "first\n", "First step");
    const last = s.commit("d.txt", "second\n", "Second step");
    s.git(s.seed, "push", "-q", "origin", "main");
    const r = runBackport(s, { mergeSha: last, commits: 2, lastMessage: "Second step" });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.show("backport/1.x/pr-7", "b.txt"), "first");
    assert.equal(r.show("backport/1.x/pr-7", "d.txt"), "second");
    assert.throws(() => r.show("backport/1.x/pr-7", "c.txt"));
  });

  test("a branch that already has an open pull request is left alone", (t) => {
    const s = sandbox(t);
    const sha = mergeFeature(s);
    s.git(s.seed, "push", "-q", "origin", "origin/release/1.x:refs/heads/backport/1.x/pr-7");
    const r = runBackport(s, { mergeSha: sha, openPr: "https://github.example/o/r/pull/50" });
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /already has an open pull request/);
    assert.ok(!r.calls.some((c) => /^gh pr (create|comment)/.test(c)), r.calls.join(" | "));
  });

  test("a leftover branch with no pull request comments instead of overwriting it", (t) => {
    const s = sandbox(t);
    const sha = mergeFeature(s);
    s.git(s.seed, "push", "-q", "origin", "origin/release/1.x:refs/heads/backport/1.x/pr-7");
    const before = s.git(s.dir, "--git-dir", s.origin, "rev-parse", "backport/1.x/pr-7");
    const r = runBackport(s, { mergeSha: sha });
    assert.notEqual(r.status, 0);
    assert.match(r.comments, /already exists with no open pull request/);
    assert.equal(r.remoteBranch("backport/1.x/pr-7"), before);
  });
});
