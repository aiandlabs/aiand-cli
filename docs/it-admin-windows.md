**English** | [日本語](it-admin-windows.ja.md)

# IT administrator guide: managed Windows PCs

What `aiand` runs on a domain-joined or Intune-managed Windows PC, what
AppLocker, App Control for Business (WDAC), PowerShell Constrained Language
Mode, Microsoft Defender and redirected or roaming profiles do to it, and what
to allow. Network access, proxies and CA certificates are in the
[network and proxy guide](it-admin-network.md). How the Windows key store
works, and the PowerShell command line it runs, is in
[Windows key storage](windows-key-storage.md).

Nothing here needs administrator rights on the user's side. The installer
writes only under the user profile and to the user's `Path` in
`HKCU\Environment`.

## What runs, and from where

| What | Where | Kind | Default AppLocker rules |
| --- | --- | --- | --- |
| Node.js 22 or later | `%ProgramFiles%\nodejs\node.exe` (all-users install) | Executable, signed by the OpenJS Foundation | Allowed |
| Node.js installed for one user (nvm-windows, the per-user installer) | `%APPDATA%\nvm\…`, `%LOCALAPPDATA%\Programs\nodejs\…` | Executable | Blocked |
| aiand itself | `%USERPROFILE%\.aiand\cli\dist\*.js` (installer), or `node_modules\@aiand\cli` under `npm prefix -g` (npm) | JavaScript that `node.exe` reads | No rule applies |
| Installer launcher | `%USERPROFILE%\.local\bin\aiand.cmd` | Batch file | Blocked |
| npm launcher | `aiand.cmd` and `aiand.ps1` in `npm prefix -g` (default `%APPDATA%\npm`) | Batch file, script | Blocked |
| Prebuilt aiand, only when the PC has no Node.js 22+ | `%USERPROFILE%\.aiand\cli\aiand.exe`; checked first as `%USERPROFILE%\.aiand\.cli-staging-*\aiand.exe` | Executable | Blocked |
| Windows key store (DPAPI) | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command …` | Windows | Allowed |
| Owner-only file permissions, sign-in browser | `icacls.exe`, `whoami.exe`, `rundll32.exe url.dll,FileProtocolHandler`, `cmd.exe` in `System32` | Windows | Allowed |
| Installer, PATH update in Constrained Language Mode | `reg.exe query HKCU\Environment /v Path` | Windows | Allowed |
| Installer | `irm … \| iex` (no file), or `%USERPROFILE%\.aiand\cli\install.ps1` for `update` and `uninstall` | PowerShell script | Runs in Constrained Language Mode |

aiand never runs anything from `%TEMP%`. The installer downloads to `%TEMP%`
and moves verified files into the profile before running them.

## AppLocker

The default rules allow executables and scripts under `%WINDIR%` and
`%PROGRAMFILES%` only. With them:

- Node.js must be installed for all users, under Program Files.
- The `aiand.cmd` launcher is refused. The installer notices this, finishes the
  install, and prints the command that runs aiand without the launcher:
  `& 'C:\Program Files\nodejs\node.exe' '--disable-warning=ExperimentalWarning' '<profile>\.aiand\cli\dist\index.js' <command>`.
  That works with no extra rule, because `node.exe` is allowed and AppLocker
  has no rule type for a JavaScript file that `node.exe` reads.
- The prebuilt `aiand.exe` is refused, and the installer stops with a message
  naming application control. Install Node.js for all users instead: the
  installer then takes the Node.js route.

To let users type `aiand`, pick one:

1. **Install aiand for all users.** As an administrator (SCCM, an Intune Win32
   app, or an elevated Command Prompt):
   `npm install -g @aiand/cli@<version> --prefix "%ProgramFiles%\aiand"`, and add `%ProgramFiles%\aiand` to the machine `Path`. The launcher then lives
   under Program Files and the default rules allow it. Users cannot update it;
   ship new versions the same way.
2. **A path rule for the installer's launcher.** A script rule, Allow,
   Everyone, path `%OSDRIVE%\Users\*\.local\bin\aiand.cmd`. The user can write
   that file, so the rule lets them run any batch file they save under that
   name. A batch file can do nothing a user who may run `node.exe` cannot do
   already, but weigh that against your policy.

A batch file cannot carry a signature, so a publisher rule cannot cover
`aiand.cmd`. Release builds of `aiand.exe` are not signed yet; a hash rule made
with `Get-AppLockerFileInformation` on the verified file works, and must be
renewed for each release.

## App Control for Business (WDAC)

App Control governs executables, DLLs and PowerShell scripts, not batch
files, so `aiand.cmd` runs. Allow `node.exe` by its OpenJS Foundation signer
(a FilePublisher rule), or deploy it with a managed installer. The prebuilt
`aiand.exe` needs a hash rule until release builds are signed. In enforced
mode PowerShell runs every unsigned script in Constrained Language Mode, which
the installer supports (next section).

## PowerShell

**Constrained Language Mode.** AppLocker and App Control run a script they
have not approved, and the `irm … | iex` one-liner, in this mode, as does
`__PSLockdownPolicy`. The installer detects it, says so, and installs with
cmdlets only. What changes:

- The user `Path` is read with `reg.exe` and written through the registry
  provider, keeping its type. Windows is not told to reload it, so a new
  terminal opened from the old Explorer does not see it: sign out and back in.
- Messages go to the host stream rather than stderr.
- The Windows key store cannot be reached. aiand stores the key in an
  owner-only file in `%USERPROFILE%\.config\aiand\`, and `aiand status` says
  why. Set `AIAND_SECRET_STORE_MASTER_KEY` to encrypt that file at rest. A key
  saved before the policy arrived cannot be read; aiand says so, and
  `aiand login` stores it again in the file.

**Execution policy.** `irm … | iex` is not subject to it.
`powershell -ExecutionPolicy Bypass -File …\install.ps1 update` works under any
policy set with `Set-ExecutionPolicy`, but a policy set by Group Policy
(`MachinePolicy` or `UserPolicy`) wins over `-ExecutionPolicy`. Under a Group
Policy `AllSigned`, run the downloaded script as text for every action. The
one-liner updates as it is. To pass arguments, wrap the text in a script block,
which also works in Constrained Language Mode:

```powershell
iex "& { $(irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1) } uninstall"
```

Arguments are parsed by PowerShell as usual, so quote one that contains spaces.
Installer settings that are paths (a local release bundle, a download mirror)
are environment variables of their own, not arguments.

`install.ps1` is not signed yet. Under `RemoteSigned`, the copy the installer
keeps runs as a file, since nothing it downloads gets a Mark of the Web. A copy
saved from a browser does, and is refused: use the one-liner, or
`Unblock-File` on it.

## Microsoft Defender and SmartScreen

- **SmartScreen** checks files that carry a Mark of the Web when they are
  opened from Explorer. The installer's downloads carry none, and aiand starts
  from a terminal, so SmartScreen does not see it.
  **Smart App Control** (Windows 11) checks every executable and blocks the
  unsigned prebuilt `aiand.exe`; the Node.js route is unaffected.
- **ASR rule "Block executable files from running unless they meet a
  prevalence, age, or trusted list criterion"**
  (`01443614-cd74-433a-b99e-2ecdc07bfc25`) can block a new `aiand.exe`. Use the
  Node.js route, or add ASR-only exclusions for both paths it runs from: the
  staging copy the installer checks before activating it,
  `%USERPROFILE%\.aiand\.cli-staging-*\aiand.exe`, and the installed
  `%USERPROFILE%\.aiand\cli\aiand.exe`. Excluding only the second still
  blocks the install.
- **ASR rule "Block execution of potentially obfuscated scripts"**
  (`5beb7efe-fd9a-4556-801d-275e5ffc04cc`) and AMSI scan the script text of
  `irm … | iex` and of the key-store command. Neither is obfuscated. If either
  is flagged, the key-store command line to allow is in the AMSI section of
  [Windows key storage](windows-key-storage.md).

## Roaming and redirected profiles

- aiand keeps nothing under `%APPDATA%`: its settings and keys are in
  `%USERPROFILE%\.config\aiand` (or `AIAND_CONFIG_DIR`), the installer's copy
  in `%USERPROFILE%\.aiand\cli`. Redirecting AppData does not move them; a
  roaming profile copies them at sign-in and sign-out.
- An npm install lives in `%APPDATA%\npm`, which folder redirection puts on a
  file server (`\\server\share\…`). Node.js runs it from there; AppLocker path
  rules must then name the UNC path.
- **Windows key store.** Its keys live in `%APPDATA%\Microsoft\Protect`, so
  they follow a redirected or roaming profile, and a domain account can read
  its key on any PC in the domain. When the file server cannot be reached and
  Offline Files does not hold those keys, the key cannot be read: aiand warns
  and deletes nothing, and the next run once the server is back works. A local
  account whose password an administrator reset loses those keys; sign in
  again.
- **One config folder from two PCs at once** (`AIAND_CONFIG_DIR` on a share,
  or a home folder on a file server): aiand's lock records the PC that holds
  it by a hash of the operating system's machine id (`MachineGuid`, read
  with `reg.exe` from the Windows folder), and a lock held on another PC is
  judged only by whether it is still being refreshed, never by its process
  id. **Upgrade every PC that shares the folder together.** An older aiand
  records no PC and still judges every lock by its process id, so it can take
  a newer one's live lock. The first run after upgrading can wait up to 60
  seconds once, for a lock an older aiand left behind.
- **Owner-only permissions** are set with `icacls`, which needs the right to
  change permissions on the folder. Folder redirection grants that by default.
  Where it is missing, `aiand status` says the key file is not owner-only.
- **Long paths.** aiand's own paths are short, and Node.js handles paths over
  260 characters itself. A coding agent installed with npm into a redirected
  `%APPDATA%\npm` on a long UNC path can exceed the limit: enable
  *Computer Configuration > Administrative Templates > System > Filesystem >
  Enable Win32 long paths*, or set a shorter `npm config set prefix`.

## Coding agents

Each agent is its own program and needs its own rules. An npm-installed agent
starts through a `.cmd` launcher in `npm prefix -g` (a script rule), then
`node.exe`, plus any executable its package ships under `node_modules`. A
standalone agent such as Claude Code's native build or omp lives in
`%USERPROFILE%\.local\bin` (an executable rule). Allow them by publisher where
the vendor signs them.

## What users see

| Message | Cause | Fix |
| --- | --- | --- |
| `PowerShell runs in ConstrainedLanguage mode here …; installing with cmdlets only` | AppLocker, App Control or a lockdown policy | Nothing: informational |
| `aiand <version> is installed, but its launcher … would not run` | AppLocker script rules refuse `aiand.cmd` | Run the printed command, or see [AppLocker](#applocker) |
| `Windows application control … would not start …aiand.exe` | The prebuilt executable is refused | Install Node.js 22+ for all users, or allow the file |
| `Windows application control … would not start …node.exe` | Node.js installed for one user | Install Node.js 22+ for all users |
| `Windows would not start <agent> (<path>)` | An agent's executable is refused | Allow that agent ([Coding agents](#coding-agents)) |
| `This program is blocked by group policy …` (from Windows) | A `.cmd` launcher is refused | Allow the launcher, or run the program it starts |
| `PowerShell now runs in Constrained Language Mode here …` | A policy arrived after sign-in | `aiand login` |
| `File … cannot be loaded … not digitally signed` | Group Policy `AllSigned` | The script-block form in [PowerShell](#powershell) |

These cases are covered by aiand's automated tests, with Constrained Language
Mode run under PowerShell 7. They have not yet been run on a domain-joined PC
with each policy applied by Group Policy and Intune; report what you find in a
[GitHub issue](https://github.com/aiandlabs/aiand-cli/issues).
