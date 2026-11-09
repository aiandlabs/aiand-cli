# 1. The installers install the npm release, checked against npm and GitHub

Status: accepted, 2026-11

## Context

`install.sh` and `install.ps1` used to `git clone --depth 1` the main
branch and build it. That skipped everything a release goes through: the
`v<version>` tag, the green CI run on that commit, and npm's immutable
version. Nothing checked what was cloned, and a second run of the
installed copy rebuilt the same commit instead of updating.

Three designs were considered:

1. Clone the release tag (`--branch v<version>`) and check that the
   checked-out commit is the one the tag points to. Every input comes from
   GitHub, so a compromised GitHub, or a tag moved after the fact, still
   installs whatever it serves. It still runs `npm ci` and the TypeScript
   build on the user's machine.
2. Install the npm tarball and check it against npm's `dist.integrity`.
   The tarball and its hash come from the same registry, so this
   catches corruption in transit, not a registry that lies.
3. Install the npm tarball and require it to match two hashes from two
   parties: npm's `dist.integrity` (sha512) and a `SHA256SUMS` asset that
   `publish.yml` attaches to the GitHub release.

## Decision

Option 3. The installer:

- reads `SHA256SUMS` from the GitHub release (`releases/latest/download/`,
  or `releases/download/v$AIAND_VERSION/`). The single `aiand-cli-<version>.tgz`
  line in that file names the version. These are plain release-download
  URLs, not the REST API, so a shared IP doesn't hit the 60-request hourly
  limit for unauthenticated API calls.
- fetches `@aiand/cli@<version>` from the npm registry. It requires the
  manifest's `dist.tarball` to be the registry's own URL for that version
  and `dist.integrity` to be a sha512.
- downloads the tarball and stops unless both its sha512 matches npm and
  its sha256 matches `SHA256SUMS`.
- unpacks only regular files and directories under `package/`, refusing
  links, absolute paths, and `..`. It then runs the shipped
  `dist/index.js --version` against the expected version before swapping the
  install in.
- refuses to move backwards. A resolved version lower than the installed
  `package.json` version stops the install unless `AIAND_VERSION` names it,
  and no version below 0.8.0, the first release published with a
  `SHA256SUMS`, is installable at all, pinned or not. The floor is a constant
  in the helper (`FIRST_SUMS_RELEASE`); without it, a `SHA256SUMS` forged on
  GitHub for any older npm version would pass both checks.

`publish.yml` runs `npm pack` once, publishes that exact tarball, waits until
the registry serves the same sha512, and only then creates the GitHub
release with `SHA256SUMS` (plus `install.sh` and `install.ps1`).

There's no fallback. With no release, a 404, or a 403/429 rate limit, the
installer prints why and exits with the existing install untouched. It never
falls back to `main`. `AIAND_SOURCE` still clones and builds a source. It's
for development only: the installer labels the result as unverified, and
the source allowlist still applies.

### The bootstrap script is trusted on first use

The two-party check covers the tarball. It does not cover the script that
runs it. A fresh install runs `install.sh` or `install.ps1` as fetched over
HTTPS from GitHub, before anything is verified, so GitHub alone decides what
that script checks and can make it skip every check, or run anything else
as the user. No later step in the script can repair that.

Two things narrow the gap without closing it:

- The README one-liners fetch the script from the latest GitHub release's
  assets (`releases/latest/download/install.sh` and `install.ps1`), which
  `publish.yml` attaches, instead of `raw.githubusercontent.com/.../main`.
  A push to main no longer changes what new users run; publishing a release
  does, and that takes a tag on a commit on main with a green CI run. This
  is still GitHub alone, so it raises the bar rather than adding a second
  party.
- `install.sh update` (and `install.ps1 update`) run the copy of the script
  that shipped inside a tarball an earlier run verified. From the second
  install on, the script that decides is itself two-party checked. Running
  the one-liner again downloads a new bootstrap instead, which is the
  first-use trust again.

A reader who wants no GitHub trust in the bootstrap installs from npm
(`npm install -g @aiand/cli`), which trusts npm alone.

## Consequences

- The tarball an installer installs has to satisfy two parties. Control of
  only GitHub, or only npm, is not enough to put new bytes past a correct
  installer. npm versions are immutable, so control of GitHub alone
  can only point a correct installer at an older published version (a
  downgrade). The installers refuse that unless `AIAND_VERSION` asks for it,
  and never go below 0.8.0. A stolen npm token can publish a new
  version, but no GitHub release vouches for it.
- That claim is about the tarball, not the installer script. On a fresh
  install, GitHub alone is enough to run arbitrary code, through the
  bootstrap script (see above).
- Installs no longer run `npm ci` or a TypeScript build. The CLI has zero
  runtime dependencies, so the tarball runs as unpacked. The release path
  needs only Node, not git or npm.
- Releases from before this change have no `SHA256SUMS`. The installers
  can't install them, and they fail clearly until the first release
  published with the new `publish.yml` (0.8.0).
- `install.sh` and `install.ps1` ship in the npm package. Uninstall and
  `update` run them from `~/.aiand/cli`, and that copy always fetches a
  release rather than rebuilding itself.
- Node's `fetch` doesn't use `HTTPS_PROXY`. A machine that reaches the
  internet only through a proxy needs `npm install -g @aiand/cli` instead.
- Neither hash is a signature. Releases published with provenance carry an
  npm attestation, but checking it needs Sigstore verification that a
  shell script can't do without new tooling. It can be added later as a
  third check without changing this flow.
