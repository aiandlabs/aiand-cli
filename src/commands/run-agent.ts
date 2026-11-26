import { getCatalog, servedModelId, validateCatalogModel } from "../agents/catalog.js";
import {
  agentBaseEnv,
  notInstalledError,
  runAgentBinary,
  takeFlagValues,
} from "../agents/launch.js";
import { STALE_OVERLAY_MS, sweepOverlays } from "../agents/overlays.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { assertFastModelFlag } from "../agents/setup.js";
import type { AgentAdapter } from "../agents/types.js";
import type { Model } from "../api/models.js";
import { requireSessionKey } from "../auth/session.js";
import { CliError, EXIT } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { assertHttpsBaseUrl, assertNoV1Suffix, resolveProfile } from "../config.js";

// Aligns agent labels with the Options column below.
const HELP_ID_WIDTH = 28;

export const help = `${style.bold("aiand run-agent")} -- run a coding agent on ai& for one session

Usage
  aiand run-agent <agent> [--model <id>] [--fast-model <id>] [--] [args…]

Agents
${AGENTS.map((a) => `  ${a.id.padEnd(HELP_ID_WIDTH)} ${a.id === "opencode" ? "OpenCode (terminal only, not OpenCode Desktop)" : a.label}`).join("\n")}

Options
      --model <id>       model from the catalog for every model the agent uses
                         (default: the agent's own)
      --fast-model <id>  a separate model for background calls (Claude Code)
      --profile <name>   use a stored profile
      --base-url <url>   point at a different API endpoint
  -h, --help             show this help

Everything after \`--\` (and any bare positional before it) is passed to the
agent's binary as-is, except the routing flags the adapter owns — those are
stripped so the injected wiring cannot be overridden. The agent's own model
flag (--model) there counts as --model above.

Try: aiand run-agent opencode -- --version`;

type Invocation = {
  agent: string | undefined;
  model: string | undefined;
  fastModel: string | undefined;
  profile: string | undefined;
  baseUrl: string | undefined;
  help: boolean;
  passthrough: string[];
};

/**
 * Split raw argv without the strict parse() (the trailing args must reach the
 * agent's binary byte-for-byte, including unknown flags). The first `--` is
 * the hard boundary: everything before it is ours unless we don't recognize
 * it (then it is prepended to the passthrough), everything after is
 * passthrough verbatim.
 */
function splitInvocation(argv: string[]): Invocation {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);

  let agent: string | undefined;
  let model: string | undefined;
  let fastModel: string | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let help = false;
  const prepend: string[] = [];

  let i = 0;
  while (i < head.length) {
    const token = head[i]!;
    if (agent === undefined && !token.startsWith("-")) {
      agent = token;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      i += 1;
    } else if (token === "--model") {
      model = takeValue(head, i, "--model");
      i += 2;
    } else if (token.startsWith("--model=")) {
      model = inlineValue(token, "--model");
      i += 1;
    } else if (token === "--fast-model") {
      fastModel = takeValue(head, i, "--fast-model");
      i += 2;
    } else if (token.startsWith("--fast-model=")) {
      fastModel = inlineValue(token, "--fast-model");
      i += 1;
    } else if (token === "--profile") {
      profile = takeValue(head, i, "--profile");
      i += 2;
    } else if (token.startsWith("--profile=")) {
      profile = inlineValue(token, "--profile");
      i += 1;
    } else if (token === "--base-url") {
      baseUrl = takeValue(head, i, "--base-url");
      i += 2;
    } else if (token.startsWith("--base-url=")) {
      baseUrl = inlineValue(token, "--base-url");
      i += 1;
    } else {
      // Anything unrecognized before the separator (flags we don't own, bare
      // positionals) is still the agent's, prepended ahead of the tail args.
      prepend.push(token);
      i += 1;
    }
  }

  return { agent, model, fastModel, profile, baseUrl, help, passthrough: [...prepend, ...tail] };
}

/**
 * The session's models, with the agent's own model flag in the passthrough
 * counted as --model: left there, an adapter that owns the flag would drop
 * it, and one that does not would pass it to an agent whose other model
 * slots stay on our defaults. A value the agent resolves itself
 * (Claude Code's `opus`) stays in the passthrough.
 */
function launchModels(
  adapter: AgentAdapter,
  catalog: Model[],
  split: Pick<Invocation, "model" | "fastModel" | "passthrough">,
): { model: string | undefined; fastModel: string | undefined; passthrough: string[] } {
  const flags = adapter.launchModelFlags ?? [];
  const owned = adapter.fastModelFlag ? [...flags, "--fast-model"] : flags;
  // An empty inline value would otherwise drop out and leave the default model.
  for (const token of split.passthrough) {
    const flag = owned.find((name) => token === `${name}=`);
    if (flag !== undefined) throw new CliError(`${flag} needs a value.`);
  }
  const keep = (value: string): boolean => adapter.passesLaunchModel?.(value) === true;
  const lifted = takeFlagValues(split.passthrough, flags, keep);
  const fast = adapter.fastModelFlag
    ? takeFlagValues(lifted.rest, ["--fast-model"])
    : { values: [], rest: lifted.rest };
  const pick = (given: string | undefined, values: string[], flag: string): string | undefined => {
    let chosen = given;
    for (const value of values.map((v) => servedModelId(catalog, v))) {
      if (chosen !== undefined && chosen !== value) {
        throw new CliError(`${flag} was given twice: ${chosen} and ${value}.`, {
          hint: `Pass ${flag} once.`,
        });
      }
      chosen = value;
    }
    return chosen;
  };
  return {
    model: pick(split.model, lifted.values, "--model"),
    fastModel: pick(split.fastModel, fast.values, "--fast-model"),
    passthrough: fast.rest,
  };
}

function takeValue(head: string[], i: number, name: string): string {
  const value = head[i + 1];
  if (value === undefined) throw new CliError(`${name} needs a value.`);
  return value;
}

function inlineValue(token: string, name: string): string {
  const value = token.slice(name.length + 1);
  if (!value) throw new CliError(`${name} needs a value.`);
  return value;
}

export async function run(argv: string[]): Promise<void> {
  const split = splitInvocation(argv);
  if (split.help) {
    out(help);
    return;
  }
  if (split.baseUrl !== undefined) {
    assertHttpsBaseUrl(split.baseUrl);
    // Like `--base-url` at parse time (args.ts) and `config set api-url`:
    // adapters append /v1 themselves, so a suffixed URL doubles to
    // /v1/v1/... and the gateway misdiagnoses it as an expired key.
    assertNoV1Suffix(split.baseUrl);
    process.env.AIAND_BASE_URL = split.baseUrl;
  }

  const agentName = split.agent;
  if (!agentName) {
    throw new CliError("run-agent needs a coding agent name.", {
      hint: "Usage: aiand run-agent <agent> [--model <id>] [--] [args…]\nTry: aiand run-agent opencode -- --version",
    });
  }

  const adapter = findAgent(agentName);
  if (!adapter) {
    throw new CliError(`Unknown agent "${agentName}".`, {
      hint: `Agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }

  // Detect before resolving a session: a missing binary exits 127 with an
  // Install hint, never a login ceremony for a binary that isn't there.
  if (!adapter.detect().installed) throw notInstalledError(adapter);
  // Installed as a desktop app only (OpenCode Desktop): there is no
  // terminal program to launch, so no sign-in either.
  if (adapter.appOnlyOpen?.() !== undefined) {
    throw new CliError(`Only the ${adapter.label} desktop app is installed.`, {
      exitCode: EXIT.NOT_FOUND,
      hint: `run-agent runs the terminal program. Install it with: ${adapter.install.command}\nOr wire the app with: aiand ${adapter.id} on`,
    });
  }

  // Capability before session, for the same reason: no sign-in for a launch
  // this adapter cannot do.
  if (!adapter.sessionLaunch) {
    throw new CliError(`${adapter.label} does not support session launches.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }
  if (split.fastModel !== undefined) assertFastModelFlag(adapter);

  const session = await requireSessionKey(split.profile);

  const profile = resolveProfile(split.profile);
  const baseUrl = profile.apiUrl;
  const catalog = await getCatalog(baseUrl);
  const models = launchModels(adapter, catalog, split);

  // --model is validated against the live catalog; without it the adapter
  // picks, with the profile default on hand for adapters that need one.
  // Adapters that opt in via allowUnpinnedModel read the literal "native"
  // as "leave the model unpinned"; every other adapter keeps the ordinary
  // catalog-membership error for it.
  const unpinned = models.model === "native" && adapter.allowUnpinnedModel === true;
  if (models.model !== undefined && !unpinned) validateCatalogModel(catalog, models.model);
  if (models.fastModel !== undefined) {
    validateCatalogModel(catalog, models.fastModel, "--fast-model");
  }

  // A session killed before its cleanup leaves its key in tmp. Sweeping
  // here, where overlays are made, keeps that cost off every other command
  // (Codex runs `aiand key export` on each request). Only a day-old overlay
  // whose aiand process is gone qualifies, so a parallel launch is safe.
  await sweepOverlays({ minAgeMs: STALE_OVERLAY_MS }).catch(() => {});

  const launch = await adapter.sessionLaunch({
    apiKey: session.key,
    model: models.model,
    ...(models.fastModel !== undefined ? { fastModel: models.fastModel } : {}),
    profileModel: profile.model,
    profileName: profile.name,
    catalog,
    baseUrl,
    args: models.passthrough,
  });

  // Child env = inherited, plus the adapter's own injection.
  // The adapter's own injection carries the key; a leaked AIAND_API_KEY would hand it to every process the agent spawns.
  const env = agentBaseEnv(adapter);
  // Adapters that route outside the child env list the inherited names that
  // would shadow that routing; the launcher drops them so its own injection wins.
  for (const k of adapter.shadowEnv ?? []) delete env[k];
  Object.assign(env, launch.env);

  // The adapter may own routing flags in the passthrough (e.g. Pi's
  // --provider/--model/--api-key): drop the user's `--flag value` and
  // `--flag=value` forms so the injected routing cannot be overridden.
  // Everything else passes verbatim. A value is only consumed when it is
  // not itself a flag, so `--model --print` keeps --print and a trailing
  // `--model` eats nothing.
  const ownedFlags = launch.stripPassthroughFlags ?? [];
  const passthrough: string[] = [];
  for (let i = 0; i < models.passthrough.length; i += 1) {
    const token = models.passthrough[i]!;
    if (ownedFlags.includes(token)) {
      // `--flag value`: the value is the next token, when present and not
      // itself a flag.
      const next = models.passthrough[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (ownedFlags.some((flag) => token.startsWith(`${flag}=`))) continue;
    passthrough.push(token);
  }

  await runAgentBinary(adapter, [...(launch.args ?? []), ...passthrough], env, launch.cleanup);
}
