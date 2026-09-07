import { parse, bool, str } from "../cli/args.js";
import { out, style } from "../cli/output.js";
import { clearCredential, loadCredential, resolveProfile } from "../config.js";
import { revokeTokens } from "../api/device.js";

export const help = `${style.bold("aiand logout")} -- end this machine's session

Usage
  aiand logout [options]

Options
  --profile <name>    log out of this profile instead of the active one
  --keep-remote       forget the local credential without revoking the key

Revokes the API key the device login minted, then deletes it from disk.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { "keep-remote": { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));
  const credential = loadCredential(profile.name);

  if (!credential) {
    out(style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  let revoked = false;
  if (!bool(parsed, "keep-remote")) {
    revoked = await revokeTokens(profile.authUrl, credential.refresh_token);
  }
  clearCredential(profile.name);

  if (bool(parsed, "json")) {
    return out(JSON.stringify({ profile: profile.name, revoked }, null, 2));
  }

  out(style.green(`Signed out of "${profile.name}".`));
  if (!revoked && !bool(parsed, "keep-remote")) {
    out(
      style.dim(
        "The server could not be reached, so the key was only removed locally. Revoke it in the console if this machine is untrusted."
      )
    );
  }
}
