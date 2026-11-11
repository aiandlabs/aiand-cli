import { printRebakeNotes, rebakeForBinding } from "../agents/rebake.js";
import { wiredFor } from "../agents/wired.js";
import { bool, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, fields, json, out, style, styled } from "../cli/output.js";
import {
  activeProfileName,
  assertHttpsBaseUrl,
  assertNoV1Suffix,
  assertSafeProfileName,
  configPath,
  credentialsPath,
  legacyBinding,
  loadConfig,
  loadCredential,
  normalizeBaseUrl,
  redactUrl,
  resolveProfile,
  saveConfig,
  storedBinding,
  updateProfile,
} from "../config.js";
import { routedAgents } from "./agent.js";

export const help = `${style.bold("aiand config")} -- inspect and change stored settings

Usage
  aiand config                     show the resolved settings
  aiand config path                print the config file locations
  aiand config set <key> <value>   change a setting on the active profile
  aiand config profiles            list profiles and which are signed in
  aiand config use <profile>       make a profile the default

Settable keys
  api-url   base URL for inference, catalog, logs, and usage
  auth-url  base URL for sign-in and account
  model     default model for run, chat, run-agent, and <agent> on

Environment variables override stored settings: AIAND_API_KEY, AIAND_BASE_URL,
AIAND_AUTH_URL, AIAND_PROFILE, AIAND_CONFIG_DIR.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (bool(parsed, "help")) return out(help);

  const [subcommand, ...rest] = parsed.positionals;

  switch (subcommand) {
    case undefined:
      return show(parsed);
    case "path":
      return paths(parsed);
    case "set":
      return set(rest, parsed);
    case "profiles":
      return profiles(parsed);
    case "use":
      return use(rest[0], parsed);
    default:
      throw new CliError(`Unknown subcommand "${subcommand}".`, {
        hint: "Run `aiand config --help` to see the subcommands.",
      });
  }
}

async function show(parsed: Parsed): Promise<void> {
  const profile = resolveProfile(str(parsed, "profile"));
  const signedIn = Boolean(await loadCredential(profile.name));

  if (bool(parsed, "json")) {
    return json({ ...profile, signed_in: signedIn, config_path: configPath() });
  }

  fields([
    ["profile", profile.name],
    ["api url", profile.apiUrl],
    ["auth url", profile.authUrl],
    ["model", profile.model ?? styled(style.dim, "catalog preferred")],
    ["signed in", signedIn ? styled(style.green, "yes") : styled(style.dim, "no")],
  ]);
}

function paths(parsed: Parsed): void {
  if (bool(parsed, "json")) {
    json({ config: configPath(), credentials: credentialsPath() });
    return;
  }
  fields([
    ["config", configPath()],
    ["credentials", credentialsPath()],
  ]);
}

async function set(args: string[], parsed: Parsed): Promise<void> {
  const [key, ...valueParts] = args;
  const value = valueParts.join(" ");
  if (!key || !value) {
    throw new CliError("Both a key and a value are required.", {
      hint: "For example: aiand config set model zai-org/glm-5.3",
    });
  }

  // activeProfileName, not resolveProfile: a stored http URL must stay fixable
  // via `config set` instead of throwing before the new value lands.
  const name = activeProfileName(str(parsed, "profile"));

  switch (key) {
    case "api-url":
      assertHttpsBaseUrl(value);
      assertNoV1Suffix(value);
      await updateProfile(name, { apiUrl: value });
      await warnWiredElsewhere(name, value);
      break;
    case "auth-url":
      assertHttpsBaseUrl(value);
      assertNoV1Suffix(value);
      await updateProfile(name, { authUrl: value });
      break;
    case "model":
      await updateProfile(name, { model: value });
      break;
    default:
      throw new CliError(`"${key}" is not a settable key.`, {
        hint: "Settable keys: api-url, auth-url, model.",
      });
  }

  if (bool(parsed, "json")) {
    return json({ profile: name, key, value });
  }
  out(style.green(`Set ${key} = ${value} on profile "${name}".`));
}

/** Agents wired for the old endpoint keep sending there, and keep their key. */
async function warnWiredElsewhere(profile: string, apiUrl: string): Promise<void> {
  const target = normalizeBaseUrl(apiUrl);
  for (const { agent, apiUrl: wired } of await wiredFor(profile)) {
    if (normalizeBaseUrl(wired) === target) continue;
    err(
      style.dim(
        `[${agent}] Still wired to ${redactUrl(wired)}, which is where its key goes; this change does not move it. Sign in for ${redactUrl(target)} (\`aiand login --profile ${profile}\`), then run \`aiand --profile ${profile} ${agent} on\` to rewire it.`,
      ),
    );
  }
}

async function profiles(parsed: Parsed): Promise<void> {
  const config = loadConfig();
  const rows: { name: string; active: boolean; signed_in: boolean }[] = [];
  for (const name of Object.keys(config.profiles)) {
    rows.push({
      name,
      active: name === config.profile,
      signed_in: Boolean(await loadCredential(name)),
    });
  }

  if (bool(parsed, "json")) return json(rows);

  for (const row of rows) {
    const marker = row.active ? style.green("*") : " ";
    const status = row.signed_in ? style.green("signed in") : style.dim("signed out");
    out(`${marker} ${row.name}  ${status}`);
  }
}

async function use(name: string | undefined, parsed: Parsed): Promise<void> {
  if (!name) {
    throw new CliError("Which profile?", { hint: "aiand config use <profile>" });
  }
  assertSafeProfileName(name);
  const config = loadConfig();
  if (!config.profiles[name]) {
    config.profiles[name] = {};
  }
  config.profile = name;
  await saveConfig(config);

  // Agents hold the key baked at `on`, so switching profiles rebakes the
  // target's key, or warns when agents are on and it has none. A key is only
  // baked where the agent was wired for the credential's own API origin;
  // any other agent keeps what it has, with a note. While the env key is set
  // it is the session, so nothing is swapped.
  if (!process.env.AIAND_API_KEY?.trim()) {
    const credential = await loadCredential(name);
    if (credential) {
      const binding = storedBinding(credential) ?? legacyBinding(name);
      printRebakeNotes(await rebakeForBinding(credential.access_token, name, binding));
    } else if ((await routedAgents("exclude")).length > 0) {
      err(
        style.dim(
          `Switched to "${name}" with no stored credential; baked keys in agent configs were left in place. Run \`aiand login\` or \`aiand <agent> off\` to strip them.`,
        ),
      );
    }
  }

  if (bool(parsed, "json")) {
    return json({ profile: name });
  }
  out(style.green(`Using profile "${name}".`));
}
