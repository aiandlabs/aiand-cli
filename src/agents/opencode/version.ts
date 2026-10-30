import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolveWindowsCommand } from "../../cli/win-spawn.js";

export const OPENCODE_BIN = "opencode";

export const OPENCODE_V1_WARNING =
  "OpenCode 1 is installed. ai& supports OpenCode 2, and OpenCode 1 gets no more fixes. Upgrade with: opencode upgrade --major";

/**
 * The installed OpenCode's major version from `opencode --version`
 * ("opencode v2.0.29" on 2, "1.18.32" on 1), or null when it cannot be read.
 */
export function opencodeMajorVersion(): number | null {
  const env = { ...process.env };
  delete env.AIAND_API_KEY;
  const resolved =
    process.platform === "win32"
      ? resolveWindowsCommand(OPENCODE_BIN, ["--version"], env)
      : { command: OPENCODE_BIN, args: ["--version"], verbatim: false };
  if (!resolved) return null;
  const probe = spawnSync(resolved.command, resolved.args, {
    env,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    windowsVerbatimArguments: resolved.verbatim,
  });
  const match = probe.status === 0 ? /(\d+)\.\d+\.\d+/.exec(probe.stdout ?? "") : null;
  return match ? Number(match[1]) : null;
}

// OpenCode 2 runs sessions in a background service that does not see the
// launching shell's environment, so OPENCODE_CONFIG_CONTENT only reaches a
// private server: `--standalone`. Where the flag parses (measured on 2.0.29):
// after these command words; after the second word for auth and session; first
// for the TUI. The rest reject it, and mcp, plugin, debug and pair start the
// background service when none runs, which would then serve the inline config
// to the user's later plain `opencode`: they, and any command not listed here,
// run without the config. serve is that server, in the foreground: it keeps the
// config and takes no flag.
const AFTER_COMMAND = new Set(["run", "mini", "stats", "api", "models", "reload"]);
const AFTER_SUBCOMMAND = new Set(["auth", "session"]);
const NO_CONFIG_COMMANDS = new Set([
  "mcp",
  "plugin",
  "debug",
  "pair",
  "acp",
  "service",
  "upgrade",
  "update",
  "uninstall",
]);
// Flags before the command word that take the next word as their value.
const VALUE_FLAGS = new Set(["--log-level", "--completions", "--session", "-s", "--prompt"]);

/** The argv that makes OpenCode `major` read config from the launch env, and whether it gets that env. */
export function opencodeLaunch(
  major: number | null,
  passthrough: string[],
): { args: string[]; keepEnv: boolean } {
  const keep = { args: passthrough, keepEnv: true };
  if (major === null || major < 2) return keep;
  if (
    passthrough.some(
      (arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="),
    )
  )
    return keep;
  let at = 0;
  while (at < passthrough.length && passthrough[at]!.startsWith("-")) {
    at += VALUE_FLAGS.has(passthrough[at]!) ? 2 : 1;
  }
  const word = passthrough[at];
  const insertAt = (index: number) => ({
    args: [...passthrough.slice(0, index), "--standalone", ...passthrough.slice(index)],
    keepEnv: true,
  });
  const tui = { args: ["--standalone", ...passthrough], keepEnv: true };
  const noConfig = { args: passthrough, keepEnv: false };
  if (word === undefined) return tui;
  if (AFTER_COMMAND.has(word)) return insertAt(at + 1);
  if (AFTER_SUBCOMMAND.has(word)) {
    // With no subcommand, auth and session print their help.
    const sub = passthrough[at + 1];
    return sub === undefined || sub.startsWith("-") ? noConfig : insertAt(at + 2);
  }
  if (word === "serve") return keep;
  if (NO_CONFIG_COMMANDS.has(word)) return noConfig;
  // A directory to open the TUI in; any other word may be a command this
  // release does not know, so it runs without the config.
  return statSync(word, { throwIfNoEntry: false })?.isDirectory() ? tui : noConfig;
}
