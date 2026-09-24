import { AGENTS } from "../agents/registry.js";
import { revokeTokens } from "../api/device.js";
import { CliError } from "../cli/errors.js";
import { err, out, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { clearCredential, loadConfig, loadCredential, resolveProfile } from "../config.js";

export type LogoutOptions = {
  profile?: string;
  revoke?: boolean;
  keepRemote?: boolean;
  json?: boolean;
};

/** End this machine's session: clear the local credential and, for a
 * device-minted key, revoke it server-side (unless --keep-remote keeps it). */
export async function logout(opts: LogoutOptions = {}): Promise<void> {
  const profile = resolveProfile(opts.profile);
  const credential = await loadCredential(profile.name);

  if (!credential) {
    if (opts.json) {
      return out(
        JSON.stringify(
          {
            profile: profile.name,
            revoked: false,
            signed_in: false,
            ...(process.env.AIAND_API_KEY
              ? { note: "AIAND_API_KEY still applies until unset" }
              : {}),
          },
          null,
          2,
        ),
      );
    }
    if (process.env.AIAND_API_KEY) {
      out(
        style.dim(
          `Profile "${profile.name}" was not signed in. The AIAND_API_KEY environment variable still applies until it is unset.`,
        ),
      );
      return;
    }
    out(style.dim(`Profile "${profile.name}" was not signed in.`));
    return;
  }

  const pasted = credential.origin === "paste";
  if (pasted && opts.revoke) {
    throw new CliError("This key was pasted, not minted by this CLI; refusing to revoke it.", {
      hint: "Revoke it in the console if you no longer need it.",
    });
  }

  let revoked = false;
  let keepRemote = opts.keepRemote ?? false;
  // Only a minted refresh token revokes server-side, and only via
  // {refresh_token} — the server contract sends exactly that. No refresh
  // token means nothing to revoke: the local clear below is the whole job.
  const revokeToken = credential.refresh_token;
  if (pasted) {
    keepRemote = true;
  } else if (keepRemote || !revokeToken) {
    // keepRemote: caller said keep; no refresh token: local clear only.
  } else if (opts.revoke) {
    revoked = await revokeTokens(profile.authUrl, revokeToken);
  } else if (isInteractive()) {
    const yes = await confirm("Revoke the ai& key this machine minted?", {
      default: true,
    });
    if (yes) {
      revoked = await revokeTokens(profile.authUrl, revokeToken);
    } else {
      keepRemote = true;
    }
  } else {
    revoked = await revokeTokens(profile.authUrl, revokeToken);
  }

  // Strip aiand's writes from every agent before the credential goes, so no
  // baked key lingers. disable() checks the marker itself, so it runs even
  // when probe() reads inactive (a marked config with a bad baseURL still
  // holds our key). Teardown follows the stored active profile, which is
  // what the rebake baked; AIAND_PROFILE only targets commands. A strip
  // failure is a stderr hint, never fatal.
  if (profile.name === loadConfig().profile) {
    for (const adapter of AGENTS) {
      if (adapter.launcherOnly) continue;
      try {
        await adapter.disable();
      } catch (error) {
        err(
          style.dim(
            `[${adapter.id}] Could not strip its key: ${(error as Error).message ?? String(error)} Re-run \`aiand ${adapter.id} off\`.`,
          ),
        );
      }
    }
  } else {
    // The strip above only covers the stored active profile; switching to a
    // signed-out profile can leave another profile's key baked on disk.
    err(
      style.dim(
        `Profile "${profile.name}" is not the active profile ("${loadConfig().profile}"); baked keys were left in place in agent configs. Switch to it and log out again to strip them.`,
      ),
    );
  }

  await clearCredential(profile.name);

  // openSession prefers the Env key over any stored Credential, so clearing
  // alone does not end the Session while AIAND_API_KEY is set — the same
  // warn the not-signed-in branch already prints. stderr, so --json stdout
  // stays parseable.
  if (process.env.AIAND_API_KEY) {
    err(style.dim("The AIAND_API_KEY environment variable still applies until it is unset."));
  }

  if (opts.json) {
    return out(
      JSON.stringify(
        {
          profile: profile.name,
          revoked,
          source: pasted ? "pasted-key" : "device-login",
        },
        null,
        2,
      ),
    );
  }

  out(style.green(`Signed out of "${profile.name}".`));
  if (pasted) {
    out(style.dim("The pasted key was removed locally; it is still valid in the console."));
  } else if (!revoked && !keepRemote) {
    out(
      style.dim(
        "The server could not be reached, so the key was only removed locally. Revoke it in the console if this machine is untrusted.",
      ),
    );
  }
}
