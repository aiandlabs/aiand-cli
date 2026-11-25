import { AGENTS, findAgent } from "../agents/registry.js";
import { restoreSnapshot } from "../agents/snapshot.js";
import { forgetWired } from "../agents/wired.js";
import { bool, parse } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { json, out, style } from "../cli/output.js";

export const help = `${style.bold("aiand restore")} -- restore a pre-aiand config snapshot

Usage
  aiand restore <agent> --force

Restores the byte-for-byte snapshot taken before aiand first wired the agent.
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

  const wired: string[] = [];
  const unmanaged: string[] = [];
  const restored = await restoreSnapshot(
    adapter.id,
    adapter.managedFiles(),
    (path, reason) => (reason === "wired" ? wired : unmanaged).push(path),
    adapter.carriesWiring?.bind(adapter),
  );
  if (!restored) {
    throw new CliError(`No snapshot found for ${adapter.label}.`, {
      hint: `Wire ${adapter.label} first with \`aiand init ${adapter.id}\` or \`aiand ${adapter.id} on\`.`,
    });
  }

  await forgetWired(adapter.id);

  if (bool(parsed, "json")) {
    return json({
      agent: adapter.id,
      state: "restored",
      ...(wired.length > 0 ? { not_captured: wired } : {}),
      ...(unmanaged.length > 0 ? { kept: unmanaged } : {}),
    });
  }
  out(`${adapter.label} config restored from snapshot.`);
  for (const path of wired) {
    out(
      style.dim(
        `${path} already held ai& wiring when it was captured, so it has no copy; run aiand ${adapter.id} off to strip it.`,
      ),
    );
  }
  for (const path of unmanaged) {
    out(
      style.dim(
        `${path} is not where ${adapter.label} reads its config now; its copy stays in the snapshot. Restore again from a shell that points ${adapter.label} there.`,
      ),
    );
  }
}
