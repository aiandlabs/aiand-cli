import { AGENTS } from "../agents/registry.js";
import { type AgentStatusResult, agentStatus } from "../agents/setup.js";
import type { AgentAdapter } from "../agents/types.js";
import { authStatus } from "../auth/identity.js";
import { bool, parse, str } from "../cli/args.js";
import { EXIT } from "../cli/errors.js";
import { err, fields, json, out, style, table } from "../cli/output.js";
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

  const [auth, agents] = await Promise.all([
    authStatus({
      profile: str(parsed, "profile"),
      local: bool(parsed, "local"),
    }),
    Promise.all(AGENTS.map((adapter) => agentStatusRow(adapter))),
  ]);

  if (bool(parsed, "json")) {
    json({ auth, agents });
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
    printAgents(agents);
    return;
  }

  if (!auth.signed_in) {
    out(style.yellow("Not signed in."));
    err(style.dim("Run `aiand login` first."));
    printAgents(agents);
    process.exitCode = EXIT.ERROR;
    return;
  }

  fields([
    ["email", auth.email ?? style.dim("unknown")],
    ["org", auth.org ?? style.dim("none")],
    ["profile", auth.profile],
    ["key", style.dim(auth.key ?? "unknown")],
    ["source", style.dim(auth.source ?? "unknown")],
    ["storage", style.dim(auth.storage ?? "unknown")],
  ]);

  printAgents(agents);
}

/**
 * One agent's row. A probe that cannot answer (an Open WebUI instance that is
 * down, or no admin key to ask it with) reads `unknown` with the reason,
 * never aborting the whole status.
 */
type AgentStatusRow = Omit<AgentStatusResult, "state"> & {
  state: AgentStatusResult["state"] | "unknown";
  error?: string;
};

async function agentStatusRow(adapter: AgentAdapter): Promise<AgentStatusRow> {
  try {
    return await agentStatus(adapter);
  } catch (error) {
    const detected = adapter.detect();
    return {
      agent: adapter.id,
      installed: detected.installed,
      binary: detected.path,
      state: "unknown",
      model: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printAgents(agents: AgentStatusRow[]): void {
  if (agents.length === 0) return;
  out("");
  table(agents, [
    { header: "agent", value: (a) => a.agent },
    {
      header: "state",
      value: (a) => (a.state === "unknown" ? style.yellow("unknown") : stateLabel(a.state)),
    },
    { header: "model", value: (a) => a.model ?? "—" },
    {
      header: "binary",
      value: (a) => (a.installed ? (a.binary ?? "yes") : style.dim(`install: ${installCmd(a)}`)),
    },
  ]);
  for (const agent of agents) {
    if (agent.error) err(style.dim(`${agent.agent}: ${agent.error}`));
  }
}

function installCmd(a: AgentStatusRow): string {
  const adapter = AGENTS.find((entry) => entry.id === a.agent);
  return adapter?.install.command ?? "";
}
