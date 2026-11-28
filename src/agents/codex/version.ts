// Probe Codex compatibility without loading its config or passing aiand credentials.
import { spawnSync } from "node:child_process";
import { systemToolEnv } from "../../cli/spawn-env.js";
import { resolveWindowsCommand } from "../../cli/win-spawn.js";
import { findOnPath } from "../detect.js";

/** Known stable/alpha builds before 0.174.0-alpha.6 reject statsig_gates.
 * Unknown version formats keep the explicit disable, rather than guessing. */
export function predatesStatsigGates(output: string | null): boolean {
  const match =
    /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/.exec(
      output?.trim() ?? "",
    );
  if (match === null) return false;
  const [, major, minor, patch, alpha] = match;
  return (
    major === "0" &&
    (Number(minor) < 174 ||
      (minor === "174" && patch === "0" && alpha !== undefined && Number(alpha) < 6))
  );
}

function versionCommand(): ReturnType<typeof resolveWindowsCommand> {
  const env = systemToolEnv();
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand("codex", ["--version"], env);
    return resolved === null ? null : { ...resolved, env: resolved.env ?? env };
  }
  const path = findOnPath("codex");
  return path === null ? null : { command: path, args: ["--version"], env, verbatim: false };
}

/** Only a successful probe of a recognized old version may omit the disable. */
export function codexPredatesStatsigGates(): boolean {
  const run = versionCommand();
  if (run === null) return false;
  try {
    const probe = spawnSync(run.command, run.args, {
      env: run.env,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      windowsVerbatimArguments: run.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return !probe.error && probe.status === 0 && predatesStatsigGates(probe.stdout);
  } catch {
    return false;
  }
}
