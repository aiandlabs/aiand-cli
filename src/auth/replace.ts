import { revokeTokens } from "../api/device.js";
import { CliError } from "../cli/errors.js";
import { err, safeLine, style } from "../cli/output.js";
import {
  CONSOLE_KEYS_URL,
  CREDENTIAL_ORIGIN,
  type CredentialBinding,
  issuerBinding,
  type LoadedCredential,
  loadCredential,
  redactUrl,
  storedBinding,
  unprovenIssuer,
} from "../config.js";

/** What a login replacing `previous` needs to retire it. The issuer is read
 * before the login runs: a login can rewrite config.json, which is where an
 * unbound sign-in takes its issuer from. */
export type ReplacedSignIn = {
  profile: string;
  previous: LoadedCredential;
  binding: CredentialBinding | null;
};

export async function noteReplacedSignIn(
  profile: string,
  previous: LoadedCredential,
): Promise<ReplacedSignIn> {
  const minted = previous.origin !== CREDENTIAL_ORIGIN.PASTE && Boolean(previous.refresh_token);
  return {
    profile,
    previous,
    binding: minted ? await issuerBinding(profile, previous) : null,
  };
}

/** The sign-in about to be saved: its key, its refresh token if it has one, and where it was issued. */
export type IncomingSignIn = {
  accessToken: string;
  refreshToken?: string;
  binding: CredentialBinding;
};

type RetireOutcome = "revoked" | "kept" | "failed" | "pasted" | "unrevocable" | "unchanged";

export type RetireResult = {
  outcome: RetireOutcome;
  /** The replaced key, for scrubbing its copies once the new sign-in is saved. */
  key?: string;
  /** Set when the old key could not be revoked: what to ask, and the error that keeps the old sign-in. */
  failed?: { question: string; keep: CliError };
};

export type RetireOptions = { keepRemote?: boolean };

/**
 * Revoke the key the replaced sign-in minted. Runs under the profile's refresh
 * lock, after the new tokens arrive and before they are saved, so the old
 * refresh token is still on disk while it is spent. An old key that cannot be
 * revoked, whether the revoke failed or there is nothing to revoke it with, is
 * reported in `failed`, never decided here: the caller asks outside the lock,
 * or keeps the old sign-in, as `aiand logout` refuses. Everything goes to
 * stderr, so `--json` stdout stays one JSON document.
 */
export async function retireBeforeSave(
  replaced: ReplacedSignIn,
  incoming: IncomingSignIn,
  opts: RetireOptions = {},
): Promise<RetireResult> {
  const { profile, previous } = replaced;
  const shown = safeLine(profile);
  // Re-read under the lock: the sign-in may have rotated during a slow browser login.
  let target = previous;
  try {
    const now = await loadCredential(profile);
    if (!now) return { outcome: "unchanged" };
    target = now;
  } catch {
    // An unreadable store: the copy read when login started is the best there is.
  }
  // `--with-token` with the key already stored: revoking it would kill the key being saved.
  if (target.access_token === incoming.accessToken) return { outcome: "unchanged" };
  const binding =
    target.access_token === previous.access_token
      ? replaced.binding
      : (storedBinding(target) ?? replaced.binding);
  const key = target.access_token;
  const stillValid = `The key "${shown}" signed in with before is still valid. Revoke it at ${CONSOLE_KEYS_URL} if you no longer need it.`;

  if (target.origin === CREDENTIAL_ORIGIN.PASTE) {
    err(style.dim(`The replaced key was pasted, so this CLI did not revoke it. ${stillValid}`));
    return { outcome: "pasted", key };
  }
  if (opts.keepRemote) {
    err(style.dim(`--keep-remote: the replaced key was not revoked. ${stillValid}`));
    return { outcome: "kept", key };
  }
  if (!target.refresh_token) {
    err(
      style.yellow(
        `No refresh token was stored for the key "${shown}" signed in with before, so it cannot be revoked here.`,
      ),
    );
    return { outcome: "unrevocable", key, failed: notRevoked(shown) };
  }
  if (!binding) {
    err(style.yellow(unprovenIssuer(shown, "its key cannot be revoked here").message));
    return { outcome: "unrevocable", key, failed: notRevoked(shown) };
  }

  const result = await revokeTokens(binding.auth_url, target.refresh_token);
  if (result.revoked) {
    err(style.dim("Revoked the key this profile signed in with before."));
    return { outcome: "revoked", key };
  }
  const cause =
    result.status === undefined
      ? "the request did not reach it"
      : `it answered HTTP ${result.status}`;
  err(
    style.yellow(
      `Could not revoke the key "${shown}" signed in with before, at ${safeLine(redactUrl(binding.auth_url))}: ${cause}.`,
    ),
  );
  return { outcome: "failed", key, failed: notRevoked(shown) };
}

/** The question and the refusal for an old key this login could not revoke. */
function notRevoked(shown: string): { question: string; keep: CliError } {
  return {
    question: `Replace the sign-in anyway? Its old key stays valid until you revoke it at ${CONSOLE_KEYS_URL}.`,
    keep: new CliError(`Kept the existing sign-in for "${shown}".`, {
      hint: `Try again later, or revoke the old key at ${CONSOLE_KEYS_URL} and run \`aiand login --force --keep-remote\` to replace the sign-in.`,
    }),
  };
}
