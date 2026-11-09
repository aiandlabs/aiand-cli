import { legacyCodexOrigin } from "../agents/codex/adapter.js";
import { assertKeyBoundTo } from "../api/client.js";
import { requireSessionKey } from "../auth/session.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";

export const help = `${style.bold("aiand key export")} -- print the active session key

Prints the resolved API key to stdout with no decoration, so it can be piped
straight into another tool: \`aiand key export | pbcopy\`.

Usage
  aiand key export [options]

Options
  --profile <name>    export a specific profile's key
  --base-url <url>    point at a different API endpoint
  --for <origin>      the API origin the key is going to; refused unless the
                      stored login was issued for it (Codex's auth command sets it)
  -h, --help          show this help`;

/**
 * The only verb is `export`: resolve the active session key (env var wins,
 * then the stored credential for the profile) and write the raw key to stdout.
 */
export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { for: { type: "string" } });
  if (bool(parsed, "help")) return out(help);

  const [verb] = parsed.positionals;
  if (verb !== "export") {
    throw new CliError(verb ? `Unknown verb "${verb}".` : "No verb given.", {
      hint: "Verbs: export",
    });
  }

  const profileName = str(parsed, "profile");
  const session = await requireSessionKey(profileName);
  // The origin the caller will send the key to, not the one this process resolves: Codex runs
  // us in its own environment. A config from before `--for` carries it only as its base_url.
  const name = resolveProfile(profileName).name;
  const destination = str(parsed, "for") ?? (await legacyCodexOrigin(name));
  if (destination !== undefined && destination !== null) {
    assertKeyBoundTo(name, session.credential, destination);
  }
  process.stdout.write(`${session.key}\n`);
}
