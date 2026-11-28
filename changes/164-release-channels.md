### Added

- Every merge to `main` that passes CI is published to npm as `@aiand/cli@next`, with provenance. Install it with `install.sh --channel next`, `install.ps1 -Channel next`, `AIAND_CHANNEL=next`, or `npm install -g @aiand/cli@next`. The installers check a next build against npm's sha512 and the `SHA256SUMS` on the `next` prerelease, as they do a release, and an install of a next build stays on next when it updates.
- Fixes can be released from a `release/<major>.x` branch, and a `backport-<major>.x` label on a pull request into `main` opens a pull request that cherry-picks it there.

### Changed

- Publishing packs the tarball once in a build job with read access only. The publish job uploads only that tarball, after checking its sha256 and sha512.
