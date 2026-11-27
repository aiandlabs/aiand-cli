// Live Copilot CLI smoke: the only proof stubs cannot give — a real pinned
// `copilot` binary accepting the providers.json `aiand copilot on` generates
// (closed-source; the BYOK provider shape is documented, not schema-validated
// for us) and a headless -p round-trip through the loopback gateway double.
// It also proves the load-bearing unknown: provider-qualified selection of a
// SLASHED catalog id (`aiand/zai-org/glm-5.3`).
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned
// @github/copilot). No real gateway, no key: the loopback double serves
// /v1/models and /v1/chat/completions, per the repo rule that CLI-error
// coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `copilot` on PATH. Exits non-zero on any
// failure.
//
// Observed against copilot 1.0.89 (this script is the record):
//   - providers.json IS read for BYOK, with no extra env: the bare
//     invocation against $HOME/.copilot routed through the double. The
//     COPILOT_PROVIDER_* env single-provider surface is NOT required and
//     is left unset here, so no override can mask a config-file regression.
//   - NO GitHub login: BYOK skips auth entirely (a scratch HOME with no
//     credentials round-trips). No token is seeded, so a regression to a
//     login prompt fails this script loudly.
//   - The provider-qualified SLASHED selection is ACCEPTED:
//     `"model":"aiand/zai-org/glm-5.3"` resolves and the body carries the
//     wireModel `zai-org/glm-5.3` — the same for --model and for the
//     launcher's COPILOT_MODEL env pin. No dashed-id contingency needed.
//   - COPILOT_OFFLINE="true" is not needed for providers.json, but it cuts
//     a run from ~11s to ~1.4s (no network attempts) and pins hermeticity,
//     so phase 2 sets it plus CI=1. The documented "requires a local model
//     provider (COPILOT_PROVIDER_BASE_URL)" is satisfied by the
//     providers.json row — the env surface is an alternative, not a
//     prerequisite.
//   - `copilot providers` is an interactive slash command, not a CLI
//     subcommand (`copilot providers --help` errors with "Invalid command
//     format"), so there is nothing to query from a script.
//   - A real prompt run writes config.json/logs/session-store* into
//     COPILOT_HOME; `off` still deletes exactly the two files `on` created
//     from a fresh sandbox (phase 3 asserts that).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

// Two catalog models the double serves: the default pins the slashed id in
// providers.json/settings.json, the second proves --model selection moves.
const SMOKE_MODELS = ["zai-org/glm-5.3", "other/model"].map((id) => ({
  id,
  name: id,
  object: "model",
  created: 1,
  owned_by: "aiand",
  provider: "aiand",
  context_window: 200000,
  capabilities: ["tools"],
  reasoning_efforts: null,
  reasoning_effort_default: null,
  description: null,
  currency: "usd",
  input_per_1m: "0.60",
  output_per_1m: "2.40",
  cached_input_per_1m: null,
}));

const S = mkdtempSync(join(tmpdir(), "aiand-copilot-smoke-"));
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
  if (!rows.every((row) => row?.model === expectedModel)) {
    fail(`${label}: a completion request did not use ${expectedModel}:\n${raw}`);
    return;
  }
  process.stdout.write(`PASS ${label}\n`);
}

try {
  const { child, baseUrl } = await startSmokeDouble(S, {
    logPath: requestLog,
    models: SMOKE_MODELS,
    stream: false,
  });
  doubleChild = child;

  const home = join(S, "home");
  const cfg = join(S, "cfg");
  const copilotDir = join(home, ".copilot");
  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-copilot-smoke-key-00000000",
    AIAND_BASE_URL: baseUrl,
  };
  // The real copilot, never a stub: it reads the config `aiand copilot on`
  // wrote under $HOME/.copilot. Scrub the launcher's own knobs, the BYOK env
  // surface (which would bypass providers.json and mask a regression), and
  // any inherited GitHub token (so a login prompt cannot be satisfied
  // silently — BYOK must carry the run on its own).
  for (const name of [
    "COPILOT_HOME",
    "COPILOT_PROVIDERS_CONFIG",
    "COPILOT_MODEL",
    "COPILOT_OFFLINE",
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_WIRE_API",
    "COPILOT_PROVIDER_WIRE_MODEL",
    "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    delete env[name];
  }

  // 1. Wire with the real CLI against the double (loopback http is a legal
  //    routable base URL; a refusal to load that config surfaces here).
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "copilot", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand copilot on\n");
  else fail(`aiand copilot on: ${JSON.stringify(on)}`);

  // 2. Headless round-trips: the default selection and an explicit
  //    --model both resolve to the wireModel the double echoes. The
  //    slashed id proving here is the point — bare or split-wrong ids
  //    would echo a different string or error. COPILOT_OFFLINE is not
  //    needed for providers.json (observed) but cuts the run from ~11s to
  //    ~1.4s by skipping network attempts; CI=1 implies
  //    --no-auto-update's default.
  const run = (args) =>
    execFileSync("copilot", ["-p", "hi", "-s", "--no-auto-update", ...args], {
      env: { ...env, NO_COLOR: "1", COPILOT_OFFLINE: "true", CI: "1" },
      encoding: "utf8",
      timeout: 180_000,
      cwd: home,
    });
  try {
    writeFileSync(requestLog, "");
    const printed = run([]);
    auditRequests("zai-org/glm-5.3", "copilot default request model audit");
    if (printed.includes("echo:zai-org/glm-5.3")) {
      process.stdout.write("PASS copilot -p routes the slashed default through the gateway\n");
    } else {
      fail(`copilot default round-trip did not echo the catalog id:\n${printed}`);
    }
  } catch (error) {
    fail(`copilot default round-trip failed: ${error.stderr ?? error.message}`);
  }
  try {
    writeFileSync(requestLog, "");
    const printed = run(["--model", "aiand/other/model"]);
    auditRequests("other/model", "copilot --model request model audit");
    if (printed.includes("echo:other/model")) {
      process.stdout.write("PASS copilot --model selects the other provider-qualified id\n");
    } else {
      fail(`copilot --model round-trip did not echo the second model:\n${printed}`);
    }
  } catch (error) {
    fail(`copilot --model round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 3. Subtractive off: a fresh sandbox's on/off pair is exact, so both
  //    files `on` created are gone (enable recorded their absence; the
  //    real run's config.json/logs/session-store* are not ours to remove).
  execFileSync(process.execPath, [DIST, "copilot", "off", "--json"], { env, encoding: "utf8" });
  const stragglers = ["providers.json", "settings.json"].filter((name) =>
    existsSync(join(copilotDir, name)),
  );
  if (stragglers.length === 0)
    process.stdout.write("PASS copilot off deletes both files on created\n");
  else fail(`copilot off left ${stragglers.join(", ")} behind`);
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
