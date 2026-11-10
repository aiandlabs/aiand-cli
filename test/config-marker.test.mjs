// The `.aiand-config` marker is what lets `logout --all` delete from a dir by
// name. Every write under the config dir passes the code that drops it, cache
// files included, so a mistyped AIAND_CONFIG_DIR must not be vouched for by the
// first `aiand models`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withTestEnv } from "./helpers.mjs";

const env = withTestEnv("aiand-config-marker-", (dir) => {
  process.env.HOME = join(dir, "home");
  process.env.USERPROFILE = join(dir, "home");
  process.env.AIAND_HOME = join(dir, "home");
  process.env.AIAND_KEY_STORAGE = "plaintext";
  delete process.env.AIAND_API_KEY;
  delete process.env.AIAND_WIPE_OUTSIDE_HOME;
  process.env.CI = "1";
});
const { writeFileAtomic } = await import("../dist/fsutil.js");

const MARKER = ".aiand-config";
const DOCKER_CONFIG = '{"auths":{"registry.example":{}},"credsStore":"desktop"}\n';
const AIAND_CONFIG = '{"profile":"default","profiles":{"default":{}}}\n';

let counter = 0;
/** A dir under the test HOME, so logout --all's outside-home refusal is not what the test sees. */
function homeDir(name) {
  counter += 1;
  return join(env.dir, "home", `${name}-${counter}`);
}

/** What `aiand models` does to the config dir: write a cache file. */
async function cacheWrite(dir) {
  process.env.AIAND_CONFIG_DIR = dir;
  await writeFileAtomic(join(dir, "model-catalog.json"), "{}\n", { mode: 0o600 });
}

describe("the config-dir marker", () => {
  test("a fresh dir is marked by aiand's first write", async () => {
    const dir = homeDir("fresh");
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), true);
  });

  test("an empty existing dir is marked", async () => {
    const dir = homeDir("empty");
    mkdirSync(dir, { recursive: true });
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), true);
  });

  test("a pre-0.8 aiand dir with no marker gets one", async () => {
    const dir = homeDir("old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), AIAND_CONFIG);
    writeFileSync(join(dir, "credentials.json"), "{}\n");
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), true);
  });

  test("a pre-0.8 aiand dir that also holds other files still gets one", async () => {
    const dir = homeDir("old-extras");
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "config.json"), AIAND_CONFIG);
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), true);
  });

  test("a dir holding aiand's own cache files and nothing else is marked", async () => {
    const dir = homeDir("caches");
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "update-check.json"), "{}\n");
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), true);
  });

  test("a foreign dir with a Docker-shaped config.json gets no marker from a cache write", async () => {
    const dir = homeDir("docker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), DOCKER_CONFIG);
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), false);
    assert.equal(readFileSync(join(dir, "config.json"), "utf8"), DOCKER_CONFIG);
  });

  test("a foreign dir with other entries and no config.json gets no marker either", async () => {
    const dir = homeDir("contexts");
    mkdirSync(join(dir, "contexts"), { recursive: true });
    await cacheWrite(dir);
    assert.equal(existsSync(join(dir, MARKER)), false);
  });

  test("`logout --all --force` then refuses the mistyped dir and deletes nothing", async () => {
    const dir = homeDir("docker-logout");
    mkdirSync(join(dir, "contexts"), { recursive: true });
    writeFileSync(join(dir, "config.json"), DOCKER_CONFIG);
    writeFileSync(join(dir, "contexts", "meta.json"), "{}\n");
    await cacheWrite(dir);
    const { code, stderr } = await runCli(["logout", "--all", "--force"], {
      env: cliEnv({
        HOME: join(env.dir, "home"),
        USERPROFILE: join(env.dir, "home"),
        AIAND_HOME: join(env.dir, "home"),
        AIAND_CONFIG_DIR: dir,
        AIAND_KEY_STORAGE: "plaintext",
        AIAND_API_KEY: undefined,
      }),
    });
    assert.notEqual(code, 0);
    assert.match(stderr, /not aiand's config directory/);
    assert.equal(readFileSync(join(dir, "config.json"), "utf8"), DOCKER_CONFIG);
    assert.equal(existsSync(join(dir, "contexts", "meta.json")), true);
    assert.equal(
      existsSync(join(dir, "model-catalog.json")),
      true,
      "aiand's own cache file is not touched either",
    );
  });
});
