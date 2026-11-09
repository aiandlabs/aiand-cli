import { agentBaseEnv, installIfMissing, runAgentBinary } from "../agents/launch.js";
import { AGENTS } from "../agents/registry.js";
import { agentOff, agentOn, agentStatus } from "../agents/setup.js";
import type { AgentAdapter, Verb } from "../agents/types.js";
import { requireSessionKey } from "../auth/session.js";
import { bool, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { agentHome, resolveProfile } from "../config.js";
import { run as runSession } from "./run-agent.js";

const VERBS: Verb[] = ["on", "off", "status"];

export function agentHelp(adapter: AgentAdapter): string {
  const flags = [
    "      --model <id>        model to route (default: catalog preferred)",
    "      --force             escape quit-guards when the app holds config in memory",
    "      --json              machine-readable output",
    "      --profile <name>    use a stored profile",
    "      --base-url <url>    point at a different API endpoint",
    "  -h, --help              show this help",
  ].join("\n");

  const files = adapter
    .managedFiles()
    .map((file) => `  ${file.replace(agentHome(), "~")}`)
    .join("\n");

  const openUsage = adapter.configOnly
    ? `  aiand [--profile <name>] ${adapter.id}`
    : `  aiand [--profile <name>] ${adapter.id} [args…]`;
  const openPara = adapter.openLaunchesSession
    ? `  When you run \`aiand ${adapter.id}\` on its own, it starts one ${adapter.label} session on ai&. Your other ${adapter.label} windows stay as they are. If ${adapter.label} is not installed, aiand shows the install command (and runs npm installs if you say yes). Your args go straight to ${adapter.bin}. Put aiand's own flags before "${adapter.id}", and put \`--\` before an arg that is also an aiand command (on, off, status). To send every ${adapter.bin} through ai&, use \`aiand ${adapter.id} on\`.`
    : adapter.configOnly
      ? `  When you run \`aiand ${adapter.id}\` on its own, it sets up ${adapter.label} to use ai&. If ${adapter.label} is not installed, aiand shows the install command (and runs npm installs if you say yes). Then open the GitHub Copilot app yourself and pick the ai& model in its model menu.`
      : `  When you run \`aiand ${adapter.id}\` on its own, it opens ${adapter.label} on ai&. If ${adapter.label} is not installed, aiand shows the install command (and runs npm installs if you say yes). If it is not set up for ai& yet, aiand runs \`aiand ${adapter.id} on\` first. Your args go straight to ${adapter.bin}. Put aiand's own flags before "${adapter.id}", and put \`--\` before an arg that is also an aiand command (on, off, status).`;
  return `${style.bold(`aiand ${adapter.id}`)} -- ${adapter.label} on ai&

Usage
${openUsage}
  aiand ${adapter.id} on|off|status [options]

${openPara}

Verbs
  on       wire ${adapter.label} to ai&
  off      remove aiand routing (keeps your edits)
  status   show whether ${adapter.label} is wired to ai&

Options
${flags}

${files === "" ? "" : `Config files\n${files}\n\n`}Install
  Install it with: ${adapter.install.command}
  See: ${adapter.install.url}`;
}

export async function runAgentCommand(
  adapter: AgentAdapter,
  argv: string[],
  globalArgs: string[] = [],
): Promise<void> {
  const [first] = argv;
  if (first !== "-h" && first !== "--help" && !VERBS.includes(first as Verb)) {
    return runOpen(adapter, first === "--" ? argv.slice(1) : argv, globalArgs);
  }

  // Only agent-specific flags here; json/profile/base-url/help come from
  // GLOBAL_OPTIONS so `-h` keeps its short (see args.ts preserve-short).
  const options = {
    model: { type: "string" },
    force: { type: "boolean", default: false },
  } as const;
  const parsed = parse([...argv, ...globalArgs], options);

  if (bool(parsed, "help")) return out(agentHelp(adapter));

  if (parsed.positionals.length > 1) {
    throw new CliError("Agent command takes at most one verb.", {
      hint: `You passed: ${parsed.positionals.join(" ")}\nVerbs: on, off, status`,
    });
  }
  const jsonOut = bool(parsed, "json");

  switch (first as Verb) {
    case "on":
      return runOn(adapter, parsed, jsonOut);
    case "off":
      return runOff(adapter, parsed, jsonOut);
    case "status":
      return runStatus(adapter, jsonOut);
  }
}

async function runOpen(
  adapter: AgentAdapter,
  passthrough: string[],
  globalArgs: string[],
): Promise<void> {
  const target = parse(globalArgs);
  const profile = str(target, "profile");
  const retarget = profile !== undefined || str(target, "base-url") !== undefined;
  await installIfMissing(adapter);
  if (adapter.openLaunchesSession) {
    const flags = ["profile", "base-url"].flatMap((flag) => {
      const value = str(target, flag);
      return value === undefined ? [] : [`--${flag}`, value];
    });
    return runSession([adapter.id, ...flags, "--", ...passthrough]);
  }
  if (retarget || !(await adapter.probe()).active) {
    const result = await agentOn(adapter, { profile });
    err(style.green(`${adapter.label} is now using ai&.`));
    for (const warning of result.warnings) err(style.dim(warning));
  } else {
    await requireSessionKey();
  }
  if (adapter.configOnly) {
    if (passthrough.length > 0) {
      throw new CliError(
        `The ${adapter.label} is a desktop app; aiand wires it but cannot launch it.`,
        {
          hint: "aiand copilot runs the GitHub Copilot CLI.",
        },
      );
    }
    out("Open the GitHub Copilot app and pick the ai& model in its model menu.");
    return;
  }
  const extras =
    (await adapter.openExtras?.({
      args: passthrough,
      profileModel: resolveProfile(profile).model,
    })) ?? {};
  // Same precedent as run-agent.ts: the adapter injection carries the key, so the spawn env starts scrubbed.
  const env = agentBaseEnv(adapter);
  // Same drop as run-agent: names the adapter lists would outrank the
  // config `on` just wrote (Hermes reads ANTHROPIC_* / OPENAI_* over its files).
  for (const key of adapter.shadowEnv ?? []) delete env[key];
  Object.assign(env, extras.env);
  await runAgentBinary(adapter, [...(extras.args ?? []), ...passthrough], env);
}

async function runOn(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  const result = await agentOn(adapter, {
    model: str(parsed, "model"),
    force: bool(parsed, "force"),
    profile: str(parsed, "profile"),
  });

  if (jsonOut) {
    return json(result);
  }
  out(style.green(`${adapter.label} is now using ai&.`));
  fields([
    ["agent", result.agent],
    ["model", result.model],
    ["files", result.files.join(", ")],
  ]);
  for (const warning of result.warnings ?? []) {
    err(style.dim(warning));
  }
}

async function runOff(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  const result = await agentOff(adapter, { force: bool(parsed, "force") });
  if (jsonOut) {
    return json(result);
  }
  out(result.note ? style.dim(result.note) : `${adapter.label} is off.`);
  for (const warning of result.warnings ?? []) err(style.dim(warning));
}

async function runStatus(adapter: AgentAdapter, jsonOut: boolean): Promise<void> {
  const result = await agentStatus(adapter);
  if (jsonOut) {
    return json(result);
  }

  const modelLabel: string = result.model ?? style.dim("—");
  fields([
    ["agent", result.agent],
    ["installed", result.installed ? (result.binary ?? style.dim("yes")) : style.dim("no")],
    ["state", stateLabel(result.state)],
    ["model", modelLabel],
  ]);
  if (!result.installed) {
    err(style.dim(`Install it with: ${adapter.install.command}  See: ${adapter.install.url}`));
  }
}

/**
 * Registered agents whose real config probes as aiand-routed. Launcher-only
 * adapters are never wired by `on`, so they are never routed. A probe that
 * throws is either counted (`"include"`: `init --off` then attempts `off` and
 * reports that agent's failure instead of aborting the batch) or ignored
 * (`"exclude"`: an unreadable config does not block a profile switch).
 */
export async function routedAgents(probeFailure: "include" | "exclude"): Promise<AgentAdapter[]> {
  const routed: AgentAdapter[] = [];
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;
    try {
      if ((await adapter.probe()).active) routed.push(adapter);
    } catch {
      if (probeFailure === "include") routed.push(adapter);
    }
  }
  return routed;
}

/** Colored on/off for an agent's routing state (agent status and aiand status). */
export function stateLabel(state: "on" | "off"): string {
  switch (state) {
    case "on":
      return style.green("on");
    case "off":
      return style.dim("off");
  }
}
