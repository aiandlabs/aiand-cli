# IT administrator install guide

**English** | [日本語](it-admin-install.ja.md)

This guide is for machines where users have no admin rights, and where GitHub
and `registry.npmjs.org` may be out of reach: only a company npm registry
(Artifactory, Nexus, Verdaccio), a company download mirror, or a file share.
It covers `install.sh` (macOS, Linux, Git Bash) and `install.ps1` (Windows
PowerShell 5.1 and PowerShell 7). For the CLI's own traffic after install, see
the [IT administrator network and proxy guide](it-admin-network.md).

## No admin rights needed

The installers write only to the user's home directory and never ask for
elevation.

| What | macOS and Linux | Windows |
| --- | --- | --- |
| The CLI | `~/.aiand/cli` | `%USERPROFILE%\.aiand\cli` |
| The `aiand` launcher | `~/.local/bin/aiand` | `%USERPROFILE%\.local\bin\aiand.cmd` |
| PATH | a line in the user's shell rc files | the user's `Path` (HKCU), never the machine's |
| Profiles and sign-in | `~/.config/aiand` | `%USERPROFILE%\.config\aiand` |

`AIAND_DIR` moves the CLI elsewhere. `AIAND_NO_MODIFY_PATH=1` leaves PATH alone,
for machines where IT manages it.

Two routes, picked automatically:

- **Node.js 22 or newer on PATH**: the installer unpacks the npm tarball of the
  release and runs it with that Node.
- **No suitable Node**: the installer uses the release's prebuilt executable
  for the platform (`aiand-win32-x64.exe`, `aiand-darwin-arm64`, and so on),
  which needs no Node at all. Where application control (AppLocker, WDAC)
  blocks executables under the user profile, allow
  `%USERPROFILE%\.aiand\cli\aiand.exe`, or install Node 22 or newer where it is
  allowed and use the Node route.

## What the installer reaches by default

| Origin | What for |
| --- | --- |
| `https://github.com/aiandlabs/aiand-cli/releases` (and the `*.githubusercontent.com` host its downloads redirect to) | `SHA256SUMS`, the installer scripts, the prebuilt executables |
| `https://registry.npmjs.org` | the npm tarball (Node route only) |

Every install is checked before it replaces anything: the npm tarball must
match both npm's sha512 and the sha256 in the release's `SHA256SUMS`; a
prebuilt must match `SHA256SUMS` and report the expected version. A failed check
leaves the existing install as it was.

When those origins are blocked, use company mirrors or an offline bundle.

> **Pin the release with `--sums-sha256`.** A mirror or a bundle supplies its
> own `SHA256SUMS`, and the installer checks every file against that copy. So
> the checks alone prove only that the files match each other, not that they
> are the real release. `--sums-sha256 <hex>` is what ties a mirror or bundle
> to the release published on GitHub: use it on every install from one. See
> [Pinning the release](#pinning-the-release).

## Option 1: company mirrors

### npm registry

The installer uses the registry in the npm config, the same one `npm install`
uses: `npm config get registry`, which reads `NPM_CONFIG_REGISTRY`,
`npm_config_registry`, the user's `.npmrc` and the global `npmrc`. An `@aiand`
scope registry (`@aiand:registry=…`) wins over it. When that registry is not
`registry.npmjs.org`, npm itself fetches the tarball, so the credentials,
proxy and CA settings in the npm config apply.

```bash
npm config set registry https://artifactory.example.com/api/npm/npm-remote/
```

The registry must serve `@aiand/cli` (a remote or proxy repository of
`registry.npmjs.org` does). If it fails, the install stops: nothing falls back
to the public registry.

### Download mirror

`SHA256SUMS` and the prebuilt executables come from GitHub releases, not npm.
Mirror `https://github.com/aiandlabs/aiand-cli/releases` (an Artifactory or
Nexus generic remote repository, or any web server) with the same layout:

```text
<base>/latest/download/SHA256SUMS
<base>/download/v<version>/SHA256SUMS
<base>/download/v<version>/<file>
```

Then point the installer at it with `--mirror <base>`. The base must be
`https://`, with no user name, password, query or fragment, and readable
without signing in. If the mirror cannot serve `latest`, also set
`AIAND_VERSION` to the release to install.

The mirror is only ever taken from the command line or the managed policy
below. No environment variable redirects it, so a directory's `.envrc` or a
stray shell profile cannot send an install to another server. The npm registry
is different on purpose: it follows npm's own config, as `npm install` does.
That cannot change what installs either, because the tarball from any
registry must still match the sha256 in the release's `SHA256SUMS`.

macOS and Linux:

```bash
bash install.sh --mirror https://artifactory.example.com/artifactory/github-aiand-cli/releases
```

Windows: `irm … | iex` takes no arguments, so download the script and run it
as a file.

```powershell
$base = 'https://artifactory.example.com/artifactory/github-aiand-cli/releases'
irm "$base/latest/download/install.ps1" -OutFile "$env:TEMP\install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1" --mirror $base
```

A mirror that fails stops the install; nothing falls back to GitHub.

The install keeps no record of the mirror, because a file in the user's home
could be changed by any program the user runs. So `update` needs `--mirror`
again:

```bash
bash ~/.aiand/cli/install.sh update --mirror https://artifactory.example.com/artifactory/github-aiand-cli/releases
```

Without it, `update` goes to GitHub, and where GitHub is out of reach it stops
with a message naming `--mirror`. To make the mirror the default for every
user, with no flag, set the `downloadMirror` managed policy.

### The `downloadMirror` managed policy

The CLI's managed policy lives where only administrators can write, and the
installers read `downloadMirror` from the same places:

| OS | Where | Value |
| --- | --- | --- |
| Windows | `HKLM\Software\Policies\aiand\cli` (or `HKCU\Software\Policies\aiand\cli`; the machine key wins), Group Policy or Intune | `downloadMirror`, a `REG_SZ` |
| macOS | `/Library/Managed Preferences/com.aiand.cli.plist`, a configuration profile for `com.aiand.cli` from MDM | `downloadMirror`, a string |
| Linux | `/etc/aiand/policy.json`, a regular file owned by root | `{"downloadMirror": "https://…"}` |

```powershell
# Windows, as an administrator (or the same value through Group Policy)
New-Item -Path 'HKLM:\Software\Policies\aiand\cli' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\Software\Policies\aiand\cli' -Name downloadMirror -Value 'https://artifactory.example.com/artifactory/github-aiand-cli/releases'
```

With the policy set, installs and updates use that mirror without a flag. A
`--mirror` naming a different URL is refused, and a policy file that is not a
regular file owned by root is refused rather than ignored. `--from` still
installs a bundle.

Both checks still apply: the tarball from the company registry must match the
sha512 that registry lists and the sha256 in the mirrored `SHA256SUMS`. The
mirrors are trusted to copy the originals faithfully; to tie an install to one
known release, pin its `SHA256SUMS` (see
[Pinning the release](#pinning-the-release)).

## Option 2: offline bundle

Each release from this version on publishes one archive per platform, plus a
checksum file for them:

| Asset | For |
| --- | --- |
| `aiand-offline-<version>-win32-x64.zip` | Windows x64 |
| `aiand-offline-<version>-darwin-arm64.tar.gz` | macOS, Apple silicon |
| `aiand-offline-<version>-darwin-x64.tar.gz` | macOS, Intel |
| `aiand-offline-<version>-linux-x64.tar.gz` | Linux x64 |
| `aiand-offline-<version>-linux-arm64.tar.gz` | Linux arm64 |
| `SHA256SUMS.offline` | the sha256 of each archive |

Each archive holds one directory, `aiand-offline-<version>-<platform>`, with the
release's `SHA256SUMS`, its npm tarball, `install.sh`, `install.ps1` and, when
the release publishes one, the platform's prebuilt executable. A bundle without
a prebuilt still installs anywhere Node 22 or newer is on PATH.

### Prepare the share (once per release)

On a machine that can reach GitHub, download the archives you need, plus
`SHA256SUMS.offline` and `SHA256SUMS`, from the release page, and check them:

```bash
sha256sum --check --ignore-missing SHA256SUMS.offline
sha256sum SHA256SUMS   # note this value for --sums-sha256
```

```powershell
Get-FileHash .\aiand-offline-<version>-win32-x64.zip -Algorithm SHA256   # compare with SHA256SUMS.offline
Get-FileHash .\SHA256SUMS -Algorithm SHA256                              # note this value for --sums-sha256
```

Copy the archives to a share users can read but not write. For Windows, also
unpack the `.zip` there, so users can run the `install.ps1` inside it.

### Install from the share

`--from` takes the archive or its unpacked directory. Nothing
is downloaded, and every file used is checked against the bundle's `SHA256SUMS`
before anything is replaced.

macOS and Linux:

```bash
tar -xzf /mnt/share/aiand/aiand-offline-<version>-linux-x64.tar.gz -C /tmp
bash /tmp/aiand-offline-<version>-linux-x64/install.sh \
  --from /mnt/share/aiand/aiand-offline-<version>-linux-x64.tar.gz \
  --sums-sha256 <sha256 of SHA256SUMS>
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File \\fileserver\aiand\aiand-offline-<version>-win32-x64\install.ps1 `
  --from \\fileserver\aiand\aiand-offline-<version>-win32-x64 `
  --sums-sha256 <sha256 of SHA256SUMS>
```

`-ExecutionPolicy Bypass` applies to that one process only; it changes no
policy on the machine.

To update, run the installed copy against the next release's bundle:

```bash
bash ~/.aiand/cli/install.sh update --from /mnt/share/aiand/aiand-offline-<next>-linux-x64.tar.gz
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update --from \\fileserver\aiand\aiand-offline-<next>-win32-x64
```

## Pinning the release

Without a pin, a mirror or bundle is trusted as it is: it supplies the
`SHA256SUMS` the installer checks against, so whoever can change the mirror or
the share can change what installs, and the checks still pass.
`--sums-sha256 <hex>` is the one thing that ties it to the real release. The
install stops unless the `SHA256SUMS` it reads has exactly that sha256.

Take the value from the `SHA256SUMS` on the GitHub release page, as above.
Every platform's bundle of one release carries the same `SHA256SUMS`, so one
value covers them all. `AIAND_SUMS_SHA256` sets the same pin from the
environment; it can only make an install stop, never change where files come
from.

## After install

- **Update notices.** In an interactive terminal the CLI checks
  `registry.npmjs.org` for a newer version once a day. Offline the check fails
  quietly; set `AIAND_UPDATE_CHECK=0` to skip it.
- **Sign-in and use.** `aiand login` and the coding agents need the ai&
  gateway; see the [network and proxy guide](it-admin-network.md).
- **Coding agents.** When an agent is missing, `aiand <agent>` offers to run
  that agent's exact `npm install -g <package>@<version>` command, and otherwise
  prints it for IT to run. npm installs from the registry in the npm config, so
  a company registry set there is the one used. Without admin rights on macOS
  and Linux, npm's global installs need a folder the user owns first:
  `npm config set prefix "$HOME/.local"` puts agents in `~/.local/bin`, next to
  `aiand`. On Windows npm's default global folder is already per user.

## Reference

| Flag | Variable | Meaning |
| --- | --- | --- |
| `--from <path>` | | install from an offline bundle (archive or directory) |
| `--mirror <url>` | | download release files from this https mirror (also on `update`) |
| | `downloadMirror` (managed policy) | the mirror for every install and update, set by an administrator |
| `--sums-sha256 <hex>` | `AIAND_SUMS_SHA256` | the `SHA256SUMS` read must have this sha256 |
| | `AIAND_VERSION` | install this release instead of the latest |
| | `NPM_CONFIG_REGISTRY` | npm's registry (or `npm config set registry`) |

A flag wins over its variable. `--from` and `--mirror` cannot be combined.
