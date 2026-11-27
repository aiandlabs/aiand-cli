// Offline OpenCode smoke: a real `opencode` binary reads the config written by
// `aiand opencode on`, then `opencode run` round-trips through the loopback
// double. The request-log audit covers every completion request, including
// title and summary traffic, not just the model echoed in the final response.
//
// Requires: dist/index.js built, `opencode` on PATH. Exits non-zero on any
// failure. No live gateway or key is used.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const CHOSEN_MODEL = "zai-org/glm-5.3";
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
let doubleChild;
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
    AIAND_API_KEY: "sk-e2e-opencode-smoke-key-00000000",
    AIAND_BASE_URL: baseUrl,
    AIAND_ALLOW_KEY_TO: baseUrl,
  };
  // The real binary must read the file written below, never an inherited
  // inline config from an aiand launcher or an alternate config path.
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_CONFIG;

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
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
