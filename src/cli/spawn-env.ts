/**
 * The environment every child process of the CLI runs in.
 *
 * On Windows, cmd.exe tries the current directory before PATH for a bare
 * command, and an npm `.cmd` shim runs a bare `node` whenever no `node.exe`
 * sits beside it (the default Node installer keeps the shims in
 * `%APPDATA%\npm` and node.exe in Program Files, so that is the usual case).
 * Spawning the shim by absolute path therefore does not stop `cd evil-repo &&
 * aiand codex` from running a `node.exe` or `node.cmd` planted in the repo.
 * `NoDefaultCurrentDirectoryInExePath` is the Windows switch that makes
 * cmd.exe skip the current directory for those lookups. It is inherited, so
 * the agent's own children get it too.
 */

/** Windows' opt-out from searching the current directory for programs. */
export const NO_CWD_EXE_VAR = "NoDefaultCurrentDirectoryInExePath";

/** `env` with the current directory ruled out of program lookups on Windows. A
 * copied `process.env` loses Windows' case folding, so any other spelling of
 * the name is dropped rather than left to shadow ours. */
export function withNoCwdExeSearch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== NO_CWD_EXE_VAR.toUpperCase()) next[key] = value;
  }
  next[NO_CWD_EXE_VAR] = "1";
  return next;
}

/** The environment for a child the CLI spawns. */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return withNoCwdExeSearch(env, platform);
}

/** Set the switch on this process at startup, so a spawn that forgets
 * `childEnv` still inherits it. */
export function protectProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") env[NO_CWD_EXE_VAR] = "1";
}

/** Secrets the CLI holds in its own environment; no system tool needs them. */
const SECRET_VARS = ["AIAND_API_KEY", "AIAND_SECRET_STORE_MASTER_KEY"];

/** What a POSIX lookup falls back to when PATH holds no absolute entry. An
 * emptied PATH would not do: execvp reads an empty PATH as the current directory. */
const SAFE_POSIX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** PATH with only its absolute entries. execvp, `which` and `command -v` read
 * an empty, `.` or relative entry as the current directory, so a cloned repo
 * could shadow `open`, `pgrep` or `security` with a file of its own. */
export function absolutePathOnly(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return path ?? "";
  const kept = (path ?? "").split(":").filter((entry) => entry.startsWith("/"));
  return kept.length > 0 ? kept.join(":") : SAFE_POSIX_PATH;
}

/**
 * The environment for a system tool (`which`, `open`, `xdg-open`, `pgrep`,
 * `security`, `secret-tool`, `sqlite3`): childEnv, minus the CLI's own
 * secrets, and on POSIX a PATH of absolute entries only. Agents get childEnv
 * instead, since they need the caller's PATH and key as they are.
 */
export function systemToolEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_VARS.includes(key.toUpperCase())) next[key] = value;
  }
  if (platform !== "win32") {
    const pathKey = Object.keys(next).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    next[pathKey] = absolutePathOnly(next[pathKey]);
  }
  return withNoCwdExeSearch(next, platform);
}
