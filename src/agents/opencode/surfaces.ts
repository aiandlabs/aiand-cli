import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentPathEnv, scrubAgentEnv } from "../../cli/spawn-env.js";
import { resolveWindowsCommand } from "../../cli/win-spawn.js";
import { agentHome, configDir, writeFileAtomic } from "../../config.js";
import { detectBinary } from "../detect.js";
import type { AgentAdapter, DetectResult } from "../types.js";

/**
 * The two OpenCode programs that read one opencode.json, and the background
 * service between them in OpenCode 2.x. Checked against OpenCode Desktop
 * 2.3.0 (macOS) and its bundled CLI, the npm `@opencode/cli` 2.0.28 and
 * 2.3.0, and the npm `opencode-ai` 1.18.32:
 *
 * - `opencode` 1.x (`opencode-ai`) reads the config at every start.
 * - `opencode` 2.x (`@opencode/cli`) and OpenCode Desktop are clients of one
 *   per-user background service (`opencode serve --service`). The service
 *   re-reads opencode.json about a second after it changes, so `on` and
 *   `off` reach both without a restart. A client's OPENCODE_CONFIG_CONTENT
 *   never reaches the shared service; `--standalone` runs a private server
 *   that does read it.
 */

/** True when aiand was pointed at a home of its own (tests, WSL). */
const scoped = (): boolean => Boolean(process.env.AIAND_HOME);

/**
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/...`, on every
 * platform: both OpenCode lines resolve it that way. Under AIAND_HOME the
 * variable describes the real home, so the scoped home wins.
 */
export function opencodeConfigDir(): string {
  const xdg = !scoped() && process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(agentHome(), ".config"), "opencode");
}

/** OpenCode Desktop's app bundle, when installed. Verified on macOS only. */
function desktopAppPath(): string | null {
  if (process.platform !== "darwin") return null;
  const candidates = scoped()
    ? [join(agentHome(), "Applications", "OpenCode.app")]
    : ["/Applications/OpenCode.app", join(agentHome(), "Applications", "OpenCode.app")];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** The two npm packages that ship `opencode`, and the line each carries. */
const OPENCODE_PACKAGES = new Set(["opencode-ai", "@opencode/cli"]);

/**
 * The npm package version behind a resolved `opencode`, read from its
 * package.json without running it: `<pkg>/bin/opencode[.exe]` for both
 * `opencode-ai` (1.x) and `@opencode/cli` (2.x).
 */
function packageMajor(resolved: string): number | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(realpathSync(resolved))), "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== "string" || !OPENCODE_PACKAGES.has(pkg.name)) return null;
    const match = typeof pkg.version === "string" ? /^(\d+)\./.exec(pkg.version) : null;
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** What the last `--version` answered, for the binary file it asked. */
type VersionCache = { path: string; mtimeMs: number; size: number; major: number };

const versionCachePath = (): string => join(configDir(), "opencode-version.json");

/** The answer cached for exactly this file, unchanged since; else undefined. */
async function cachedMajor(stamp: Omit<VersionCache, "major">): Promise<number | undefined> {
  try {
    const cached = JSON.parse(await readFile(versionCachePath(), "utf8")) as VersionCache;
    const same =
      cached.path === stamp.path && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size;
    return same && Number.isInteger(cached.major) ? cached.major : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `opencode --version` ("1.18.32" or "opencode v2.3.0"), for at most a few
 * seconds. The binary is the absolute path detection resolved, never one in
 * the current directory, and its PATH holds absolute entries only, so a
 * `#!/usr/bin/env node` cannot pick up a `node` planted where aiand runs.
 */
function askVersion(bin: string, resolved: string): number | null {
  const env = agentPathEnv(scrubAgentEnv(process.env));
  let command = resolved;
  let args = ["--version"];
  let verbatim = false;
  let runEnv = env;
  if (process.platform === "win32") {
    const windows = resolveWindowsCommand(bin, args, env);
    if (!windows) return null;
    ({ command, args, verbatim } = windows);
    runEnv = windows.env ?? env;
  }
  const run = spawnSync(command, args, {
    env: runEnv,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
  if (run.error || run.status !== 0) return null;
  const match = /(?:^|\s|v)(\d+)\.\d+\.\d+/.exec(run.stdout ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * The major version of the `opencode` on PATH: 1 for `opencode-ai`, 2+ for
 * `@opencode/cli`; null when it cannot tell. npm installs are read from
 * their package.json; anything else (a standalone binary) is asked with
 * `--version`, once per binary file: the answer is kept until the file's
 * path, size or mtime changes. A failed ask is not kept.
 */
export async function terminalMajor(bin: string): Promise<number | null> {
  const resolved = detectBinary(bin).path;
  if (resolved === null) return null;
  const fromPackage = packageMajor(resolved);
  if (fromPackage !== null) return fromPackage;
  let stamp: Omit<VersionCache, "major">;
  try {
    const path = realpathSync(resolved);
    const { mtimeMs, size } = statSync(path);
    stamp = { path, mtimeMs, size };
  } catch {
    return null;
  }
  const cached = await cachedMajor(stamp);
  if (cached !== undefined) return cached;
  const major = askVersion(bin, resolved);
  if (major !== null) {
    await writeFileAtomic(versionCachePath(), JSON.stringify({ ...stamp, major })).catch(() => {});
  }
  return major;
}

/**
 * True unless the terminal `opencode` is known to be 1.x. 1.x is the line
 * that refuses `--standalone`, and every 1.x the CLI installs comes from npm,
 * whose package.json is always read; guessing 1.x for a 2.x install would
 * leave its session on the shared service, which never sees the inline config.
 */
export async function usesSharedService(bin: string): Promise<boolean> {
  const major = await terminalMajor(bin);
  return major === null || major >= 2;
}

/**
 * 2.x subcommands that refuse `--standalone` (`<cmd> --help`, 2.3.0). The
 * TUI and `run`, `mini`, `api`, `models`, `stats`, `session` and `auth`
 * take it, as does a directory for the TUI.
 */
const OTHER_SUBCOMMANDS = new Set([
  "acp",
  "mcp",
  "plugin",
  "debug",
  "service",
  "upgrade",
  "update",
  "uninstall",
]);

/**
 * 2.x options that take a value as the next argument (`opencode --help`,
 * `opencode run --help`, 2.3.0). Their value is never the subcommand.
 */
const VALUE_FLAGS = new Set([
  "--server",
  "--session",
  "-s",
  "--prompt",
  "--model",
  "-m",
  "--agent",
  "--format",
  "--file",
  "-f",
  "--title",
  "--log-level",
  "--completions",
]);

/** The args without `--server <url>` / `--server=<url>`, as the launcher strips them. */
export function withoutServer(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--server") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (arg.startsWith("--server=")) continue;
    out.push(arg);
  }
  return out;
}

/** The first positional argument, skipping the values of known options. */
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args[i + 1];
    if (!arg.startsWith("-")) return arg;
    if (VALUE_FLAGS.has(arg)) i += 1;
  }
  return undefined;
}

/**
 * `--standalone` for a 2.x launch whose routing rides OPENCODE_CONFIG_CONTENT
 * or a just-written config: the shared service would ignore the first and
 * may predate the second. Nothing when the args already choose a server, or
 * run a subcommand that takes no `--standalone`.
 */
export function standaloneArgs(args: string[]): string[] {
  if (
    args.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="))
  ) {
    return [];
  }
  // The first positional is a subcommand, or the directory the TUI opens;
  // only the subcommands that refuse --standalone get nothing.
  const first = firstPositional(args);
  if (first !== undefined && OTHER_SUBCOMMANDS.has(first)) return [];
  return ["--standalone"];
}

/**
 * Config for one run, through OPENCODE_CONFIG_CONTENT. OpenCode 2.x clients
 * use the shared background service, which never sees this process's
 * environment; a private server (`--standalone`) does. 1.x refuses the flag
 * and needs none.
 */
export async function inlineConfig(
  bin: string,
  config: Record<string, unknown>,
  args: string[],
): Promise<{ args: string[]; env: Record<string, string> }> {
  return {
    args: (await usesSharedService(bin)) ? standaloneArgs(args) : [],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  };
}

/** The adapter members that tell the terminal program and the desktop app apart. */
export function opencodeSurfaces(
  bin: string,
): Pick<AgentAdapter, "helpScope" | "detect" | "surfaces" | "appOnlyOpen"> {
  return {
    helpScope:
      "Which OpenCode: on, off and status act on opencode.json, which the terminal `opencode` and OpenCode Desktop both read. `aiand opencode` and `aiand code` run the terminal `opencode` only; they never open the app (with only the app installed, they wire it and say how to reload it). `aiand run-agent opencode` is terminal only too. OpenCode 2.x and Desktop share a background service that picks up a changed opencode.json within a few seconds, so on and off reach an open Desktop window without a restart.",
    detect(): DetectResult {
      // Either program counts: `on` wires the config both of them read.
      const terminal = detectBinary(bin);
      if (terminal.installed) return terminal;
      const app = desktopAppPath();
      return app ? { installed: true, path: app } : terminal;
    },
    surfaces() {
      return [
        { name: "terminal", path: detectBinary(bin).path },
        ...(process.platform === "darwin" ? [{ name: "desktop", path: desktopAppPath() }] : []),
      ];
    },
    appOnlyOpen() {
      // Desktop without the terminal program: `open` wires, then says how
      // the app picks the config up. aiand never launches the app.
      if (detectBinary(bin).installed || !desktopAppPath()) return undefined;
      return "OpenCode Desktop picks this up within a few seconds, even while it is open. aiand does not launch the app: open OpenCode Desktop and pick an ai& model in its model menu.";
    },
  };
}
