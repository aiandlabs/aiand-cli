### Added

- Added offline installs: `install.sh --from` and `install.ps1 --from` install from an offline bundle, an archive or directory holding a release's `SHA256SUMS`, npm tarball, installer scripts and the platform's prebuilt, with no network, checking every file against that `SHA256SUMS`. Each release now publishes one bundle per platform (`aiand-offline-<version>-<platform>.tar.gz`, `.zip` for Windows) and `SHA256SUMS.offline`.
- Added company download mirrors: `--mirror` takes an `https://` mirror of the GitHub releases for `SHA256SUMS` and the prebuilt executables, the install remembers it for `update`, and a failing mirror stops the install instead of falling back to GitHub. Only the command line chooses a mirror or bundle; no environment variable does.
- Added `--sums-sha256` (`AIAND_SUMS_SHA256`), which stops an install unless the `SHA256SUMS` it reads, from a mirror or a bundle, has that sha256. A mirror or bundle supplies its own `SHA256SUMS`, so this pin is what ties it to the real release.
- `install.ps1` unpacks a `.zip` bundle in PowerShell Constrained Language Mode too, with `Expand-Archive` or `tar`.
- Added the IT administrator install guide (`docs/it-admin-install.md`, in English and Japanese): per-user locations with no admin rights, company mirrors, offline bundles, and agent installs.

### Changed

- The installers now take the npm tarball from the registry in the npm config (`npm config get registry`, `NPM_CONFIG_REGISTRY`, `.npmrc`, or an `@aiand` scope registry). A registry other than `registry.npmjs.org` is fetched through `npm pack`, so its credentials, proxy and CA settings apply, and the tarball must still match both that registry's sha512 and the release's `SHA256SUMS`. A failing registry stops the install; nothing falls back to the public one.
- A failed agent install now says that npm uses the registry in the npm config, and, outside Windows, how to point npm's global installs at a folder the user owns when there are no admin rights.
