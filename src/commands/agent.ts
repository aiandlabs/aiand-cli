import { installCommand, installIfMissing, runAgentBinary } from "../agents/launch.js";
import { AGENTS } from "../agents/registry.js";
import { agentOff, agentOn, agentStatus } from "../agents/setup.js";
import type { AgentAdapter, Verb } from "../agents/types.js";
import { requireSessionKey } from "../auth/session.js";
import { bool, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { agentHome, resolveProfile } from "../config.js";

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

  return `${style.bold(`aiand ${adapter.id}`)} -- ${adapter.label} on ai&

Usage
  aiand [--profile <name>] ${adapter.id} [args…]
  aiand ${adapter.id} on|off|status [options]

  With no verb, aiand opens ${adapter.label} on ai&: it offers to install it
  when it is missing, wires it with \`on\` when it is not wired yet, then
  runs ${adapter.bin} with your args verbatim. Put aiand's own flags before
  the agent name, and \`--\` before an arg that is a verb.

Verbs
  on       wire ${adapter.label} to ai&
  off      remove aiand routing (keeps your edits)
  status   show whether ${adapter.label} is wired to ai&

Options
${flags}

Config files
${files}

Install
  Install it with: ${installCommand(adapter)}
  See: ${adapter.install.url}`;
}

/**
 * `aiand <agent> [on|off|status]`, shared by every agent noun. With no verb
 * (or help) first, every arg is the agent's and the agent opens. `globalArgs`
 * are the flags written before the agent name.
 */
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

  // Help returned above, so the first arg is the verb.
  switch (first as Verb) {
    case "on":
      return runOn(adapter, parsed, jsonOut);
    case "off":
      return runOff(adapter, parsed, jsonOut);
    case "status":
      return runStatus(adapter, jsonOut);
  }
}

/**
 * Open the agent on ai&: install it after a yes, wire it unless it already
 * is, then run the stock binary with `passthrough`. An explicit --profile
 * re-wires, so the agent runs on that profile's org.
 */
async function runOpen(
  adapter: AgentAdapter,
  passthrough: string[],
  globalArgs: string[],
): Promise<void> {
  const profile = str(parse(globalArgs), "profile");
  await installIfMissing(adapter);
  if (profile !== undefined || !(await adapter.probe()).active) {
    const result = await agentOn(adapter, { profile });
    err(style.green(`${adapter.label} is now using ai&.`));
    for (const warning of result.warnings) err(style.dim(warning));
  } else {
    // Opening the session rotates a key in its last days, and the rotation
    // rebakes the wired config before the agent reads it.
    await requireSessionKey();
  }
  const { model, apiUrl } = resolveProfile(profile);
  const launch = (await adapter.wiredLaunch?.({ profileModel: model, baseUrl: apiUrl })) ?? {};
  await runAgentBinary(adapter, [...(launch.args ?? []), ...passthrough], {
    ...process.env,
    ...launch.env,
  });
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
  if (result.note) {
    out(style.dim(result.note));
    return;
  }
  out(`${adapter.label} is off.`);
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
    err(style.dim(`Install it with: ${installCommand(adapter)}  See: ${adapter.install.url}`));
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
