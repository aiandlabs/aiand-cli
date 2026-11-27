// Live OMP smoke: the only proof stubs cannot give — a real pinned `omp`
// binary accepting the config `aiand omp on` generates (models.yml is
// schema-validated upstream, so provider drift breaks here first), a
// headless -p round-trip through the loopback mock gateway, and `off`
// putting the seeded user files back byte-identical.
//
// Run by CI after scripts/e2e.mjs (the build job installs the pinned omp
// release asset, digest-checked). No real gateway, no key: the loopback double
// serves /v1/models and /v1/chat/completions, per the repo rule that
// CLI-error coverage drives through the mock gateway.
//
// Requires: dist/index.js built, `omp` on PATH. Exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSmokeDouble } from "./smoke-double.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist", "index.js");

const S = mkdtempSync(join(tmpdir(), "aiand-omp-smoke-"));
const requestLog = join(S, "requests.jsonl");
let doubleChild;
let failed = false;

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  failed = true;
}

function auditRequests(expectedModel, label) {
  let rawLog;
  try {
    rawLog = readFileSync(requestLog, "utf8");
    const requests =
      rawLog.trim() === ""
        ? []
        : rawLog
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
    if (requests.length > 0 && requests.every((row) => row?.model === expectedModel)) {
      process.stdout.write(`PASS ${label}\n`);
    } else {
      fail(
        `${label}: request log must contain only ${expectedModel} requests:\n${rawLog || "(empty request log)"}`,
      );
    }
  } catch (error) {
    fail(
      `${label}: request-log audit failed: ${error.message}${rawLog === undefined ? "" : `:\n${rawLog}`}`,
    );
  }
}

try {
  const double = await startSmokeDouble(S, { logPath: requestLog });
  doubleChild = double.child;
  const { baseUrl } = double;

  const home = join(S, "home");
  const cfg = join(S, "cfg");
  // Seed the user's own omp files so `off` has real bytes to restore and
  // `on` has unrelated keys and comments to preserve.
  const ompAgentDir = join(home, ".omp", "agent");
  mkdirSync(ompAgentDir, { recursive: true });
  const ompModelsPath = join(ompAgentDir, "models.yml");
  const ompConfigPath = join(ompAgentDir, "config.yml");
  writeFileSync(
    ompModelsPath,
    "# user's own providers, kept by aiand\nproviders:\n  openai:\n    baseUrl: https://api.openai.com/v1\n    apiKey: sk-user-openai\n",
  );
  writeFileSync(
    ompConfigPath,
    "symbolPreset: unicode\nmodelRoles:\n  default: anthropic/claude-haiku-4-5\n",
  );
  const modelsBefore = readFileSync(ompModelsPath);
  const configBefore = readFileSync(ompConfigPath);

  const env = {
    ...process.env,
    HOME: home,
    AIAND_HOME: home,
    AIAND_CONFIG_DIR: cfg,
    AIAND_API_KEY: "sk-e2e-omp-smoke-key-0000000000000000",
    AIAND_BASE_URL: baseUrl,
    // The real omp, never a stub. HOME points at the sandbox so omp reads
    // the config aiand omp on wrote (~/.omp/agent under it).
    PATH: process.env.PATH,
  };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  // omp renames its .omp root with PI_CONFIG_DIR: a contributor-exported
  // value would retarget the seeded files the byte comparisons below read.
  delete env.PI_CONFIG_DIR;

  // 1. Wire with the real CLI.
  const on = JSON.parse(
    execFileSync(process.execPath, [DIST, "omp", "on", "--json"], { env, encoding: "utf8" }),
  );
  if (on.state === "on") process.stdout.write("PASS aiand omp on\n");
  else fail(`aiand omp on: ${JSON.stringify(on)}`);

  // 2. The real omp accepts our generated models.yml and round-trips. Its
  // bundled ladder decides the effort, so any value proves the route.
  try {
    writeFileSync(requestLog, "");
    const printed = execFileSync(
      "omp",
      ["--model", "aiand/zai-org/glm-5.3", "--no-session", "-p", "Say hi"],
      { env: { ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 180_000 },
    );
    if (/echo:zai-org\/glm-5\.3:effort=\w+/.test(printed))
      process.stdout.write("PASS omp -p routes through the gateway\n");
    else fail(`omp -p round-trip did not echo the routed model:\n${printed}`);
  } catch (error) {
    fail(`omp -p round-trip failed: ${error.stderr ?? error.message}`);
  }

  // 3. Audit every completion call, including any background calls.
  auditRequests("zai-org/glm-5.3", "omp -p request model audit");

  // 4. Off puts the seeded files back byte-identical.
  const off = JSON.parse(
    execFileSync(process.execPath, [DIST, "omp", "off", "--json"], { env, encoding: "utf8" }),
  );
  if (off.state !== "off") fail(`aiand omp off: ${JSON.stringify(off)}`);
  else if (
    !modelsBefore.equals(readFileSync(ompModelsPath)) ||
    !configBefore.equals(readFileSync(ompConfigPath))
  )
    fail("aiand omp off did not restore the seeded files byte-identical");
  else process.stdout.write("PASS aiand omp off restores the seeded files byte-identical\n");
} catch (error) {
  fail(String(error.stderr ?? error.message ?? error));
} finally {
  doubleChild?.kill();
  rmSync(S, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
