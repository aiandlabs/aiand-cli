import { AGENTS } from "../agents/registry.js";
import {
  type AgentStatusResult,
  agentStatus,
  excludedWarning,
  type OriginCheck,
  originCheck,
} from "../agents/setup.js";
import { authStatus } from "../auth/identity.js";
import { bool, parse, str } from "../cli/args.js";
import { EXIT } from "../cli/errors.js";
import { err, fields, json, out, safeLine, style, styled, table } from "../cli/output.js";
import { stateLabel } from "./agent.js";

export const help = `${style.bold("aiand status")} -- sign-in state at a glance

Usage
  aiand status [options]

Options
  --json              machine-readable output
  --local             read the cached identity without calling the API
  --profile <name>    inspect a specific profile

Exit codes
  0  signed in, or the gateway could not be reached (sign-in unknown,
     so scripts must not treat it as signed out)
  1  not signed in

Shows who you are signed in as, where the active key comes from, which
storage tier holds it, and whether coding agents are wired to ai&.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { local: { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  // --local promises no API call, and the check needs the catalog's origins.
  const check = bool(parsed, "local")
    ? null
    : await originCheck(str(parsed, "profile")).catch(() => null);
  const [auth, agents] = await Promise.all([
    authStatus({
      profile: str(parsed, "profile"),
      local: bool(parsed, "local"),
    }),
    Promise.all(AGENTS.map((adapter) => agentStatus(adapter, check))),
  ]);

  if (bool(parsed, "json")) {
    json({
      auth,
      agents,
      ...(check
        ? { exclude_origin: { profile: check.policy.profile, org: check.policy.org } }
        : {}),
    });
    // Set the exit code and return rather than throw, so stdout stays pure
    // JSON. Only a reachable signed-out profile exits 1.
    if (!auth.signed_in && auth.reachable) process.exitCode = EXIT.ERROR;
    return;
  }

  if (!auth.reachable) {
    // Present-but-unreachable: exit 0 so scripts gating on this command do
    // not false-fail during an outage. The key is unverified, not absent.
    out(style.yellow("Gateway unreachable."));
    err(style.dim("Check your network and retry."));
    printAgents(agents, check);
    return;
  }

  if (!auth.signed_in) {
    out(style.yellow("Not signed in."));
    err(style.dim(auth.reason ? safeLine(auth.reason) : "Run `aiand login` first."));
    printAgents(agents, check);
    process.exitCode = EXIT.ERROR;
    return;
  }

  fields([
    ["email", auth.email || styled(style.dim, "unknown")],
    ["org", auth.org || styled(style.dim, "none")],
    ["profile", auth.profile],
    ["key", styled(style.dim, auth.key ?? "unknown")],
    ["source", styled(style.dim, auth.source ?? "unknown")],
    ["storage", styled(style.dim, auth.storage ?? "unknown")],
  ]);
  if (auth.storage_notice) err(style.yellow(`Note: ${auth.storage_notice}`));

  printAgents(agents, check);
}

function printAgents(agents: AgentStatusResult[], check: OriginCheck | null): void {
  if (agents.length === 0) return;
  out("");
  table(agents, [
    { header: "agent", value: (a) => a.agent },
    { header: "state", value: (a) => stateLabel(a.state) },
    { header: "model", value: (a) => a.model || "—" },
    {
      header: "binary",
      value: (a) =>
        a.installed ? (a.binary ?? "yes") : styled(style.dim, `install: ${installCmd(a)}`),
    },
  ]);
  printExcluded(agents, check);
}

function printExcluded(agents: AgentStatusResult[], check: OriginCheck | null): void {
  if (!check) return;
  for (const agent of agents) {
    const warning = excludedWarning(agent, check.policy);
    if (warning) err(style.yellow(safeLine(warning)));
  }
}

function installCmd(a: AgentStatusResult): string {
  const adapter = AGENTS.find((entry) => entry.id === a.agent);
  return adapter?.install.command ?? "";
}
