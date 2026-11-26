import { CliError } from "./cli/errors.js";

/** Refuse a file-based key store in a git work tree unless explicitly allowed. */
export async function refuseGitWorkTree(path: string): Promise<void> {
  // managed-file.ts uses the atomic writer, which also needs this check.
  // Load it only for a store write so the two modules do not form a static cycle.
  const { ALLOW_GIT_TRACKED_ENV, gitWorkTreeFor } = await import("./agents/managed-file.js");
  const tracked = await gitWorkTreeFor(path);
  if (tracked !== null && process.env[ALLOW_GIT_TRACKED_ENV] !== "1") {
    throw new CliError(
      `Refusing to keep your ai& key in ${tracked.real}: it is inside the git repository at ${tracked.repo}.`,
      {
        hint: `Move the config directory out of the repository (set AIAND_CONFIG_DIR), or add it to the repository's .gitignore and re-run with ${ALLOW_GIT_TRACKED_ENV}=1.`,
      },
    );
  }
}
