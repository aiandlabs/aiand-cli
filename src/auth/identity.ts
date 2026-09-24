import { ApiError, NotLoggedInError } from "../cli/errors.js";
import { openSession, type Session } from "../api/client.js";
import {
  getUser,
  listOrgs,
  type AccountOrg,
  type AccountUser,
} from "../api/account.js";
import {
  loadCredential,
  maskKey,
  resolveProfile,
  type Credential,
  type LoadedCredential,
  type ResolvedProfile,
} from "../config.js";

type CredentialSource = "device-login" | "pasted-key" | "AIAND_API_KEY";

/** The key-source string status and whoami both emit. `null` is the env key;
 * a stored credential with no origin predates origin tracking (0.1.x) and was
 * device-minted. */
export function classifySource(
  credential: Pick<Credential, "origin"> | null | undefined,
): CredentialSource {
  if (!credential) return "AIAND_API_KEY";
  return credential.origin === "paste" ? "pasted-key" : "device-login";
}

const SOURCE_LABELS: Record<CredentialSource, string> = {
  "device-login": "device login",
  "pasted-key": "pasted key",
  AIAND_API_KEY: "AIAND_API_KEY",
};

/** Human label for classifySource, so text and --json output always agree. */
export function sourceLabel(credential: Pick<Credential, "origin"> | null | undefined): string {
  return SOURCE_LABELS[classifySource(credential)];
}

export function storageLabel(storage: string | null): string {
  switch (storage) {
    case "keychain":
      return "keychain";
    case "file":
      return "encrypted file";
    case "plaintext":
      return "plaintext file";
    default:
      return "from AIAND_API_KEY";
  }
}

export type Identity = {
  profile: ResolvedProfile;
  session: Session | null;
  user: AccountUser | null;
  org: AccountOrg | null;
  orgs: AccountOrg[];
  cached: LoadedCredential | null;
  /** False when the gateway could not verify the key (connection refused,
   * 5xx). whoami rethrows probeError; status reports the outage as its own
   * state instead of throwing, so scripts never mistake it for signed-out. */
  reachable: boolean;
  /** The gateway failure behind reachable=false; null when reachable. */
  probeError: ApiError | null;
};

/** The sign-in probe shared by status and whoami. Signed out returns
 * `session: null`; a gateway failure (connection refused, 5xx) returns
 * `reachable: false` with the error in `probeError`. Anything else (a
 * rejected key, corrupt local state, Ctrl-C) throws. */
export async function probeIdentity(
  profileOverride?: string,
  local = false,
): Promise<Identity> {
  const profile = resolveProfile(profileOverride);
  let session: Session | null = null;
  let user: AccountUser | null = null;
  let org: AccountOrg | null = null;
  let orgs: AccountOrg[] = [];
  let cached: LoadedCredential | null = null;
  let reachable = true;
  let probeError: ApiError | null = null;

  try {
    if (local) {
      // Cached-only: never touch the network. openSession rotates device
      // tokens near expiry, so build the session straight from the stored
      // credential instead of opening one.
      const fromEnv = process.env.AIAND_API_KEY;
      if (fromEnv) {
        // The cached identity belongs to the stored credential, not the env
        // key, so it would name the wrong account here.
        session = { profile, token: fromEnv, credential: null };
      } else {
        cached = await loadCredential(profile.name);
        if (!cached) throw new NotLoggedInError();
        session = { profile, token: cached.access_token, credential: cached };
        user = cached.user ?? null;
        org = cached.org ?? null;
        orgs = cached.org ? [cached.org] : [];
      }
    } else {
      session = await openSession(profile);
      cached = await loadCredential(profile.name);
      [orgs, user] = await Promise.all([listOrgs(session), getUser(session)]);
      const cachedOrg = cached?.org;
      org =
        cachedOrg && orgs.some((o) => o.id === cachedOrg.id)
          ? cachedOrg
          : (orgs[0] ?? null);
    }
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      // Signed out: fall through with session null; reachable stays true.
    } else if (
      error instanceof ApiError &&
      (error.status === 0 || error.status >= 500)
    ) {
      // Gateway unreachable or erroring: report it, don't throw, so status
      // can name the outage without failing scripts that gate on it.
      reachable = false;
      probeError = error;
    } else {
      throw error;
    }
  }

  return { profile, session, user, org, orgs, cached, reachable, probeError };
}

/** The auth half of status --json: identity, masked key, key source, and the
 * storage tier holding the secret. Three states, kept distinct so scripts
 * can gate without false-failing during an outage: verified (signed_in and
 * reachable), signed_out (!signed_in, reachable), unreachable (!reachable —
 * the key could not be verified, not proven absent). */
export type AuthStatus = {
  signed_in: boolean;
  /** False when the gateway could not be reached to verify the key. status
   * prints its own outage line and exits 0; whoami rethrows instead. */
  reachable: boolean;
  profile: string;
  email: string | null;
  org: string | null;
  key: string | null;
  source: "device-login" | "pasted-key" | "AIAND_API_KEY" | null;
  storage: string | null;
};

export type AuthStatusOptions = {
  profile?: string;
  local?: boolean;
};

/** The auth half of `aiand status`, built on the same probe as whoami. */
export async function authStatus(
  opts: AuthStatusOptions = {},
): Promise<AuthStatus> {
  const { profile, session, user, org, cached, reachable } = await probeIdentity(
    opts.profile,
    opts.local,
  );

  if (!reachable || !session) {
    return {
      signed_in: false,
      reachable,
      profile: profile.name,
      email: null,
      org: null,
      key: null,
      source: null,
      storage: null,
    };
  }

  const credential = session.credential;
  const storage = credential ? (cached?.storage ?? null) : null;
  return {
    signed_in: true,
    reachable,
    profile: profile.name,
    email: user?.email ?? cached?.user?.email ?? null,
    org: org?.name ?? cached?.org?.name ?? null,
    key: maskKey(session.token),
    source: classifySource(credential),
    storage: storage !== null ? storageLabel(storage) : null,
  };
}
