### Added

- `install.ps1` runs in PowerShell Constrained Language Mode, which AppLocker and App Control for Business impose on a script they have not approved, and on the `irm … | iex` one-liner: every .NET call has a cmdlet path, the user PATH keeps its `%VARIABLE%` entries and value type, and the installer says which mode it is in.
- Where Group Policy sets an execution policy that refuses `install.ps1` as a file, the IT administrator guide shows how to pass arguments (`uninstall`, `uninstall --purge`) to the downloaded script as a script block, which also works in Constrained Language Mode.
- An IT administrator guide for managed Windows PCs, in English and Japanese (`docs/it-admin-windows.md`): what aiand runs and from where, what to allow in AppLocker and App Control for Business, PowerShell Constrained Language Mode and execution policy, Microsoft Defender and SmartScreen, and roaming or redirected profiles.

### Fixed

- When application control refuses the installer's `aiand.cmd` launcher, the installer keeps the verified install and prints the command that runs aiand without it, instead of failing after the install was already in place.
- A prebuilt `aiand.exe` or a per-user Node.js that application control will not start now stops the installer with a message naming the policy and what to do, and an agent executable Windows will not start makes `aiand` say so plainly instead of `spawn UNKNOWN`.
- A key already in the Windows key store that Constrained Language Mode now blocks is reported as that policy, not as a key that could not be decrypted, and a read that failed while the profile's file server was out of reach says to try again once it is back.
- A config folder used from two PCs at once (on a network share) is no longer unlocked from under a live holder on the other PC: the lock records the PC that holds it by a hash of the operating system's machine id (Windows MachineGuid, read with System32's reg.exe; macOS IOPlatformUUID; Linux /etc/machine-id), and any lock that does not name this PC, including one written by an older aiand, is judged by its heartbeat alone. Upgrade every PC that shares a config folder together: an older aiand still judges every lock by its process id. The first run after upgrading can wait up to 60 seconds once, for a lock an older aiand left behind.
