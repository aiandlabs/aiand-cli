# Release channels

**English** | [日本語](release-channels.ja.md)

`@aiand/cli` comes in two channels. Both are published from this repository's
`publish.yml`, with npm provenance, and the installers check both the same way.

| Channel | npm dist-tag | What it is | Version looks like |
| --- | --- | --- | --- |
| stable | `latest` | A release: tagged, with a changelog section and a GitHub release | `0.9.0` |
| next | `next` | The newest build of `main` that passed CI | `0.9.1-next.20261128090503.g1a2b3c4` |

Use stable unless you want a fix before it is released, or want to try what is
coming. A next build passed the same CI as a release, but nobody has picked it
for a release yet, and it has no changelog section of its own.

## Install the next channel

With npm:

```bash
npm install -g @aiand/cli@next
```

With the installer (macOS, Linux, Git Bash):

```bash
curl -fsSL https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.sh | bash -s -- --channel next
```

With the installer (Windows PowerShell):

```powershell
$env:AIAND_CHANNEL = 'next'; irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1 | iex
```

`AIAND_CHANNEL=next` works for `install.sh` too. From a saved copy of the
script, the flag works on both: `install.sh --channel next`,
`install.ps1 -Channel next` (or `--channel next`).

The next channel needs Node 22 or newer. There are no prebuilt executables for
it, so on a machine without Node the installer stops and changes nothing.

## Stay on it, or go back

An install of a next build stays on next. `install.sh update` (and
`install.ps1 update`) install the newest next build.

To go back to releases:

```bash
bash ~/.aiand/cli/install.sh update --channel stable
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update -Channel stable
```

On Windows PowerShell 5.1, use `powershell` in place of `pwsh`.

A next build is newer than the release before it. So until the next release
is out, going back is a downgrade, and the installer refuses it. Either wait
for the release, or pick one with `AIAND_VERSION=x.y.z`. If `AIAND_CHANNEL=next`
is still set in that shell, clear it or pass `--channel stable` as well: the
installer refuses next together with `AIAND_VERSION`. With npm:
`npm install -g @aiand/cli@latest`.

## How a next build is checked

The installer reads `SHA256SUMS` from the `next` prerelease on GitHub
(`releases/download/next/SHA256SUMS`). That file names one tarball, and so one
version. The installer then downloads that version from npm, and installs it
only if it matches both npm's sha512 and the sha256 in that file. A release
gets the same two checks; see
[ADR 1](adr/0001-installers-verify-npm-release.md). The installer also refuses
a `next` prerelease that names anything other than a next build.

The `next` prerelease always names the build npm calls `next`. It is a
prerelease, so `releases/latest` never points at it.

## Versions

A next version is `<next patch>-next.<commit time>.g<short commit>`. The time is
the commit's, in UTC (`YYYYMMDDHHmmss`). So a next version:

- sorts above the release it follows, and below the next release;
- names the commit it was built from;
- is the same every time that commit is built, so a re-run cannot publish it twice.

`package.json` in the repository keeps the released version. The build sets the
next version only in the copy it packs.

## Fixes for an older major version

Once `main` moves to a new major version, fixes for the previous one land on a
`release/<major>.x` branch, for example `release/1.x`, and are released from
there. Such a release goes out on npm as `latest-<major>` (for example
`latest-1`) when `latest` is already a newer major, so `npm install @aiand/cli`
never moves backwards.

A pull request into `main` with the `backport-1.x` label is copied to
`release/1.x` once it merges: a bot opens a pull request with the change
cherry-picked. If the change does not apply cleanly, the bot comments on the
original pull request with the steps to do it by hand.
