// publish.yml's stage step: a first run publishes the build job's tarball, and
// a resumed run the bytes the first run uploaded, not whatever a fresh build
// produces today. The step's own shell runs here against a stub `gh` (a
// directory standing in for the draft release) and a stand-in build artifact,
// so nothing reaches a network. The release step gets the same treatment: it
// must not publish a draft that holds anything it did not attach. The artifact
// check and the job layout (build apart from publish, `next` apart from
// `latest`) are tested at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

const root = join(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");

const STEP = /- name: Stage the release tarball and SHA256SUMS\n {8}run: \|\n([\s\S]*?)\n {8}env:/
  .exec(workflow)?.[1]
  .replace(/^ {10}/gm, "");

const TGZ = "aiand-cli-1.2.3.tgz";
const SHA = "1111111111111111111111111111111111111111";
const BUILT = "built-by-the-build-job";

/**
 * Run the stage step. `draft` is the release a previous run left:
 * { asset, packedFrom } or null. `built` is false for an artifact without the tarball.
 */
function packStep({ draft = null, resume = false, built = true } = {}) {
  assert.ok(STEP, "found the stage step in publish.yml");
  const dir = mkdtempSync(join(tmpdir(), "aiand-publish-"));
  try {
    const bin = join(dir, "bin");
    const release = join(dir, "release-state");
    const out = join(dir, "tmp", "release");
    const log = join(dir, "calls.log");
    mkdirSync(bin);
    mkdirSync(release);
    mkdirSync(join(dir, "tmp", "build"), { recursive: true });
    if (built) writeFileSync(join(dir, "tmp", "build", TGZ), BUILT);
    if (draft) {
      writeFileSync(join(release, "exists"), "");
      writeFileSync(
        join(release, "body"),
        draft.packedFrom ? `packed-from: ${draft.packedFrom}` : "",
      );
      if (draft.asset !== undefined) writeFileSync(join(release, TGZ), draft.asset);
    }
    const script = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "gh",
      [
        `echo "gh $*" >> "${log}"`,
        `R="${release}"`,
        'case "$1 $2" in',
        '  "release view")',
        '    [ -e "$R/exists" ] || exit 1',
        '    case "$*" in',
        `      *assets*) [ -e "$R/${TGZ}" ] && echo true || echo false ;;`,
        '      *body*) cat "$R/body" ;;',
        "    esac ;;",
        '  "release download") cp "$R/$5" "$7/$5" ;;',
        `  "release upload") cp "$4" "$R/"; touch "$R/exists" ;;`,
        '  "release edit") printf "%s" "$5" > "$R/body" ;;',
        `  "release delete-asset") rm -f "$R/$4" ;;`,
        '  "release create")',
        '    touch "$R/exists"',
        "    while [ $# -gt 0 ]; do",
        '      case "$1" in --notes) printf "%s" "$2" > "$R/body"; shift ;; *.tgz) cp "$1" "$R/" ;; esac',
        "      shift",
        "    done ;;",
        "esac",
      ].join("\n"),
    );
    script("npm", `echo "npm $*" >> "${log}"; exit 1`);
    script("sha256sum", 'shasum -a 256 "$@"');
    const run = spawnSync("bash", ["-c", STEP], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: SHA,
        RUNNER_TEMP: join(dir, "tmp"),
        ...(resume ? { RESUME: "1" } : {}),
      },
    });
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
    return {
      status: run.status,
      stderr: run.stderr,
      stdout: run.stdout,
      calls: (read(log) ?? "").trim().split("\n").filter(Boolean),
      tarball: read(join(out, TGZ)),
      draftAsset: read(join(release, TGZ)),
      draftBody: read(join(release, "body")),
      sums: read(join(out, "SHA256SUMS")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a first run takes the build job's tarball, and uploads it to a draft release before anything publishes", () => {
  const r = packStep();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, BUILT);
  assert.equal(r.draftAsset, BUILT);
  assert.equal(r.draftBody, `packed-from: ${SHA}`);
  assert.ok(r.calls.some((c) => c.startsWith("gh release create v1.2.3 --verify-tag --draft")));
  assert.match(r.sums ?? "", new RegExp(`${TGZ}\\n`));
});

test("a resumed run publishes the bytes the first run uploaded, not this run's build", () => {
  const r = packStep({ draft: { asset: "packed-by-first-run", packedFrom: SHA }, resume: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, "packed-by-first-run");
});

test("a first run takes the build and accepts a leftover asset only when it is the same bytes", () => {
  const r = packStep({ draft: { asset: BUILT, packedFrom: SHA } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, BUILT);
  assert.ok(!r.calls.some((c) => c.startsWith("gh release upload")));
  assert.ok(!r.calls.some((c) => c.startsWith("gh release delete-asset")));
});

for (const [label, packedFrom] of [
  ["whose release notes name this commit", SHA],
  ["packed from another commit", "2".repeat(40)],
  ["with no packed-from line", ""],
]) {
  test(`a first run stops on a leftover asset that differs from its own pack, ${label}`, () => {
    const r = packStep({ draft: { asset: "bytes-someone-else-attached", packedFrom } });
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr + r.stdout,
      /already holds aiand-cli-1\.2\.3\.tgz .* differs from what the build job packed/,
    );
    assert.equal(r.draftAsset, "bytes-someone-else-attached", "the asset is left alone");
    assert.ok(
      !r.calls.some((c) => /^gh release (upload|delete-asset|edit)/.test(c)),
      r.calls.join(" | "),
    );
    assert.equal(r.sums, null, "no SHA256SUMS is written for bytes that were not checked");
  });
}

test("a tag moved after the publish stops the run instead of repacking", () => {
  const r = packStep({
    draft: { asset: "packed-from-old-commit", packedFrom: "2".repeat(40) },
    resume: true,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /tag moved after the publish/);
  assert.equal(r.tarball, null);
});

test("a resume with nothing to reuse takes this run's build and uploads nothing", () => {
  const r = packStep({ resume: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.tarball, BUILT);
  assert.ok(!r.calls.some((c) => /^gh release (create|upload|edit)/.test(c)), r.calls.join(" | "));
});

const RELEASE_STEP = /- name: Create the GitHub release\n {8}run: \|\n([\s\S]*?)\n {8}env:/
  .exec(workflow)?.[1]
  .replace(/^ {10}/gm, "");

const OWN_ASSETS = [TGZ, "SHA256SUMS", "install.sh", "install.ps1"];

/**
 * Run the release step against a stub `gh`. `draft` is the assets already on a
 * draft release (the pack step uploaded the tarball), or null for no release.
 */
function releaseStep({ draft }) {
  assert.ok(RELEASE_STEP, "found the release step in publish.yml");
  const dir = mkdtempSync(join(tmpdir(), "aiand-release-"));
  try {
    const bin = join(dir, "bin");
    const assets = join(dir, "assets");
    const out = join(dir, "tmp", "release");
    const log = join(dir, "calls.log");
    mkdirSync(bin);
    mkdirSync(assets);
    mkdirSync(out, { recursive: true });
    for (const name of ["SHA256SUMS", "install.sh", "install.ps1"])
      writeFileSync(join(out, name), `fresh ${name}`);
    if (draft) {
      writeFileSync(join(dir, "exists"), "");
      for (const name of draft) writeFileSync(join(assets, name), `attached ${name}`);
    }
    const script = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script(
      "gh",
      [
        `echo "gh $*" >> "${log}"`,
        `A="${assets}"`,
        'case "$1 $2" in',
        '  "release view")',
        `    [ -e "${dir}/exists" ] || exit 1`,
        '    case "$*" in *assets*) ls "$A" ;; esac ;;',
        '  "release upload") shift 3; for f in "$@"; do case "$f" in --*) ;; *) cp "$f" "$A/" ;; esac; done ;;',
        `  "release create") touch "${dir}/exists"; for f in "$@"; do case "$f" in */*) cp "$f" "$A/" ;; esac; done ;;`,
        `  "release edit") touch "${dir}/published" ;;`,
        "esac",
      ].join("\n"),
    );
    script("node", "echo release notes");
    const run = spawnSync("bash", ["-c", RELEASE_STEP], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_REF_NAME: "v1.2.3",
        RUNNER_TEMP: join(dir, "tmp"),
      },
    });
    return {
      status: run.status,
      output: run.stderr + run.stdout,
      calls: (existsSync(log) ? readFileSync(log, "utf8") : "").trim().split("\n").filter(Boolean),
      published: existsSync(join(dir, "published")),
      assets: existsSync(assets) ? readdirSync(assets).sort() : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a draft that holds exactly the release's assets is published", () => {
  const r = releaseStep({ draft: [TGZ] });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.assets, [...OWN_ASSETS].sort());
  assert.ok(r.published);
  assert.ok(r.calls.some((c) => /^gh release edit v1\.2\.3 .*--draft=false --latest/.test(c)));
});

test("a release without the tarball on it is not published", () => {
  const r = releaseStep({ draft: null });
  // The pack step uploads the tarball before this one; with no release at all
  // it is missing, and the run must not publish a release without it.
  assert.notEqual(r.status, 0);
  assert.match(r.output, /missing/);
  assert.ok(!r.published);
});

test("a draft with an asset someone else attached is not published, and the message says what to remove", () => {
  const r = releaseStep({ draft: [TGZ, "backdoor.sh"] });
  assert.notEqual(r.status, 0);
  assert.ok(!r.published, r.calls.join(" | "));
  assert.ok(!r.calls.some((c) => c.startsWith("gh release edit")), r.calls.join(" | "));
  assert.match(r.output, /backdoor\.sh/);
  assert.match(r.output, /gh release delete-asset v1\.2\.3 /);
  assert.match(r.output, /Nothing was published/);
  assert.ok(r.assets.includes("backdoor.sh"), "the asset is left for a person to look at");
});

test("every unexpected asset is named, and a name with workflow-command characters is quoted", () => {
  const r = releaseStep({ draft: [TGZ, "a.zip", "::set-output name=x::y.txt"] });
  assert.notEqual(r.status, 0);
  assert.ok(!r.published);
  assert.match(r.output, /a\.zip/);
  assert.doesNotMatch(r.output, /^::set-output/m);
  assert.match(r.output, /set-output\\ name=x::y\.txt/);
});

test("the release is published only after the asset set is checked", () => {
  const publish = RELEASE_STEP.indexOf("--draft=false");
  assert.ok(publish > 0);
  const check = RELEASE_STEP.indexOf("delete-asset");
  assert.ok(check >= 0 && check < publish, "the asset check comes before the draft is published");
});

test("the publishing job runs in a protected environment", () => {
  const job = workflow.slice(workflow.indexOf("\n  publish:\n"));
  assert.match(job, /\n {4}environment: release\n/);
  assert.ok(job.indexOf("environment: release") < job.indexOf("steps:"));
});

test("publish.yml pins an exact Node, and the tarball is uploaded before the publish step", () => {
  assert.match(workflow, /node-version: 22\.\d+\.\d+\n/);
  assert.ok(
    workflow.indexOf("Stage the release tarball") < workflow.indexOf("- name: Publish to npm\n"),
  );
  const step = workflow.slice(
    workflow.indexOf("Stage the release tarball"),
    workflow.indexOf("- name: Publish to npm\n"),
  );
  assert.ok(step.includes("gh release create"), "uploads inside the stage step");
  assert.ok(step.indexOf('cp "$BUILT/$TGZ"') < step.indexOf("gh release create"));
});

test("a stage step with no tarball in the build artifact stops before touching the release", () => {
  const r = packStep({ built: false });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /artifact holds no aiand-cli-1\.2\.3\.tgz/);
  assert.deepEqual(r.calls, []);
});

// The jobs under `jobs:`, by name: each is the text up to the next job.
function jobsOf(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = body.split(/^ {2}(?=[a-z][a-z0-9-]*:\n)/m).filter((part) => /^[a-z]/.test(part));
  return Object.fromEntries(parts.map((part) => [part.slice(0, part.indexOf(":")), part]));
}
const JOBS = jobsOf(workflow);

describe("job layout", () => {
  test("a v* tag publishes latest, and a push to main publishes next", () => {
    assert.match(workflow, /\non:\n {2}push:\n {4}tags: \["v\*"\]\n {4}branches: \[main\]\n/);
    assert.deepEqual(Object.keys(JOBS).sort(), ["build", "publish", "publish-next"]);
    assert.match(JOBS.publish, /\n {4}if: github\.ref_type == 'tag'\n/);
    assert.match(JOBS["publish-next"], /\n {4}if: github\.ref_type == 'branch'\n/);
    assert.match(JOBS.publish, /npm publish "\$TARBALL" --tag "\$DIST_TAG"/);
    assert.match(JOBS["publish-next"], /npm publish "\$TARBALL" --tag next --provenance/);
  });

  test("the build job packs with no publish credential and no write access", () => {
    assert.match(workflow, /\npermissions: \{\}\n/);
    const build = JOBS.build;
    assert.match(
      build,
      /\n {4}permissions:\n {6}contents: read\n {6}actions: read[^\n]*\n {4}outputs:/,
    );
    assert.doesNotMatch(build, /id-token|: write|environment:/);
    assert.match(build, /npm pack --ignore-scripts/);
    assert.match(build, /actions\/upload-artifact@[0-9a-f]{40} /);
  });

  test("a next build waits for CI on its commit and never commits its version", () => {
    const build = JOBS.build;
    const wait = build.indexOf("- name: Wait for CI on this commit");
    const version = build.indexOf("- name: Set the next version");
    assert.ok(wait > 0 && version > wait && build.indexOf("npm pack") > version);
    assert.match(build, /npm version "\$VERSION" --no-git-tag-version/);
    assert.doesNotMatch(build, /git (commit|push|tag)/);
  });

  for (const [name, environment] of [
    ["publish", "release"],
    ["publish-next", "next"],
  ]) {
    test(`${name} uploads only the build job's checked artifact, from the ${environment} environment`, () => {
      const job = JOBS[name];
      assert.match(job, /\n {4}needs: build\n/);
      assert.match(job, new RegExp(`\\n {4}environment: ${environment}\\n`));
      assert.match(job, /\n {6}id-token: write/);
      assert.doesNotMatch(job, /npm pack|npm ci|npm run build/);
      const download = job.indexOf("actions/download-artifact@");
      const check = job.indexOf(".github/scripts/check-artifact.sh");
      const publish = job.indexOf("npm publish");
      assert.ok(
        download > 0 && check > download && publish > check,
        "download, check, then publish",
      );
      assert.match(job.slice(check), /SHA256: \$\{\{ needs\.build\.outputs\.sha256 \}\}/);
    });
  }

  test("every action is pinned by a full commit sha", () => {
    for (const file of ["publish.yml", "backport.yml"]) {
      const text = readFileSync(join(root, ".github", "workflows", file), "utf8");
      for (const [, ref] of text.matchAll(/uses: [^@\s]+@(\S+)/g)) {
        assert.match(ref, /^[0-9a-f]{40}$/, `${file}: ${ref}`);
      }
    }
  });
});

describe("backport.yml", () => {
  const backport = readFileSync(join(root, ".github", "workflows", "backport.yml"), "utf8");
  test("runs on merged pull requests into main, with no pull request code", () => {
    assert.match(
      backport,
      /pull_request_target:\n {4}types: \[closed, labeled\]\n {4}branches: \[main\]/,
    );
    assert.match(backport, /github\.event\.pull_request\.merged == true/);
    assert.doesNotMatch(backport, /pull_request\.head|head_ref|head\.sha/);
    assert.match(backport, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(backport, /\npermissions: \{\}\n/);
  });
  test("passes pull request text through the environment, never into the script", () => {
    const run = backport.slice(backport.indexOf("run: "));
    assert.doesNotMatch(run, /\$\{\{/);
    assert.match(backport, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  });
});

describe("check-artifact.sh", () => {
  const SCRIPT = join(root, ".github", "scripts", "check-artifact.sh");
  const digests = (bytes) => ({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  });
  function check(files, { name = TGZ, of = "honest bytes" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "aiand-artifact-"));
    try {
      for (const [file, bytes] of Object.entries(files)) writeFileSync(join(dir, file), bytes);
      const { sha256, sha512 } = digests(of);
      return spawnSync("bash", [SCRIPT, dir, name, sha256, sha512], { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  test("passes the build job's own file", () => {
    const r = check({ [TGZ]: "honest bytes" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  test("stops on other bytes under the same name", () => {
    const r = check({ [TGZ]: "other bytes" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /is not the file the build job packed/);
  });
  test("stops on an extra file beside it", () => {
    const r = check({ [TGZ]: "honest bytes", "extra.sh": "x" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /must hold only aiand-cli-1\.2\.3\.tgz/);
  });
  test("stops when the file is missing", () => {
    const r = check({});
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /must hold only/);
  });
  test("stops on a name that is not an aiand-cli tarball", () => {
    const r = check({ "x.tgz": "honest bytes" }, { name: "x.tgz" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not an aiand-cli-<version>\.tgz/);
  });
});
