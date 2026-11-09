import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { sweepOverlays } from "../agents/overlays.js";
import { AGENTS, wiringCheckFor } from "../agents/registry.js";
import { scrubSnapshotKeys } from "../agents/snapshot.js";
import { revokeTokens } from "../api/device.js";
import { CliError, cancelled, EXIT } from "../cli/errors.js";
import { err, json, out, safeLine, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { redactSecrets } from "../cli/redact.js";
import {
  CREDENTIAL_ORIGIN,
  clearCredential,
  configDir,
  issuerAuthUrl,
  type LoadedCredential,
  loadAllCredentials,
  loadConfig,
  loadCredential,
} from "../config.js";
import { CONFIG_MARKER_FILE, pathIsInside } from "../fsutil.js";
import { deleteSecret } from "../secrets.js";
import {
  provesAiandConfigDir,
  SIGN_IN_FILES,
  type WipePlan,
  type WipeResult,
  wipeConfigDir,
} from "./config-wipe.js";
import { classifySource } from "./identity.js";
import { CONSOLE_KEYS_URL } from "./logout.js";

/** Set to 1 to let `logout --all` delete a config dir outside the home directory. */
export const WIPE_OUTSIDE_HOME_ENV = "AIAND_WIPE_OUTSIDE_HOME";

export type LogoutAllOptions = {
  force?: boolean;
  keepRemote?: boolean;
  json?: boolean;
};

type ProfileOutcome = {
  profile: string;
  source: string;
  revoked: boolean;
  /** The revoke failed, so the sign-in stays for a retry: it is the only way to revoke the key. */
  kept?: true;
  error?: string;
};

type AgentOutcome = {
  agent: string;
  stripped: boolean;
  notes?: string[];
  error?: string;
};

/** An error's text for a report: it can quote a file or a response, so one safe line with no key in it. */
const message = (error: unknown): string =>
  redactSecrets(safeLine((error as Error)?.message ?? String(error)));

/**
 * The config dir `logout --all` will delete, canonicalised, or null when
 * there is none. Refuses the home directory itself, a filesystem root, and
 * (unless WIPE_OUTSIDE_HOME_ENV) anything outside home, before anything is
 * touched.
 */
async function wipeTarget(): Promise<string | null> {
  const configured = resolve(configDir());
  let real: string;
  try {
    real = await realpath(configured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  if (real === home || dirname(real) === real) {
    throw new CliError(`Refusing to delete ${real}: it is not a config directory.`, {
      hint: "Point AIAND_CONFIG_DIR at aiand's own directory, then run aiand logout --all again.",
    });
  }
  if (!pathIsInside(home, real) && process.env[WIPE_OUTSIDE_HOME_ENV] !== "1") {
    throw new CliError(`Refusing to delete ${real}: it is outside your home directory (${home}).`, {
      hint: `If that really is aiand's config directory, run again with ${WIPE_OUTSIDE_HOME_ENV}=1.`,
    });
  }
  if (!(await provesAiandConfigDir(real))) {
    throw new CliError(`Refusing to delete from ${real}: it is not aiand's config directory.`, {
      hint: `aiand marks its own directory with a ${CONFIG_MARKER_FILE} file and writes a config.json with a profile and profiles. This one has neither. If it really is aiand's, create an empty ${CONFIG_MARKER_FILE} file in it and run aiand logout --all again; otherwise point AIAND_CONFIG_DIR at aiand's directory.`,
    });
  }
  return real;
}

/** Delete what aiand keeps in the config dir, and a symlinked path to it once its target is gone. */
async function deleteConfigDir(real: string, plan: WipePlan): Promise<WipeResult> {
  const result = await wipeConfigDir(real, plan);
  const configured = resolve(configDir());
  if (result.removed && configured !== real) {
    if ((await lstat(configured).catch(() => null))?.isSymbolicLink()) {
      await unlink(configured).catch(() => {});
    }
  }
  return result;
}

/** Whether a file still holds one of `keys`; an unreadable one is not proof of anything. */
async function holdsKey(path: string, keys: readonly string[]): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return keys.some((key) => key.length > 0 && text.includes(key));
}

/**
 * Hand a machine back: revoke every key this CLI minted (best-effort, one
 * profile at a time), strip ai& from every agent whatever profile wired it,
 * delete stale launcher overlays, every stored secret (keychain included),
 * and the config dir with its snapshots. Pasted keys cannot be revoked from
 * here; they are listed with the console page that can. Exit 1 when any
 * step left something behind, after reporting all of it.
 */
export async function logoutAll(opts: LogoutAllOptions = {}): Promise<void> {
  // Refuse a bad target before anything is revoked or stripped.
  const target = await wipeTarget();
  const shownTarget = target ?? resolve(configDir());

  if (!opts.force) {
    if (!isInteractive()) {
      throw new CliError("logout --all signs out every profile and deletes aiand's local data.", {
        hint: "Pass --force to confirm when not at a terminal.",
      });
    }
    const yes = await confirm(
      `Sign out of every profile, remove ai& from every agent, and delete ${shownTarget}?`,
      { default: false },
    );
    if (!yes) throw cancelled();
  }

  const problems: string[] = [];
  let stored: Record<string, unknown> = {};
  // Without the credential list nothing can be revoked or told apart from a
  // sign-in that is still owed a revoke, so none of it is deleted.
  let credentialsUnreadable = false;
  try {
    stored = await loadAllCredentials();
  } catch (error) {
    credentialsUnreadable = true;
    problems.push(`Could not read stored credentials: ${message(error)}`);
  }
  let profileNames: string[] = [];
  try {
    profileNames = Object.keys(loadConfig().profiles);
  } catch (error) {
    problems.push(`Could not read config.json: ${message(error)}`);
  }
  const names = [...new Set([...Object.keys(stored), ...profileNames])];

  // Revoke first, while the refresh tokens are still here.
  const profiles: ProfileOutcome[] = [];
  const keys: string[] = [];
  /** Profiles whose sign-in is there but could not be read: kept, since nothing here can revoke what it cannot read. */
  const unreadable = new Set<string>();
  const keepUnreadable = (name: string, reason: string): void => {
    unreadable.add(name);
    profiles.push({
      profile: name,
      source: "unknown",
      revoked: false,
      kept: true,
      error: reason,
    });
  };
  if (credentialsUnreadable) {
    for (const name of profileNames) {
      keepUnreadable(name, "the stored credentials could not be read, so this sign-in was kept");
    }
  }
  for (const name of Object.keys(stored)) {
    let credential: LoadedCredential | null = null;
    try {
      credential = await loadCredential(name);
    } catch (error) {
      profiles.push({
        profile: name,
        source: "unknown",
        revoked: false,
        ...(opts.keepRemote ? {} : { kept: true as const }),
        error: message(error),
      });
      continue;
    }
    if (!credential) {
      keepUnreadable(
        name,
        "the stored credential could not be read (is the keychain locked?), so this sign-in was kept",
      );
      problems.push(`Could not read the stored credential for "${name}": its sign-in was kept.`);
      continue;
    }
    keys.push(credential.access_token);
    const outcome: ProfileOutcome = {
      profile: name,
      source: classifySource(credential),
      revoked: false,
    };
    profiles.push(outcome);
    if (credential.origin === CREDENTIAL_ORIGIN.PASTE || opts.keepRemote) continue;
    if (!credential.refresh_token) {
      outcome.error = "no refresh token was stored, so it cannot be revoked from here";
      continue;
    }
    try {
      outcome.revoked = await revokeTokens(
        issuerAuthUrl(name, credential),
        credential.refresh_token,
      );
      if (!outcome.revoked) outcome.error = "the server could not be reached";
    } catch (error) {
      outcome.error = message(error);
    }
    if (!outcome.revoked) outcome.kept = true;
  }
  const retained = new Set(profiles.filter((p) => p.kept).map((p) => p.profile));
  const keepSignIn = retained.size > 0 || credentialsUnreadable;
  const envKey = process.env.AIAND_API_KEY?.trim();
  if (envKey) keys.push(envKey);

  // Strip every agent. No loggingOut: whichever profile wired it, it goes.
  const agents: AgentOutcome[] = [];
  const keysLeft: string[] = [];
  // Agents `off` could not finish: what `on` recorded is what a retry needs.
  const unfinished = new Set<string>();
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;
    let files: string[] = [];
    try {
      files = adapter.managedFiles();
    } catch {
      // Unknown locations are checked by nothing; disable() still runs.
    }
    try {
      // The guard `off` runs: an app that holds its config in memory rewrites
      // it on exit and puts the key back. Only an agent with something wired
      // is refused, so a running app we never touched does not block the wipe.
      if (
        adapter.offGuard &&
        (await adapter.probe().then(
          (p) => p.active,
          () => true,
        ))
      ) {
        await adapter.offGuard({ force: false });
      }
      const result = (await adapter.disable()) ?? { stripped: false };
      const notes = result.notes?.filter(Boolean) ?? [];
      agents.push({
        agent: adapter.id,
        stripped: result.stripped,
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch (error) {
      agents.push({ agent: adapter.id, stripped: false, error: message(error) });
      unfinished.add(adapter.id);
    }
    for (const file of files) {
      if (await holdsKey(file, keys)) {
        keysLeft.push(file);
        unfinished.add(adapter.id);
      }
    }
  }

  const overlays = await sweepOverlays().catch(() => ({ removed: [], inUse: [] }));

  for (const name of names) {
    if (retained.has(name)) continue;
    try {
      // A kept sign-in leaves credentials.json in place, so a cleared one must leave it too.
      if (retained.size > 0 && Object.hasOwn(stored, name)) await clearCredential(name);
      else await deleteSecret(name);
    } catch (error) {
      problems.push(`Could not delete the stored secret for "${name}": ${message(error)}`);
    }
  }

  let wipe: WipeResult = { removed: false, left: [], kept: [] };
  if (target !== null) {
    try {
      // A kept snapshot may hold a copy an older aiand made of a keyed file.
      if (unfinished.size > 0) await scrubSnapshotKeys(keys, wiringCheckFor).catch(() => []);
      wipe = await deleteConfigDir(target, {
        keep: keepSignIn ? SIGN_IN_FILES : new Set(),
        keepSnapshots: unfinished,
      });
    } catch (error) {
      problems.push(`Could not delete ${target}: ${message(error)}`);
    }
  }
  const left = wipe.left;

  const revokeFailed = profiles.filter(
    (profile) => profile.error !== undefined && profile.source !== "pasted-key",
  );
  const pasted = profiles.filter((profile) => profile.source === "pasted-key");
  const agentFailed = agents.filter((agent) => agent.error !== undefined);
  const complete =
    problems.length === 0 &&
    (opts.keepRemote || revokeFailed.length === 0) &&
    agentFailed.length === 0 &&
    keysLeft.length === 0 &&
    overlays.inUse.length === 0 &&
    left.length === 0;
  if (!complete) process.exitCode = EXIT.ERROR;

  if (envKey) {
    err(style.dim("The AIAND_API_KEY environment variable still applies until it is unset."));
  }

  if (opts.json) {
    return json({
      complete,
      profiles,
      ...(pasted.length > 0 ? { console_url: CONSOLE_KEYS_URL } : {}),
      agents,
      keys_left_on_disk: keysLeft,
      overlays: { removed: overlays.removed.length, in_use: overlays.inUse },
      config_dir: { path: shownTarget, removed: wipe.removed, left, kept: wipe.kept },
      problems,
    });
  }

  out(
    complete
      ? style.green("Signed out everywhere and removed ai& from this machine.")
      : style.yellow(
          keepSignIn
            ? "Not everything could be cleaned up:"
            : "Signed out, but not everything could be cleaned up:",
        ),
  );
  for (const profile of profiles) {
    if (profile.source === "pasted-key") continue;
    if (profile.revoked) out(`  ${safeLine(profile.profile)}: key revoked`);
    else if (opts.keepRemote && !profile.kept) {
      out(`  ${safeLine(profile.profile)}: removed locally; the key stays valid`);
    } else out(`  ${safeLine(profile.profile)}: could not revoke the key (${profile.error})`);
  }
  if (pasted.length > 0) {
    out(
      `  Pasted keys are removed here but still valid: ${pasted.map((p) => safeLine(p.profile)).join(", ")}.`,
    );
    out(
      `  This CLI did not mint them, so it cannot revoke them. Revoke them at ${CONSOLE_KEYS_URL}`,
    );
  }
  if (unreadable.size > 0) {
    out(
      `  Could not read the sign-in for: ${[...unreadable].map(safeLine).join(", ")}, so it was kept. Unlock the keychain or fix the credential store, then run aiand logout --all again.`,
    );
  }
  const revocable = [...retained].filter((name) => !unreadable.has(name));
  if (revocable.length > 0) {
    out(
      `  Kept the sign-in for: ${revocable.map(safeLine).join(", ")}. Its refresh token is the only thing here that can revoke the key, so run aiand logout --all again when ai& is reachable.`,
    );
    out(
      `  To forget it here without revoking, run aiand logout --all --keep-remote, then revoke the key at ${CONSOLE_KEYS_URL}`,
    );
  } else if (revokeFailed.length > 0 && !opts.keepRemote) {
    out(`  Those keys are still valid: revoke them at ${CONSOLE_KEYS_URL}`);
  }
  for (const agent of agents) {
    if (agent.error) out(`  ${agent.agent}: could not strip its config (${agent.error})`);
    else if (agent.stripped) out(style.dim(`  ${agent.agent}: ai& removed`));
    for (const note of agent.notes ?? []) out(style.dim(`  ${agent.agent}: ${safeLine(note)}`));
  }
  for (const file of keysLeft) {
    out(`  An ai& key is still in ${safeLine(file)}; fix that file by hand and delete the key.`);
  }
  if (overlays.removed.length > 0) {
    out(style.dim(`  Deleted ${overlays.removed.length} leftover session overlay(s).`));
  }
  for (const dir of overlays.inUse) {
    out(
      `  A running aiand session still uses ${safeLine(dir)}; it is deleted when that session ends.`,
    );
  }
  if (target === null) {
    out(style.dim(`  ${safeLine(shownTarget)} did not exist.`));
  } else if (wipe.removed) {
    out(style.dim(`  Deleted ${safeLine(target)}.`));
  } else {
    for (const entry of wipe.kept.filter((name) => name.startsWith("snapshots/"))) {
      const agent = safeLine(String(entry.split("/")[1]));
      out(
        `  Kept ${safeLine(target)}/${safeLine(entry)}: ${agent} still has ai& wired in. Fix its config, run aiand ${agent} off, then run aiand logout --all again.`,
      );
    }
    if (left.length > 0) {
      out(
        `  Emptied ${safeLine(target)} of aiand's files but left it: it also holds ${left.map(safeLine).join(", ")}.`,
      );
    }
  }
  for (const problem of problems) out(`  ${problem}`);
}
