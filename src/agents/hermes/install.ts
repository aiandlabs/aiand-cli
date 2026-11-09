/**
 * The Hermes Agent install pin and hint. Kept apart from adapter.ts so the
 * release pin has one home: check-dist reads HERMES_COMMIT and
 * HERMES_INSTALL_SHA256 from dist/agents/hermes/install.js (the module path
 * the scripts and docs cite) and compares them against the pins in ci.yml and
 * scripts/contree-e2e.sh. Neither the pin nor the digest lives in adapter.ts.
 */

/**
 * The Hermes Agent commit the live matrix installs and the user-facing
 * install hint pins: the installer is `curl … | bash -s -- --commit <sha>`,
 * so the pin is a commit, not a semver.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_COMMIT = "666f313d1d3abd8077291ba464cf0a10f1a6157f";

/**
 * The sha256 of the Hermes installer script (scripts/install.sh) at
 * HERMES_COMMIT: CI and scripts/contree-e2e.sh download it from
 * raw.githubusercontent.com at the pinned commit and verify it with
 * `sha256sum -c` before running it. The pin and the digest move together;
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const HERMES_INSTALL_SHA256 =
  "0fbf2969c12b9ef9c90b81519814865faa9ee4e22056e2a9a4d0b1d5e59966e8";

/**
 * The Hermes Agent install, per platform. Unix downloads the installer at
 * HERMES_COMMIT from raw.githubusercontent.com to a temp file and runs it only
 * after `sha256sum -c` (macOS: `shasum -a 256 -c`) passes against
 * HERMES_INSTALL_SHA256, as ci.yml does. That replaces a `curl | bash` of
 * the site's script, which serves the main branch. A Windows shell cannot run
 * that line, so win32 gets the commit-pinned install.ps1 under iex, which
 * reports through $LASTEXITCODE instead of exiting the caller's window, with
 * the pin as a parameter. No digest of that script is recorded yet. The url
 * is the docs page.
 */
export function hermesInstallCommand(platform: NodeJS.Platform = process.platform): string {
  const base = `https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts`;
  if (platform === "win32") {
    return `iex "& { $(irm ${base}/install.ps1) } -Commit ${HERMES_COMMIT} -NonInteractive -SkipBrowser -SkipComputerUse`;
  }
  const verifier = platform === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  return `f="$(mktemp)" && curl -fsSLo "$f" ${base}/install.sh && echo "${HERMES_INSTALL_SHA256}  $f" | ${verifier} && bash "$f" --commit ${HERMES_COMMIT}`;
}

export const HERMES_INSTALL = {
  command: hermesInstallCommand(),
  url: "https://hermes-agent.nousresearch.com/docs/",
};
