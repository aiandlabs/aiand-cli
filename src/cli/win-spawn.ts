import { spawnSync } from "node:child_process";
import { extname } from "node:path";

/**
 * Windows spawn resolution for agent binaries. Node's `spawn` without a shell
 * only finds `.exe`/`.com` on PATH, but npm installs agents as `.cmd` shims
 * (`opencode.cmd`), and since the CVE-2024-27980 fix a `.cmd` cannot be
 * spawned directly at all. Batch files therefore go through `cmd.exe` with
 * every token escaped the way cross-spawn does, so user passthrough stays
 * literal: nothing in an argument is re-parsed as shell syntax.
 */

// cmd.exe metacharacters; each is neutralized with a caret.
const META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for the MSVCRT parser, then caret-escape it for cmd.exe. */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let quoted = arg
    // Double the backslashes before a quote, then escape the quote.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Double trailing backslashes so they do not escape the closing quote.
    .replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`.replace(META, "^$1");
  // A shim re-expands `%*` in a second cmd.exe parse, which eats one caret layer.
  return doubleEscape ? quoted.replace(META, "^$1") : quoted;
}

/** The `cmd.exe /d /s /c` argv that runs batch `file` with `args` verbatim. */
export function cmdShimArgv(file: string, args: string[]): string[] {
  const line = [file.replace(META, "^$1"), ...args.map((arg) => escapeCmdArgument(arg, true))].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

/**
 * Resolve `bin` against PATH/PATHEXT (via `where`) and return what to spawn.
 * Returns null when nothing matches, so the caller reports a missing binary.
 */
export function resolveWindowsCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; verbatim: boolean } | null {
  const probe = spawnSync("where", [bin], { env, encoding: "utf8", windowsHide: true });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return null;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";");
  // `where` also lists the extensionless sh shim npm writes for Git Bash; skip
  // anything Windows itself cannot execute.
  const file = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && exts.includes(extname(line).toLowerCase()));
  if (!file) return null;
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return { command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: cmdShimArgv(file, args), verbatim: true };
  }
  return { command: file, args, verbatim: false };
}
