# Windows key storage: cost, risks, and a test plan

How the Windows DPAPI tier works is in `CONTEXT.md` (Storage tier) and the
README (Where the key lives). This note is for whoever has to run it on a real
fleet.

## What a read costs

DPAPI is reached through Windows PowerShell 5.1 (`powershell.exe -NoProfile
-NonInteractive -Command ...`, secret on stdin only). There is no native
module. So:

- Each **cold read** (a fresh `aiand` process that needs the key) starts one
  PowerShell. Each **write** starts one. Windows PowerShell 5.1 is
  .NET Framework, not Node: on a cold machine, or one running endpoint
  security that scans process starts, that start can take a second or more
  (`DPAPI_TIMEOUT_MS` allows 20 s).
- Within one process the plaintext is cached (`dpapiPlaintext` in
  `src/secrets.ts`): a store followed by reads, or many reads, start
  PowerShell once. `test/secrets-windows.test.mjs` pins this ("what a DPAPI
  read costs").
- Codex runs `aiand key export` as an auth command **per session**, and each
  is a new process, so each pays one cold read. That is the cost to watch.
- The cache is memory only. **Do not add an on-disk plaintext cache** to hide
  this cost: it would hold the key with nothing but file permissions
  protecting it, which is what the DPAPI tier exists to avoid. A test fails
  if any file under the config folder holds the key.
- A file-tier key whose DPAPI migration failed for a transient reason
  (anything but Constrained Language Mode) is retried on the next read, in
  each process, until it works or the user sets `AIAND_KEY_STORAGE=file`.
  Only Constrained Language Mode is remembered in `credentials.json`
  (`storage_fallback: "clm"`), because only it is policy.

## Endpoint security and AMSI

The `-Command` text names `[System.Security.Cryptography.ProtectedData]` and
calls `Unprotect`, and it receives base64 on stdin. That shape resembles
credential-dumping tooling, so Microsoft Defender, a third-party EDR, or AMSI
may flag or block it. A block looks to aiand like any PowerShell failure:
`unavailable`, the key is stored in the owner-only file with a warning, and
DPAPI is tried again on the next save.

What we do not do: obfuscate the script or build the type name from pieces to
slip past a scanner. A detection is a signal the user's security team should
see, and an allow-list entry is theirs to grant.

Mitigations that exist:

- `AIAND_KEY_STORAGE=file` skips DPAPI and PowerShell entirely (with
  `AIAND_SECRET_STORE_MASTER_KEY` the file is encrypted against a copy of the
  folder). The fallback warning names it.
- The command line is stable and identifiable: always
  `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile
  -NonInteractive -Command <dpapiScript>`, never `-ExecutionPolicy Bypass`,
  never `-EncodedCommand`, no secret in argv or the environment. A security
  team can allow-list on that.

## Test plan on a real Windows machine

Everything above is stub-tested on macOS and Linux. The unit suite cannot see
Defender, AMSI, or real DPAPI timing. Before a release that changes this tier,
on Windows 11 with Defender real-time protection ON and default cloud
protection:

1. `npm ci && npm run build && node scripts/windows-secrets-smoke.mjs`: real
   DPAPI round trip, ACLs, and the Constrained Language Mode fallback. The
   `installer-windows` CI job runs this on `windows-latest`, which has
   Defender on, so a detection there fails the job.
2. `aiand login`, then `aiand status`: expect `storage  Windows DPAPI`. No
   Defender notification, and nothing under Protection history.
3. Time a cold read: `Measure-Command { aiand key export }`, three times,
   after a reboot and again warm. Record both. Compare with
   `AIAND_KEY_STORAGE=file`.
4. Run 10 `aiand key export` processes at once (`1..10 | ForEach-Object
   -Parallel { aiand key export }`): all succeed, `credentials.json` and both
   key stores are intact.
5. Defender with Controlled folder access, Attack surface reduction rules
   (block credential stealing from LSASS; block process creations from
   PSExec/WMI; block obfuscated scripts), and Tamper protection on: repeat
   steps 2 and 3. Any ASR audit event for `powershell.exe` with aiand as
   the parent goes in the report.
6. Defender Advanced Hunting or Event Viewer (Microsoft-Windows-Windows
   Defender/Operational, AMSI events): confirm no detection naming
   `ProtectedData`.
7. Block it on purpose: add a Defender custom indicator that blocks
   `powershell.exe` launched by `node.exe`, or set `__PSLockdownPolicy=4`
   machine-wide (`setx /M __PSLockdownPolicy 4`, then a new session). A
   process-level value has no effect on Server 2022's Windows PowerShell, which
   is why the smoke script skips its lockdown leg there.
   Expect a one-line warning, the key in the owner-only file, `aiand status`
   showing `file (owner-only, ...)`, and, for the lockdown case, the
   Constrained Language Mode note. Remove the block and run `aiand login`:
   the key goes back into DPAPI.
8. Shared folder: with the config folder shared with WSL
   (`AIAND_CONFIG_DIR=/mnt/c/Users/<you>/.config/aiand`), `aiand status` in
   WSL after a Windows sign-in says the key was stored with Windows DPAPI and
   to sign in again, and starts no process.
9. Repeat 2 and 3 with a third-party EDR if the fleet has one.

If step 2 or 6 shows a detection, do not ship; talk to the security team
about an allow-list entry for the command line above before changing code.
