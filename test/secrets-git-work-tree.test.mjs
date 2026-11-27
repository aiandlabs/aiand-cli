import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv, writeConfigMarker } from "./helpers.mjs";

const env = withTestEnv("aiand-secrets-git-work-tree-test-", (dir) => {
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_CONFIG_DIR = join(dir, "repo", "config");
  process.env.AIAND_KEY_STORAGE = "file";
  delete process.env.AIAND_SECRET_STORE_MASTER_KEY;
  delete process.env.AIAND_ALLOW_GIT_TRACKED;
});

const secrets = await import("../dist/secrets.js");
const config = await import("../dist/config.js");
const { readStore } = await import("../dist/secrets-file.js");
const { writeFileAtomic } = await import("../dist/fsutil.js");
const { CliError } = await import("../dist/cli/errors.js");

const repoPath = () => join(env.dir, "repo");
const configPath = () => join(env.dir, "repo", "config");
const dpapiPath = () => join(process.env.AIAND_CONFIG_DIR, "secret-store.dpapi.json");
const plaintextPath = () => join(process.env.AIAND_CONFIG_DIR, "credentials-plaintext.json");
const readMap = (path) => JSON.parse(readFileSync(path, "utf8"));

async function seedEveryFileTier() {
  await withEnv({ AIAND_ALLOW_GIT_TRACKED: "1", AIAND_KEY_STORAGE: "file" }, async () => {
    for (const profile of ["default", "other"]) {
      await config.saveCredential(profile, {
        access_token: `sk-${profile}-pasted`,
        origin: "paste",
      });
    }

    // A config shared with Windows can hold DPAPI ciphertext this host cannot
    // decrypt. Its removal is still a local JSON read-modify-write.
    writeFileSync(
      dpapiPath(),
      `${JSON.stringify({ default: "ZGVmYXVsdA==", other: "b3RoZXI=" }, null, 2)}\n`,
    );

    await withEnv({ AIAND_KEY_STORAGE: "plaintext" }, async () => {
      for (const profile of ["default", "other"]) {
        await secrets.storeSecret(
          profile,
          JSON.stringify({ access_token: `sk-${profile}-pasted` }),
        );
      }
    });
  });
}

beforeEach(() => {
  rmSync(env.dir, { recursive: true, force: true });
  mkdirSync(process.env.AIAND_HOME, { recursive: true });
  execFileSync("git", ["init", "--quiet", repoPath()]);
});

test("the file store refuses a config directory inside a git work tree", async () => {
  await assert.rejects(
    () => secrets.storeSecret("profile", "blob"),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(
        error.message,
        `Refusing to keep your ai& key in ${join(realpathSync(configPath()), "secret-store.json")}: it is inside the git repository at ${realpathSync(repoPath())}.`,
      );
      assert.equal(
        error.hint,
        "Move the config directory out of the repository (set AIAND_CONFIG_DIR), or add it to the repository's .gitignore and re-run with AIAND_ALLOW_GIT_TRACKED=1.",
      );
      return true;
    },
  );
});

test("AIAND_ALLOW_GIT_TRACKED=1 allows it", async () => {
  await withEnv({ AIAND_ALLOW_GIT_TRACKED: "1" }, async () => {
    assert.equal(await secrets.storeSecret("profile", "blob"), "file");
    assert.equal(await secrets.loadSecret("profile"), "blob");
  });
});

test("a config directory outside any git work tree is unaffected", async () => {
  const config = join(env.dir, "outside", "config");
  await withEnv({ AIAND_CONFIG_DIR: config }, async () => {
    assert.equal(await secrets.storeSecret("profile", "blob"), "file");
    assert.equal(await secrets.loadSecret("profile"), "blob");
  });
  assert.equal(existsSync(join(config, "secret-store.json")), true);
  assert.equal(existsSync(join(config, "secret-store.key")), true);
});

test("nothing is written when the write is refused", async () => {
  await assert.rejects(() => secrets.storeSecret("profile", "blob"), CliError);
  assert.deepEqual(readdirSync(configPath()), []);
});

test("logout removes a key from every file tier inside a git work tree", async () => {
  await seedEveryFileTier();

  const result = await runCli(["logout", "--keep-remote", "--json"], {
    env: cliEnv({ AIAND_ALLOW_GIT_TRACKED: undefined }),
  });

  assert.equal(result.code, 0, result.stderr);
  const metadata = await config.loadAllCredentials();
  assert.equal(metadata.default, undefined);
  assert.ok(metadata.other);
  assert.deepEqual(Object.keys(await readStore()), ["other"]);
  assert.deepEqual(Object.keys(readMap(dpapiPath())), ["other"]);
  assert.deepEqual(Object.keys(readMap(plaintextPath())), ["other"]);
});

test("logout --all deletes every file store inside a git work tree", async () => {
  const home = process.env.AIAND_HOME;
  const repository = join(home, "repository");
  const configDir = join(repository, "config");
  execFileSync("git", ["init", "--quiet", repository]);

  await withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      AIAND_CONFIG_DIR: configDir,
    },
    async () => {
      await seedEveryFileTier();
      writeConfigMarker(configDir);

      const result = await runCli(["logout", "--all", "--force", "--keep-remote", "--json"], {
        env: cliEnv({ AIAND_ALLOW_GIT_TRACKED: undefined }),
      });

      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.complete, true, result.stdout);
      assert.equal(existsSync(configDir), false);
    },
  );
});

test("direct DPAPI and plaintext key writes still refuse a git work tree", async () => {
  for (const path of [dpapiPath(), plaintextPath()]) {
    await assert.rejects(
      () => writeFileAtomic(path, `${JSON.stringify({ profile: "ciphertext" })}\n`),
      CliError,
    );
    assert.equal(existsSync(path), false);
  }
});
