### Added

- Added release-install and update fallbacks in both installers for hosts without suitable Node: the selected prebuilt executable and preserved installer scripts must match the resolved GitHub release's `SHA256SUMS`, and the executable must report the expected version and pass `--help` before activation.
- Added native launchers that execute the verified prebuilt directly, plus loopback installer fixtures and tests for channel selection, integrity and runtime verification, downgrade refusal, and preservation of existing installations.

### Changed

- Kept suitable Node on the existing npm sha512-plus-GitHub sha256 path and kept local-checkout and `AIAND_SOURCE` development installs dependent on their existing Node, npm, and git toolchain.
