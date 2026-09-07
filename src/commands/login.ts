import { parse, bool, str } from "../cli/args.js";
import { err, fields, out, style, spinner } from "../cli/output.js";
import { openBrowser } from "../cli/browser.js";
import { CliError } from "../cli/errors.js";
import {
  loadConfig,
  loadCredential,
  maskKey,
  resolveProfile,
  saveConfig,
  saveCredential,
  updateProfile,
} from "../config.js";
import {
  pollForToken,
  startDeviceAuthorization,
  verificationUrl,
} from "../api/device.js";
import { openSession } from "../api/client.js";
import { getUser, listOrgs } from "../api/account.js";

export const help = `${style.bold("aiand login")} -- sign in with a browser approval

Usage
  aiand login [options]

Options
  --base-url <url>    point at a different API endpoint
  --profile <name>    store the session under this profile
  --no-browser        print the URL instead of opening it
  --force             sign in again even if this profile already has a session

The browser approval mints an org-scoped API key for this machine. It is stored
in ~/.config/aiand/credentials.json (0600) and rotated automatically.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-browser": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));

  if (!bool(parsed, "force") && loadCredential(profile.name)) {
    throw new CliError(`Profile "${profile.name}" is already signed in.`, {
      hint: "Run `aiand whoami` to see who, or `aiand login --force` to replace it.",
    });
  }

  const device = await startDeviceAuthorization(profile.authUrl);
  const url = verificationUrl(profile.authUrl, device);

  out();
  out(`  ${style.dim("Your code ")}  ${style.bold(style.cyan(device.user_code))}`);
  out(`  ${style.dim("Approve at")}  ${style.blue(url)}`);
  out();

  if (bool(parsed, "no-browser")) {
    err(style.dim("Open the URL above to continue."));
  } else if (!openBrowser(url)) {
    err(style.dim("Could not open a browser -- open the URL above to continue."));
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = spinner("Waiting for approval in the browser...");
  let tokens;
  try {
    tokens = await pollForToken(profile.authUrl, device, {
      signal: controller.signal,
      onSlowDown: (interval) => err(style.dim(`Server asked us to back off; polling every ${interval}s.`)),
    });
  } finally {
    spin.stop();
    process.removeListener("SIGINT", onInterrupt);
  }

  saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
  });

  // Make the profile we just authenticated the default.
  const config = loadConfig();
  updateProfile(profile.name, {});
  if (config.profile !== profile.name) {
    saveConfig({ ...loadConfig(), profile: profile.name });
  }

  // Identity is not in the token response, so read it back from the account
  // routes and cache it for `whoami`.
  const session = await openSession(resolveProfile(profile.name));
  const [user, orgs] = await Promise.all([getUser(session), listOrgs(session)]);
  const org = orgs[0];
  saveCredential(profile.name, {
    ...loadCredential(profile.name)!,
    user,
    ...(org ? { org } : {}),
  });

  if (bool(parsed, "json")) {
    return out(
      JSON.stringify({ profile: profile.name, user, org: org ?? null, key: maskKey(session.token) }, null, 2)
    );
  }

  out(style.green("Signed in."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    ["org", org ? `${org.name} ${style.dim(`(${org.id})`)}` : style.dim("none")],
    ["profile", profile.name],
    ["key", style.dim(maskKey(session.token))],
  ]);
}
