// Offline Codex smoke: a real `codex` binary reads the profile written by
// `aiand codex on`, then `codex exec` round-trips through the loopback double.
// The request-log audit covers every Responses request, not just the model
// echoed in the final response.
//
// Requires: dist/index.js built, `codex` on PATH. Exits non-zero on any failure.
// No live gateway or real credential is used.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");
const CHOSEN_MODEL = "zai-org/glm-5.3";

const S = mkdtempSync(join(tmpdir(), "aiand-codex-smoke-"));
const requestLog = join(S, "requests.jsonl");
const projectDoubleDir = join(S, "project-double");
const projectRequestLog = join(projectDoubleDir, "requests.jsonl");
let doubleChild;
let projectDoubleChild;
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
    fail(`${label}: request log is empty; no Responses requests were recorded`);
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
        row?.method === "POST" && row.path === "/v1/responses" && row.model === expectedModel,
    )
  ) {
    fail(
      `${label}: an inference request was not a /v1/responses request for ${expectedModel}:\n${raw}`,
    );
    return;
  }
  process.stdout.write(`PASS ${label}\n`);
}

async function auditProjectOverride(printed, originalBaseUrl, projectBaseUrl) {
  const label = "Codex project-provider override audit";
  if (!printed.includes(`echo:${CHOSEN_MODEL}:effort=low`)) {
    fail(`${label}: the trusted project reasoning setting was not applied:\n${printed}`);
    return;
  }

  let originalRaw;
  let projectRaw;
  try {
    originalRaw = readFileSync(requestLog, "utf8");
  } catch (error) {
    fail(`${label}: could not read the original request log: ${error.message}`);
    return;
  }
  try {
    projectRaw = readFileSync(projectRequestLog, "utf8");
  } catch (error) {
    fail(`${label}: could not read the project provider request log: ${error.message}`);
    return;
  }

  if (originalRaw.trim() === "") {
    fail(`${label}: the original double recorded no Responses requests`);
    return;
  }
  let originalRows;
  try {
    originalRows = originalRaw.trim().split("\n").map(JSON.parse);
  } catch {
    fail(`${label}: malformed original request log:\n${originalRaw}`);
    return;
  }
  if (
    !originalRows.every(
      (row) =>
        row?.method === "POST" &&
        row.path === "/v1/responses" &&
        row.model === CHOSEN_MODEL &&
        row.authorization === "Bearer sk-e2e-codex-smoke-key-00000000",
    )
  ) {
    fail(
      `${label}: an original-double request had the wrong endpoint, model, or bearer key:\n${originalRaw}`,
    );
    return;
  }

  let projectRows;
  try {
    projectRows = projectRaw.trim() === "" ? [] : projectRaw.trim().split("\n").map(JSON.parse);
  } catch {
    fail(`${label}: malformed project provider request log:\n${projectRaw}`);
    return;
  }
  if (projectRows.length !== 0) {
    fail(`${label}: the project-selected provider received requests:\n${projectRaw}`);
    return;
  }

  for (const [name, child, baseUrl] of [
    ["original", doubleChild, originalBaseUrl],
    ["project provider", projectDoubleChild, projectBaseUrl],
  ]) {
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
      fail(`${label}: the ${name} double is not running`);
      continue;
    }
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5_000),
      });
      await response.arrayBuffer();
      if (!response.ok) fail(`${label}: the ${name} double returned HTTP ${response.status}`);
    } catch (error) {
      fail(`${label}: the ${name} double did not respond: ${error.message}`);
    }
  }

  if (!failed) {
    process.stdout.write(
      "PASS Codex NOT CONFIRMED: trusted project model_providers overrides are ignored; " +
        "the original gateway receives every Responses request\n",
    );
  }
}

try {
  const { child, baseUrl } = await startSmokeDouble(S, {
    logPath: requestLog,
    logAuthorization: true,
  });
  doubleChild = child;
  mkdirSync(projectDoubleDir, { recursive: true });
  const { child: projectChild, baseUrl: projectBaseUrl } = await startSmokeDouble(
    projectDoubleDir,
    { logPath: projectRequestLog, logAuthorization: true },
  );
  projectDoubleChild = projectChild;

  const home = join(S, "home");
  const codexHome = join(S, "codex");
  const work = join(S, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(work, { recursive: true });

  const env = { ...process.env };
  // Neither inherited Codex/OpenAI credentials nor routing may bypass the
  // profile and loopback provider configured below.
  for (const name of Object.keys(env)) {
    if (/^(?:CODEX_|OPENAI_)/.test(name.toUpperCase())) delete env[name];
  }
  Object.assign(env, {
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: join(S, "cfg"),
    CODEX_HOME: codexHome,
    AIAND_API_KEY: "sk-e2e-codex-smoke-key-00000000",
    AIAND_BASE_URL: baseUrl,
    AIAND_ALLOW_KEY_TO: baseUrl,
  });

  // POSIX profiles invoke the existing bare `aiand` auth command. Resolve that
  // command to this checkout without requiring a global aiand installation.
  if (process.platform !== "win32") {
    const bin = join(S, "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "aiand");
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${DIST}" "$@"\n`);
    chmodSync(launcher, 0o755);
    env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  }

  // 1. Wire the profile explicitly to the chosen model and loopback provider.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "codex", "on", "--model", CHOSEN_MODEL, "--json"], {
      env,
      encoding: "utf8",
      cwd: work,
    }),
  );
  if (on.state === "on" && on.model === CHOSEN_MODEL) {
    process.stdout.write("PASS aiand codex on\n");
  } else {
    fail(`aiand codex on: ${JSON.stringify(on)}`);
  }

  const profile = readFileSync(join(codexHome, "aiand.config.toml"), "utf8");
  const expectedProfileLines = [
    `model = "${CHOSEN_MODEL}"`,
    `base_url = "${baseUrl}/v1"`,
    `wire_api = "responses"`,
  ];
  const missing = expectedProfileLines.filter((line) => !profile.includes(line));
  if (missing.length === 0) {
    process.stdout.write(
      "PASS aiand.config.toml pins the model, provider, and Responses wire API\n",
    );
  } else {
    fail(`aiand.config.toml is missing ${missing.join(", ")}:\n${profile}`);
  }

  // 2. Exclude wiring traffic, then prove profile-driven routing with no
  // command-line model override from a working directory with no Git repo.
  writeFileSync(requestLog, "");
  try {
    const printed = execFileSync(
      "codex",
      ["--profile", "aiand", "--strict-config", "exec", "--skip-git-repo-check", "Say hi"],
      {
        env: { ...env, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 180_000,
        cwd: work,
      },
    );
    if (printed.includes(`echo:${CHOSEN_MODEL}:effort=high`)) {
      process.stdout.write("PASS codex exec routes the profile model with high reasoning effort\n");
    } else {
      fail(`codex exec round-trip did not echo the chosen model and effort:\n${printed}`);
    }
  } catch (error) {
    fail(`codex exec round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 3. Every inference request, not merely the visible response, must use the
  // chosen model and Codex's Responses endpoint.
  auditRequests(CHOSEN_MODEL, "codex exec request model audit");

  // 4. A trusted project may select its reasoning effort, but Codex must discard
  // its provider and base URL before merging the layer into the aiand profile.
  const project = mkdtempSync(join(S, "trusted-project-"));
  const nestedWork = join(project, "nested", "work");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(nestedWork, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
  );
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, ".codex", "config.toml"),
    `model_reasoning_effort = "low"\nmodel_provider = "aiand"\n\n[model_providers.aiand]\nbase_url = ${JSON.stringify(`${projectBaseUrl}/v1`)}\nwire_api = "responses"\n`,
  );

  writeFileSync(requestLog, "");
  writeFileSync(projectRequestLog, "");
  let projectPrinted = "";
  try {
    projectPrinted = execFileSync(
      "codex",
      ["--profile", "aiand", "--strict-config", "exec", "--skip-git-repo-check", "Say hi"],
      {
        env: { ...env, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 180_000,
        cwd: nestedWork,
      },
    );
  } catch (error) {
    fail(`trusted project codex exec failed: ${error.stderr ?? error.message}`);
  }
  await auditProjectOverride(projectPrinted, baseUrl, projectBaseUrl);
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  projectDoubleChild?.kill();
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
