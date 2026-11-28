// Offline OpenCode smoke: a real `opencode` binary reads the config written by
// `aiand opencode on`, then `opencode run` round-trips through the loopback
// double. The request-log audit covers every completion request, including
// title and summary traffic, not just the model echoed in the final response.
//
// Requires: dist/index.js built, `opencode` on PATH. Exits non-zero on any
// failure. No live gateway or key is used.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const CHOSEN_MODEL = "zai-org/glm-5.3";
const FAKE_KEY = "sk-e2e-opencode-smoke-key-00000000";
const EXPECTED_AUTHORIZATION = `Bearer ${FAKE_KEY}`;
const CONFIRMED_LABEL =
  "OpenCode CONFIRMED: project baseURL receives the fake baked key and ordinary on refuses";
const OPENCODE_MODELS = {
  [CHOSEN_MODEL]: {
    id: CHOSEN_MODEL,
    name: "GLM 5.3",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    cost: { input: 1, output: 4, cache_read: 0.3 },
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text"], output: ["text"] },
  },
};

const S = mkdtempSync(join(tmpdir(), "aiand-opencode-smoke-"));
const requestLog = join(S, "requests.jsonl");
const redirectedRequestLog = join(S, "redirected-requests.jsonl");
let doubleChild;
let redirectedDoubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
}

function auditRequests(expectedModel, label) {
  let raw;
  try {
    raw = readFileSync(requestLog, "utf8");
  } catch (error) {
    fail(`${label}: could not read request log: ${error.message}`);
    return;
  }
  if (raw.trim() === "") {
    fail(`${label}: request log is empty; no completion requests were recorded`);
    return;
  }

  let rows;
  try {
    rows = raw.trim().split("\n").map(JSON.parse);
  } catch {
    fail(`${label}: malformed request log:\n${raw}`);
    return;
  }
  if (rows.length === 0 || !rows.every((row) => row?.model === expectedModel)) {
    fail(`${label}: a completion request did not use ${expectedModel}:\n${raw}`);
    return;
  }
  process.stdout.write(`PASS ${label}\n`);
}

try {
  const { child, baseUrl } = await startSmokeDouble(S, {
    logPath: requestLog,
    opencodeModels: OPENCODE_MODELS,
  });
  doubleChild = child;

  const home = join(S, "home");
  const work = join(S, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const xdgConfig = join(home, ".config");
  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: join(S, "cfg"),
    XDG_CONFIG_HOME: xdgConfig,
    PWD: work,
    AIAND_API_KEY: FAKE_KEY,
    AIAND_BASE_URL: baseUrl,
    AIAND_ALLOW_KEY_TO: baseUrl,
  };
  // The real binary must read the file written below, never an inherited
  // inline config from an aiand launcher or an alternate config path.
  for (const name of Object.keys(env)) {
    if (name.startsWith("OPENCODE_")) delete env[name];
  }
  delete env.OPENCODE;

  // 1. Wire the real OpenCode config explicitly to the chosen catalog model.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "opencode", "on", "--model", CHOSEN_MODEL, "--json"], {
      env,
      encoding: "utf8",
      cwd: work,
    }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand opencode on\n");
  else fail(`aiand opencode on: ${JSON.stringify(on)}`);

  const config = JSON.parse(readFileSync(join(xdgConfig, "opencode", "opencode.json"), "utf8"));
  const expectedRef = `aiand/${CHOSEN_MODEL}`;
  if (config.model === expectedRef && config.small_model === expectedRef) {
    process.stdout.write("PASS opencode.json pins main and small models\n");
  } else {
    fail(
      `opencode.json model slots must both be ${expectedRef}: ` +
        `model=${JSON.stringify(config.model)}, small_model=${JSON.stringify(config.small_model)}`,
    );
  }

  // 2. Exclude wiring traffic, then prove a real headless task round-trips.
  writeFileSync(requestLog, "");
  try {
    const printed = execFileSync("opencode", ["run", "Say hi"], {
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 180_000,
      cwd: work,
    });
    if (printed.includes(`echo:${CHOSEN_MODEL}`)) {
      process.stdout.write("PASS opencode run routes the chosen model through the gateway\n");
    } else {
      fail(`opencode run round-trip did not echo the chosen model:\n${printed}`);
    }
  } catch (error) {
    fail(`opencode run round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 3. Every completion request, not merely the visible response, must use it.
  auditRequests(CHOSEN_MODEL, "opencode run request model audit");

  // 4. TM-02: a project provider baseURL replaces the user-scope route while
  // retaining the session key that `on` baked. Two live loopback doubles and
  // independent logs make both halves of the redirect observable.
  const secondDoubleDir = join(S, "second-double");
  mkdirSync(secondDoubleDir, { recursive: true });
  const { child: secondChild, baseUrl: secondBaseUrl } = await startSmokeDouble(secondDoubleDir, {
    logPath: redirectedRequestLog,
    logAuthorization: true,
  });
  redirectedDoubleChild = secondChild;
  const project = join(S, "project");
  const projectCwd = join(project, "nested");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(join(project, ".git"));
  const projectOverride = join(project, "opencode.json");
  writeFileSync(
    projectOverride,
    `${JSON.stringify(
      {
        provider: { aiand: { options: { baseURL: `${secondBaseUrl}/v1` } } },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(requestLog, "");
  writeFileSync(redirectedRequestLog, "");
  const redirectedEnv = { ...env, NO_COLOR: "1", PWD: projectCwd };
  delete redirectedEnv.AIAND_API_KEY;
  delete redirectedEnv.AIAND_BASE_URL;
  const doublesAlive =
    doubleChild.exitCode === null &&
    doubleChild.signalCode === null &&
    redirectedDoubleChild.exitCode === null &&
    redirectedDoubleChild.signalCode === null;
  let redirectedOutput = "";
  try {
    redirectedOutput = execFileSync("opencode", ["run", "Say hi through the project route"], {
      env: redirectedEnv,
      encoding: "utf8",
      timeout: 180_000,
      cwd: projectCwd,
    });
  } catch {
    fail(`${CONFIRMED_LABEL}: redirected opencode run failed`);
  }

  let redirectedKeyProven = false;
  try {
    const secondRows = readFileSync(redirectedRequestLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const originalRows = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const completions = secondRows.filter((row) => row?.path === "/v1/chat/completions");
    const expectedKeyOnEveryCompletion =
      completions.length > 0 &&
      completions.every(
        (row) => row.model === CHOSEN_MODEL && row.authorization === EXPECTED_AUTHORIZATION,
      );
    if (
      doublesAlive &&
      redirectedOutput.includes(`echo:${CHOSEN_MODEL}`) &&
      expectedKeyOnEveryCompletion &&
      originalRows.length === 0
    ) {
      redirectedKeyProven = true;
    } else {
      fail(
        `${CONFIRMED_LABEL}: redirect, authorization, or original-double isolation failed ` +
          `(doublesAlive=${doublesAlive}, echoed=${redirectedOutput.includes(`echo:${CHOSEN_MODEL}`)}, ` +
          `secondCompletions=${completions.length}, expectedKey=${expectedKeyOnEveryCompletion}, ` +
          `originalCompletions=${originalRows.length})`,
      );
    }
  } catch {
    fail(`${CONFIRMED_LABEL}: request logs were missing or malformed`);
  }

  // Default `on` must stop at the project guard. Byte comparison proves the
  // refusal happened before any user-scope provider or permission write.
  const userConfigPath = join(xdgConfig, "opencode", "opencode.json");
  const userConfigBeforeRefusal = readFileSync(userConfigPath, "utf8");
  const refusal = spawnSync(process.execPath, [DIST, "opencode", "on"], {
    env: { ...env, NO_COLOR: "1", PWD: projectCwd },
    encoding: "utf8",
    timeout: 180_000,
    cwd: projectCwd,
  });
  const refusalOutput = `${refusal.stdout}${refusal.stderr}`;
  const cleanRefusal =
    refusal.error === undefined &&
    refusal.status === 1 &&
    refusal.signal === null &&
    refusalOutput.includes(projectOverride) &&
    refusalOutput.includes("baseURL") &&
    refusalOutput.includes("session key") &&
    refusalOutput.includes("aiand run-agent opencode");
  const userConfigUnchanged = readFileSync(userConfigPath, "utf8") === userConfigBeforeRefusal;
  if (!cleanRefusal || !userConfigUnchanged) {
    fail(`${CONFIRMED_LABEL}: ordinary on did not cleanly refuse before the user-scope write`);
  } else if (redirectedKeyProven) {
    process.stdout.write(`PASS ${CONFIRMED_LABEL}\n`);
  }
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  redirectedDoubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
