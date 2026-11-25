import { CREDENTIAL_SOURCE } from "../auth/identity.js";
import { type BeforeSave, browserLogin, deviceLogin, pasteLogin } from "../auth/login.js";
import { scrubKeyCopies } from "../auth/logout.js";
import { noteReplacedSignIn, type ReplacedSignIn, retireBeforeSave } from "../auth/replace.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { json, out, safeLine, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { loadCredential, resolveProfile } from "../config.js";

export const help = `${style.bold("aiand login")} -- sign in with a browser approval, or store a key you already have

Usage
  aiand login [options]

Options
  --base-url <url>    point at a different API endpoint
  --profile <name>    store the sign-in under this profile
  --force             sign in again even if this profile is already signed in
  --keep-remote       when replacing a sign-in, keep its key valid on the server
  --paste             paste an existing ai& API key (masked input)
  --with-token        read the key from stdin (aiand login --with-token < key.txt)

The default path opens your browser and signs in. Over SSH, or when browser
sign-in is unavailable, it uses device login (approve a code in any browser);
if that also fails (service unreachable) an interactive terminal offers to
paste a key instead. Paste paths validate the key against the
API first; a pasted key is never rotated or revoked by this CLI.

Signing in again replaces the profile's sign-in. Before the new sign-in is
stored, the key the old one minted is revoked where it was issued, as
\`aiand logout\` would. A sign-in that fails or is cancelled keeps the old
one. If the old key cannot be revoked (the revoke fails, or there is no
refresh token or recorded issuer to revoke it with), a terminal asks whether
to replace the sign-in anyway; no, Ctrl-C, or no terminal keeps the old
sign-in and revokes the new key. A new key that cannot be revoked is named in
the error.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    force: { type: "boolean", default: false },
    "keep-remote": { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    "with-token": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const pasteMode = bool(parsed, "paste") || bool(parsed, "with-token");
  const profile = resolveProfile(str(parsed, "profile"));

  // CI mode: the environment key is the session — nothing stored, nothing done.
  // Whitespace-only reads as unset (same normalization as openSession).
  if (process.env.AIAND_API_KEY?.trim()) {
    if (bool(parsed, "json")) {
      return json({ profile: profile.name, source: CREDENTIAL_SOURCE.ENV });
    }
    out(style.yellow("AIAND_API_KEY is set — using it as the session. Nothing stored."));
    return;
  }

  const existing = await loadCredential(profile.name);
  if (!bool(parsed, "force") && existing) {
    if (isInteractive()) {
      const email = safeLine(existing.user?.email ?? "unknown");
      const again = await confirm(
        `Profile ${profile.name} is already signed in as ${email}. Sign in again and replace it?`,
        {
          default: false,
        },
      );
      if (!again) {
        out("Keeping the existing sign-in.");
        return;
      }
    } else {
      throw new CliError(`Profile "${profile.name}" is already signed in.`, {
        hint: "Run `aiand whoami` to see who, or `aiand login --force` to replace it.",
      });
    }
  }

  const replaced: ReplacedSignIn | null = existing
    ? await noteReplacedSignIn(profile.name, existing)
    : null;

  let replacedKey: string | undefined;
  let retired = false;
  const beforeSave: BeforeSave | undefined = replaced
    ? async (incoming) => {
        const r = await retireBeforeSave(replaced, incoming, {
          keepRemote: bool(parsed, "keep-remote"),
        });
        replacedKey = r.key;
        retired = r.outcome === "revoked";
        if (!r.failed) return { kind: "save", retired };
        const { question, keep } = r.failed;
        if (!isInteractive()) return { kind: "keep", keep };
        return { kind: "ask", confirm: () => confirm(question, { default: false }), keep };
      }
    : undefined;

  try {
    await signIn();
  } finally {
    // The old key's copies in pre-0.8 snapshots would outlive the sign-in it
    // belonged to, even when a step after the save (the rebake) fails.
    if (replaced) await scrubReplacedKeys(replaced, replacedKey, retired);
  }

  async function signIn(): Promise<void> {
    if (pasteMode) {
      await pasteLogin({
        profile: profile.name,
        beforeSave,
        fromStdin: bool(parsed, "with-token"),
        interactive: bool(parsed, "paste"),
        json: bool(parsed, "json"),
      });
    } else if (isInteractive()) {
      await browserLogin({ profile: profile.name, json: bool(parsed, "json"), beforeSave });
    } else {
      await deviceLogin({ profile: profile.name, json: bool(parsed, "json"), beforeSave });
    }
  }
}

/** Scrub the replaced sign-in's key copies once it is gone: revoked, or no longer the stored one. */
async function scrubReplacedKeys(
  replaced: ReplacedSignIn,
  replacedKey: string | undefined,
  retired: boolean,
): Promise<void> {
  let current: string | undefined;
  try {
    current = (await loadCredential(replaced.profile))?.access_token;
  } catch {
    if (!retired) return;
  }
  const replacedNow = retired || current !== replaced.previous.access_token;
  if (!replacedNow) return;
  const keys = [replaced.previous.access_token, replacedKey].filter(
    (k): k is string => k !== undefined && k !== current,
  );
  if (keys.length > 0) await scrubKeyCopies([...new Set(keys)]);
}
