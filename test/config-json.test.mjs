import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { runCli } from "./helpers.mjs";

function childEnv(dir) {
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  delete env.AIAND_PROFILE;
  env.AIAND_HOME = join(dir, "home");
  env.AIAND_CONFIG_DIR = join(dir, "cfg");
  env.NO_UPDATE_CHECK = "1";
  env.CI = "1";
  return env;
}

const storedConfig = (dir) => JSON.parse(readFileSync(join(dir, "cfg", "config.json"), "utf8"));

describe("config set/use --json", () => {
  test("set --json emits pure JSON with profile, key, value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-config-json-"));
    try {
      const r = await runCli(["config", "set", "model", "picked-model", "--json"], { env: childEnv(dir) });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.profile, "default");
      assert.equal(parsed.key, "model");
      assert.equal(parsed.value, "picked-model");
      assert.equal(storedConfig(dir).profiles.default.model, "picked-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("use --json emits pure JSON with profile and switches default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-config-json-"));
    try {
      const r = await runCli(["config", "use", "work", "--json"], { env: childEnv(dir) });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).profile, "work");
      assert.equal(storedConfig(dir).profile, "work");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("human paths still print prose, not JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-config-json-"));
    try {
      const env = childEnv(dir);
      const s = await runCli(["config", "set", "model", "m"], { env });
      assert.equal(s.code, 0, `exit ${s.code}: ${s.stderr}`);
      assert.match(s.stdout, /Set model = m/);
      assert.throws(() => JSON.parse(s.stdout));
      const u = await runCli(["config", "use", "other"], { env });
      assert.equal(u.code, 0, `exit ${u.code}: ${u.stderr}`);
      assert.match(u.stdout, /Using profile/);
      assert.throws(() => JSON.parse(u.stdout));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("use rebakes baked Session keys onto the target profile credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-config-use-rebake-"));
    try {
      const env = childEnv(dir);
      env.AIAND_KEY_STORAGE = "plaintext";
      mkdirSync(join(dir, "cfg"), { recursive: true });
      mkdirSync(join(dir, "home", ".config", "opencode"), { recursive: true });
      writeFileSync(
        join(dir, "cfg", "config.json"),
        JSON.stringify({ profile: "default", profiles: { default: {}, work: {} } }) + "\n"
      );
      writeFileSync(
        join(dir, "cfg", "credentials.json"),
        JSON.stringify({ work: { origin: "paste", storage: "plaintext" } }) + "\n"
      );
      writeFileSync(
        join(dir, "cfg", "credentials-plaintext.json"),
        JSON.stringify({ work: JSON.stringify({ access_token: "sk-work" }) }) + "\n"
      );
      const oc = join(dir, "home", ".config", "opencode", "opencode.json");
      writeFileSync(
        oc,
        JSON.stringify({
          provider: {
            aiand: {
              options: {
                baseURL: "https://api.aiand.com/v1",
                apiKey: "sk-default",
                "x-aiand": true,
              },
            },
          },
          model: "aiand/m-default",
          "x-aiand": true,
        }) + "\n"
      );
      const r = await runCli(["config", "use", "work", "--json"], { env });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).profile, "work");
      const baked = JSON.parse(readFileSync(oc, "utf8"));
      assert.equal(baked.provider.aiand.options.apiKey, "sk-work");
      assert.match(r.stderr, /Key refreshed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("use warns when agents are on and the target has no credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiand-config-use-warn-"));
    try {
      const env = childEnv(dir);
      mkdirSync(join(dir, "home", ".config", "opencode"), { recursive: true });
      const oc = join(dir, "home", ".config", "opencode", "opencode.json");
      writeFileSync(
        oc,
        JSON.stringify({
          provider: {
            aiand: {
              options: {
                baseURL: "https://api.aiand.com/v1",
                apiKey: "sk-default",
                "x-aiand": true,
              },
            },
          },
          model: "aiand/m-default",
          "x-aiand": true,
        }) + "\n"
      );
      const r = await runCli(["config", "use", "other"], { env });
      assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}`);
      assert.match(r.stdout, /Using profile/);
      assert.match(r.stderr, /baked keys/);
      assert.equal(JSON.parse(readFileSync(oc, "utf8")).provider.aiand.options.apiKey, "sk-default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
