// Offline Hermes smoke: the real `hermes` binary round-trips through the
// Launcher's temporary overlay and the loopback double. The request-log audit
// covers every chat-completions request, including background and auxiliary
// traffic, not just the model echoed in the final response.
//
// Requires: dist/index.js built, `hermes` on PATH. Exits non-zero on any failure.
// No live gateway or real credential is used.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hermesAdapter } from "../dist/agents/hermes/adapter.js";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const CHOSEN_MODEL = "zai-org/glm-5.3";
// Capture the installed home before replacing HOME. Its runtime stores feed the
// Launcher's overlay; an empty home would make Hermes provision them per run.
const realHermesHome = process.env.HERMES_HOME || join(process.env.HOME ?? "", ".hermes");

const S = mkdtempSync(join(tmpdir(), "aiand-hermes-smoke-"));
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
    fail(`${label}: request log is empty; no chat-completions requests were recorded`);
    return;
  }

  let rows;
  try {
    rows = raw.trim().split("\n").map(JSON.parse);
  } catch {
    fail(`${label}: malformed request log:\n${raw}`);
    return;
  }
  if (
    rows.length === 0 ||
    !rows.every(
      (row) =>
        row?.method === "POST" &&
        row.path === "/v1/chat/completions" &&
        row.model === expectedModel,
    )
  ) {
    fail(
      `${label}: an inference request was not a /v1/chat/completions request for ${expectedModel}:\n${raw}`,
    );
    return;
  }
  process.stdout.write(`PASS ${label}\n`);
}

try {
  const { child, baseUrl } = await startSmokeDouble(S, { logPath: requestLog });
  doubleChild = child;

  const home = join(S, "home");
  const work = join(S, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });

  const env = { ...process.env };
  // Inherited provider routing must not shadow the Launcher's overlay.
  for (const name of hermesAdapter.shadowEnv) delete env[name];
  Object.assign(env, {
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: join(S, "cfg"),
    HERMES_HOME: realHermesHome,
    AIAND_API_KEY: "sk-e2e-hermes-smoke-key-00000000",
    AIAND_BASE_URL: baseUrl,
    AIAND_ALLOW_KEY_TO: baseUrl,
  });

  // Audit only inference from the real headless Launcher journey. run-agent
  // resolves `hermes` from PATH and owns the overlay and store-shim cleanup.
  writeFileSync(requestLog, "");
  const result = spawnSync(
    process.execPath,
    [DIST, "run-agent", "hermes", "--model", CHOSEN_MODEL, "--", "-z", "Say hi"],
    {
      env: { ...env, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 180_000,
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    fail(
      `run-agent hermes round-trip failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}\n${output}`,
    );
  } else if (output.includes(`echo:${CHOSEN_MODEL}`)) {
    process.stdout.write("PASS run-agent hermes routes the chosen model through the gateway\n");
  } else {
    fail(`run-agent hermes round-trip did not echo the chosen model:\n${output}`);
  }

  // Every inference row, not merely the visible response, must name the chosen
  // model and use Hermes's OpenAI-compatible chat-completions endpoint.
  auditRequests(CHOSEN_MODEL, "run-agent hermes request model audit");
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
