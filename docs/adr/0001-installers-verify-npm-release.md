# 1. The installers verify release artifacts before activation

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

Option 3 whenever the existing Node-minimum probe succeeds. On that route the
installer:

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

For a release install or `update` where Node is absent or fails that probe, the
installer instead selects a host-native prebuilt route before downloading the
release. That route:

- resolves the release and its version through the same single tarball line in
  `SHA256SUMS`, with the same 0.8.0 floor and implicit-downgrade refusal.
- maps the host explicitly to one of `aiand-darwin-arm64`,
  `aiand-darwin-x64`, `aiand-linux-x64`, `aiand-linux-arm64`, or
  `aiand-win32-x64.exe`, the names produced by `scripts/build-prebuilt.mjs`.
  Any other host stops without replacing the installation.
- requires exactly one lowercase sha256 line for that selected asset and one
  for each of `install.sh` and `install.ps1`. It downloads all three from the
  resolved `/download/v<version>/` URL, including after an unpinned latest
  lookup, and checks every downloaded byte against those lines before staging.
- stages the native file as `aiand` or `aiand.exe`, a minimal `@aiand/cli`
  `package.json` with the resolved version, the two verified installer scripts,
  and the usual installer-ownership marker. It requires no `dist/index.js`.
- executes the staged native file directly, never through Node, npm, or a PATH
  runtime lookup. Its `--version` must equal the resolved release exactly and
  its `--help` must exit zero before activation and launcher installation.

In `install.sh`, the launcher selects the installed npm or prebuilt layout at
runtime. When replacing an existing installation, the installer verifies the
staged release, writes a temporary launcher beside
`~/.local/bin/aiand` and renames it into place before swapping the installation
directories. An interruption after the swap therefore leaves a launcher that
can run the new layout. The launcher also retains the previous absolute Node
path when Node is no longer on PATH, so restoring the old npm installation still
works. The existing recovery for an interruption between the two directory moves
is unchanged: a handled signal restores the old directory, while SIGKILL needs
the next installer run to restore it before downloading anything. For a first
activation at a new location, the directory is activated before the launcher is
published: a failed move must leave any launcher for another checkout untouched.

A local checkout and `AIAND_SOURCE` remain development builds: they still go
through the toolchain check and require suitable Node, npm, and git as before.
Selecting a release route is not a retry mechanism. Once npm has been selected,
a manifest, download, unpack, integrity, or verification failure never retries
with prebuilt; a prebuilt failure likewise stops. Every such failure preserves
the previous installation.

Publication of the five prebuilt host assets is a separate later change. This
slice adds their installer contract and loopback-tested behavior; it neither
publishes those assets nor changes the release workflow. `publish.yml` runs `npm pack` once, publishes that exact tarball, waits until
the registry serves the same sha512, and only then creates the GitHub
release with `SHA256SUMS` (plus `install.sh` and `install.ps1`). A first run
packs from the tagged checkout; if the draft release already holds a tarball
of that name, it has to be byte-identical to that pack or the run stops. Only
a resumed run (npm already has the version) takes a tarball from the draft
release instead of packing, and it still requires npm to serve those exact
bytes. The draft is published only when it holds exactly those four assets, so
one someone else attached is never published with them. The job runs in the GitHub environment `release`, which is what the
next section depends on.

There's no fallback to `main`, and no retry on the other release-verification
route. With no usable release asset, a 404, or a 403/429 rate limit, the
selected route prints why and exits with the existing install untouched.
`AIAND_SOURCE` still clones and builds a source. It's for development only:
the installer labels the result as unverified, retains its toolchain
requirements, and the source allowlist still applies.

### What has to be set up outside this repository

"Two parties" is only true if publishing to npm takes more than write access
to this repository. npm's trusted publishing authenticates the workflow, not
the ref it ran for, so the credential the publish step uses is whatever
GitHub hands to a run of `publish.yml`. These settings live outside the
repository's files; `publish.yml` and this ADR assume them, and nothing in the
repository can check that they are in place:

1. GitHub environment `release` (Settings, Environments): required reviewers
   other than whoever pushes the tag, and deployment branches and tags
   limited to the selected tag pattern `v*`, with no branch allowed.
2. npm trusted publisher for `@aiand/cli` (package Settings, Trusted
   Publisher): repository `aiandlabs/aiand-cli`, workflow filename
   `publish.yml`, environment name `release`. With the environment named
   there, npm only mints a publish credential for a run that went through
   it. Set the package's publishing access to require two-factor
   authentication and disallow tokens, so a token cannot publish around
   the environment. `publish.yml` passes no token.
3. A tag ruleset on `v*` (Settings, Rules, Rulesets, target: tags): creation,
   update, and deletion restricted to the release maintainers, with force
   pushes blocked. Without it anyone with write access can push a `v*` tag,
   and a moved or deleted tag changes what the environment is asked to
   approve.
4. A branch rule on `main` that requires a pull request, so a commit reaches
   the tagged history only through review. (`publish.yml` already requires the
   tag to be on `main` with a green CI run; that is only as strong as who can
   push to `main`.)

With all four in place, publishing needs a maintainer to create the tag and
a reviewer to approve the run, and a push, a branch, or a draft release made
with write access alone publishes nothing.

Until they are in place, the claim in Consequences does not hold. Someone with
only GitHub write access can push a commit to `main` (the existing rules block
deletion and force pushes, nothing more), tag it `v<next version>`, and
publish. `publish.yml` then packs that commit's bytes, npm accepts them over
OIDC, and the `SHA256SUMS` it attaches matches, so a correct installer
installs them. They can also edit the assets of a release that already
exists. Everything the installers check would pass, because both parties are
the same workflow.

Even with all four, GitHub write access can still replace the bootstrap
script that a fresh one-liner downloads (below), and whoever administers the
repository or the npm package can change these settings. Only the second is a
different party's account. The installers cannot tell that apart from a
release.

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
- `install.sh update` (and `install.ps1 update`) run the preserved copy of
  the script from the installed release. An npm install verified it with the
  tarball's two-party check; a prebuilt install verified its downloaded bytes
  against the selected GitHub release's `SHA256SUMS`. From the second install
  on, the script that decides was itself checked during preservation. Running
  the one-liner again downloads a new bootstrap instead, which is the
  first-use trust again.

A reader who wants no GitHub trust in the bootstrap installs from npm
(`npm install -g @aiand/cli`), which trusts npm alone.

## Consequences

- The tarball an installer installs has to satisfy two parties, npm and the
  GitHub release. That makes control of only GitHub, or only npm, not enough
  to put new bytes past a correct installer, **provided the settings in
  "What has to be set up outside this repository" are in place**: the
  protected `release` environment, the npm trusted publisher bound to it, and
  the tag ruleset. Without them, GitHub write access alone is enough (see
  that section for what it can do), because the same workflow speaks for
  both parties. With them, npm versions are immutable, so control of GitHub
  alone can only point a correct installer at an older published version (a
  downgrade). The installers refuse that unless `AIAND_VERSION` asks for it,
  and never go below 0.8.0. Once the package disallows tokens, no npm
  token can publish at all; until then, a stolen one can publish a version
  that no GitHub release vouches for.
- The prebuilt route deliberately applies when npm's Node runtime cannot run,
  so it cannot borrow npm's sha512 for an executable npm does not serve. That
  route trusts the selected GitHub release's `SHA256SUMS`: the executable and
  both preserved installer scripts must match their listed sha256 values, and
  the executable runs only after its direct version and help probes pass.
  This is integrity pinning to GitHub, not the tarball route's independent
  npm-plus-GitHub check. The version probe happens after, and never instead
  of, the digest check.
- Those claims are about the release artifacts, not the initial installer
  script. On a fresh install, GitHub alone is enough to run arbitrary code,
  through the bootstrap script (see above).
- Release installs do not run `npm ci` or a TypeScript build. The suitable-Node
  route runs the zero-dependency tarball as unpacked and needs Node, but not
  git or npm as commands. The prebuilt route needs neither Node, npm, git, nor
  `dist/index.js`; its launcher executes the verified native file directly.
  Development installs still build and retain their toolchain requirements.
- Releases from before this change have no `SHA256SUMS`. The installers
  can't install them, and they fail clearly until the first release
  published with the new `publish.yml` (0.8.0).
- `install.sh` and `install.ps1` ship in the npm package. A prebuilt install
  separately downloads and verifies them before preserving them. Uninstall
  and `update` run the preserved copies from `~/.aiand/cli`, and an update
  always selects and fetches a release rather than rebuilding that install.
- Node's `fetch` in the npm release helper doesn't use `HTTPS_PROXY`. This
  limitation belongs to the suitable-Node route; the prebuilt route uses curl
  in Bash and native web/.NET APIs in PowerShell rather than that helper.
- Neither sha512 nor sha256 is a signature. Releases published with provenance
  carry an npm attestation, but checking it needs Sigstore verification that
  a shell script can't do without new tooling. This prebuilt slice adds no
  signature verification, notarization, release attestation verification, or
  npm sha512 for a binary npm does not serve. Those remain separate concerns.
