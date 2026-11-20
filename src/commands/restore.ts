import { AGENTS, findAgent } from "../agents/registry.js";
import { discardSnapshot, getRemoteSnapshot, restoreSnapshot } from "../agents/snapshot.js";
import { bool, parse } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, json, out, style } from "../cli/output.js";

export const help = `${style.bold("aiand restore")} -- restore a pre-aiand config snapshot

Usage
  aiand restore <agent> --force

Restores the byte-for-byte snapshot taken before aiand first wired the agent.
For Open WebUI it puts back the instance's OpenAI connection list, keeping
the key the instance holds now for each connection.
This does not run during \`off\`; use \`aiand <agent> off\` to subtract aiand
routing while keeping your edits.

Options
  --force             confirm restore (required)
  --json              machine-readable output
  -h, --help          show this help`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const [name, ...extra] = parsed.positionals;
  if (!name) {
    throw new CliError("Missing agent name.", {
      hint: "Usage: aiand restore <agent> --force",
    });
  }
  if (extra.length > 0) {
    throw new CliError("Restore takes exactly one agent name.", {
      hint: `You passed: ${parsed.positionals.join(" ")}`,
    });
  }

  const adapter = findAgent(name);
  if (!adapter) {
    throw new CliError(`Unknown agent "${name}".`, {
      hint: `Valid agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }

  if (!bool(parsed, "force")) {
    throw new CliError("Restore overwrites current config files.", {
      hint: "Pass --force to restore the pre-aiand snapshot.",
    });
  }

  // An adapter whose managed config is remote restores through its own
  // hook; the snapshot is dropped only after the hook succeeded.
  let warnings: string[] = [];
  let restored: boolean;
  if (adapter.restore) {
    const remote = await getRemoteSnapshot(adapter.id);
    restored = remote !== null;
    if (remote !== null) {
      warnings = await adapter.restore(remote);
      await discardSnapshot(adapter.id);
    }
  } else {
    restored = await restoreSnapshot(adapter.id, adapter.managedFiles());
  }
  if (!restored) {
    throw new CliError(`No snapshot found for ${adapter.label}.`, {
      hint: `Wire ${adapter.label} first with \`aiand init ${adapter.id}\` or \`aiand ${adapter.id} on\`.`,
    });
  }

  if (bool(parsed, "json")) {
    return json({
      agent: adapter.id,
      state: "restored",
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }
  out(`${adapter.label} config restored from snapshot.`);
  for (const warning of warnings) err(style.dim(warning));
}
