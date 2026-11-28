# 3. The installers take company mirrors and offline bundles

Status: accepted, 2026-11

## Context

[ADR 1](0001-installers-verify-npm-release.md) has the installers check every
release against two parties: npm's sha512 for the tarball and the sha256 in
the GitHub release's `SHA256SUMS`. It allowed exactly two origins,
`registry.npmjs.org` and `github.com/aiandlabs/aiand-cli/releases`, plus a
loopback double for the tests.

Machines in many companies reach neither. Users there have no admin rights and
only a company npm registry (Artifactory, Nexus, Verdaccio), a company download
mirror, or a file share. With only the two public origins allowed, the
installers could not be used there at all, and `npm install -g @aiand/cli`
through the company registry skipped the `SHA256SUMS` check.

## Decision

The installers keep both checks and let IT choose where the files come from.

- **npm registry.** The helper asks npm which registry it would use
  (`npm config get @aiand:registry registry`, which reads the environment,
  `.npmrc` and the global `npmrc`). When that is not `registry.npmjs.org`, it
  fetches the exact version with `npm pack @aiand/cli@<version>
  --ignore-scripts`, so npm's own handling of that registry's credentials,
  proxy and CA applies, and npm checks the tarball against the registry's
  integrity. The helper then compares the bytes with the sha512 npm reports
  and with the sha256 in `SHA256SUMS`. The public registry keeps the original
  fetch path. A failure stops the install; nothing falls back to the public
  registry.
- **Download mirror.** `--mirror` or `AIAND_DOWNLOAD_BASE` replaces
  `https://github.com/aiandlabs/aiand-cli/releases` with any `https://` base
  of the same layout, with no user name, password, query or fragment (they
  would be printed in every error). `SHA256SUMS` and the prebuilt executables
  come from it; a failure stops the install. `AIAND_INSTALL_RELEASES_URL`
  stays the tests' loopback-only override.
- **Offline bundle.** `--from` or `AIAND_FROM` names an archive or directory
  holding a release's `SHA256SUMS`, npm tarball, installer scripts and the
  platform's prebuilt when there is one. Nothing is downloaded. Every file
  used must match that `SHA256SUMS`; links are not followed. There is no npm
  manifest offline, so the bundle's `SHA256SUMS` is the one check.
  `publish.yml` builds the bundles with `scripts/offline-bundle.mjs`, which
  checks each file against the release's `SHA256SUMS` first, and attaches
  them with `SHA256SUMS.offline`.
- **Pinning.** `--sums-sha256` or `AIAND_SUMS_SHA256` requires the
  `SHA256SUMS` read, from a mirror or a bundle, to have that sha256. One value
  covers every platform's bundle of a release.

The 0.8.0 floor, the refusal to downgrade without `AIAND_VERSION`, the size
limits and the unpack rules are unchanged on every route.

## Consequences

- A mirror is trusted to copy faithfully. Where the npm registry and the
  download mirror are separate systems, they are still two parties; where
  one product serves both, they are one. An offline bundle is one party: it
  is only as good as the copy IT checked against `SHA256SUMS.offline` and
  put on a share users cannot write. `--sums-sha256` ties either to one known
  release.
- The npm route through a company registry needs npm next to Node, which
  every Node distribution ships.
- Install locations are unchanged and per user on every OS (`~/.aiand/cli`,
  `~/.local/bin`, the user's PATH), so moving them was not needed for
  installs without admin rights, and existing installs keep updating in place.
