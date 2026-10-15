import { spawnSync } from "node:child_process";
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
// private server: `--standalone`. The flag goes after these subcommands and
// first for the TUI; the other subcommands take no flag and keep their argv.
const STANDALONE_SUBCOMMANDS = new Set(["run", "mini", "stats", "api"]);
const SERVICE_ONLY_SUBCOMMANDS = new Set([
  "upgrade",
  "update",
  "uninstall",
  "acp",
  "debug",
  "auth",
  "mcp",
  "plugin",
  "models",
  "session",
  "service",
]);

/** The argv that makes OpenCode `major` read config from the launch env. */
export function opencodeArgv(major: number | null, passthrough: string[]): string[] {
  if (major === null || major < 2) return passthrough;
  if (
    passthrough.some(
      (arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="),
    )
  )
    return passthrough;
  const [first, ...rest] = passthrough;
  if (first !== undefined && STANDALONE_SUBCOMMANDS.has(first))
    return [first, "--standalone", ...rest];
  if (first !== undefined && SERVICE_ONLY_SUBCOMMANDS.has(first)) return passthrough;
  return ["--standalone", ...passthrough];
}
