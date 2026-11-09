# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

### Added

- Windows now keeps your key in an OS-backed store: Windows DPAPI, through
  the Windows PowerShell that ships with Windows. The key is encrypted for
  your Windows account, so another account on the machine, or a copy of the
  file taken elsewhere, cannot decrypt it. `aiand status` shows
  `storage  Windows DPAPI`. A key you signed in with before moves into DPAPI
  the next time the CLI reads it, and the encrypted-file copy is removed.
  Where PowerShell cannot reach DPAPI (Constrained Language Mode on a
  locked-down machine, or PowerShell missing), the key stays in the
  encrypted file as before, and `aiand status` says why in one line.
  `AIAND_KEY_STORAGE=dpapi` pins it; `AIAND_KEY_STORAGE=file` keeps the old
  behaviour.
- `aiand logout --all` hands a shared or loaner machine back. It revokes every
  key `login` created (best-effort, one profile at a time), removes ai& from
  every coding agent whichever profile wired it and checks no key is left in
  their configs, deletes session files a crashed `aiand run-agent` left in the
  temp directory, deletes every stored key (OS keychain included) and
  `~/.config/aiand` with its snapshots. It asks first, or takes `--force` off
  a terminal; `--keep-remote` skips revoking; `--json` reports each step.
  A profile whose key it could not revoke keeps its sign-in (its refresh
  token is the only thing that can revoke the key), and so does the config
  directory; run it again later, or add `--keep-remote` to forget the key
  here and revoke it in the console. Pasted keys, which the CLI cannot
  revoke, are listed with the console page that can. It exits 1 after listing anything it could not remove, and only
  deletes a config directory inside your home directory unless
  `AIAND_WIPE_OUTSIDE_HOME=1`. It also refuses a directory that does not
  prove it is aiand's: aiand writes a `.aiand-config` marker file into its
  config directory on its first write there, only while the directory is new,
  empty or holds nothing but aiand's own files, and the marker carries a
  random id that `config.json` records too (an older install passes while its
  `config.json` has aiand's `profile` and `profiles`). An empty marker, or one
  copied from another install, vouches for nothing, so an `AIAND_CONFIG_DIR`
  pointed at `~/.docker` or a project folder is left whole, even after a cache
  write into it, and a `locks` or `snapshots` folder
  keeps whatever aiand did not put in it. The directory is checked again
  right before anything is deleted from it, so one swapped for a link while a
  slow revoke ran is refused. Session folders it could not delete, a temp
  directory it could not read, and `aiand-*` folders from an older aiand that
  still hold a key (no marker, so it deletes nothing on a guess) are reported
  and make the run incomplete, as is a revoke the server answered with an HTTP
  status, which `--json` gives as `http_status`. An agent it could not clean up (its
  `off` failed, or its config still holds a key) keeps its snapshot and the
  record `on` left, so running `aiand <agent> off` once the file is fixed
  still strips exactly what was added. See "Handing back a shared or loaner
  machine" in the README.
- `aiand run-agent` marks each throwaway session dir it creates, and deletes
  day-old ones whose session is gone before starting a new one; `logout` and
  `logout --all` delete them regardless of age. A session killed before its
  cleanup no longer leaves its key in the temp directory indefinitely.
- `install.sh uninstall --purge` and `install.ps1 uninstall --purge` wipe a
  shared or loaner machine. Before deleting anything, they run
  `aiand logout --all --force --json`, or `aiand logout --profile <name>
  --json` for each profile on a CLI without `--all`. That revokes the keys
  this CLI minted and strips every agent. They then delete the config
  directory along with the CLI. They go on only when every key the CLI minted
  reports revoked (a pasted key is not theirs to revoke); an older CLI exits 0
  after a failed revoke, so the installer reads the JSON, not the exit code.
  Otherwise nothing is deleted by the installer, and `--force --purge` skips
  sign-out and says the keys were not revoked. The config directory must sit strictly
  inside HOME, be named `aiand`, and on Windows have no link or junction
  between it and HOME.

### Changed

- `aiand status` now calls the fallback tier `file (owner-only, not encrypted at
  rest)` instead of `encrypted file`: its decryption key sits beside the
  ciphertext, so it is worth no more than an owner-only file. `aiand status
  --json` keeps the label in `storage` and adds `storage_tier` with the stable
  tier id (`keychain`, `dpapi`, `file` or `plaintext`). The README documents
  `AIAND_SECRET_STORE_MASTER_KEY`, which supplies that key from elsewhere.
  The label follows the facts: with `AIAND_SECRET_STORE_MASTER_KEY` set it
  reads `file (encrypted; key held outside the config folder)`, and on
  Windows, where `icacls` could not restrict the files to you, it says
  `not owner-only`. `storage_tier` does not change.
- `aiand hermes on` sets your own `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_TOKEN` entries aside by commenting them out where they sit
  in `~/.hermes/.env` (`# aiand set aside: …`), instead of copying them in
  plaintext into `~/.config/aiand/snapshots/hermes`. `off` uncomments them.
  A multi-line quoted value now comes back whole; before, only its first line
  was handed back. Entries an earlier version recorded are still handed back
  by `off`, which then deletes the record. A `#` comment containing an
  apostrophe no longer hides the next `.env` entry from that check, and a
  launcher session's throwaway home never carries a set-aside entry.
- `install.sh` and `install.ps1` install the latest release instead of
  building the main branch. They download the `@aiand/cli` tarball from npm
  and install it only when it matches both npm's sha512 and the
  `SHA256SUMS` attached to the GitHub release. With no release reachable,
  or with GitHub rate-limiting the download, they stop and change nothing,
  with no fallback to `main`. `AIAND_VERSION=x.y.z` installs that release,
  including one older than the installed version: without it, they refuse a
  latest release that is older than what is installed, and they refuse
  anything older than 0.8.0, the first release published with a
  `SHA256SUMS`, even when pinned. `AIAND_SOURCE` still builds a checkout or
  clone, labelled as an unverified development build. A release install
  needs only Node.js, not git or npm. Releases before this one have no
  `SHA256SUMS`, so the installers cannot install them. These checks cover
  the tarball, not the installer script: a fresh install runs the script as
  fetched from GitHub alone, before anything is verified, so that first
  step is trusted on first use. Later `update` runs run the copy of the
  script that shipped in an earlier verified release.
- The README one-liners fetch `install.sh` and `install.ps1` from the latest
  GitHub release's assets
  (`https://github.com/aiandlabs/aiand-cli/releases/latest/download/`)
  instead of the main branch, so a push to main no longer changes what a new
  install runs. Until a release carries them they answer 404: run
  `npm install -g @aiand/cli` meanwhile.
- Running `aiand claude` on its own (no `on`, `off` or `status`) starts one
  Claude Code session on ai& and leaves Claude Code's settings alone, the
  same launch as `aiand run-agent claude`. It used to run
  `aiand claude on` first, which moved every Claude Code session already
  open, including other terminals and editor sessions, onto ai&, where
  Anthropic's models fail. `aiand claude on` and `off` still route every
  `claude` through ai& and back. Other agents keep opening through `on`.
- `aiand claude on` warns that Claude Code sessions already running switch
  to ai& at once. `aiand claude off` now moves them back as well: Claude
  Code applies settings changes to running sessions but keeps a value that
  disappears, so `off` first writes what it removes as empty (which Claude
  Code reads as unset), waits three seconds for running sessions to reload,
  then deletes it. `off` therefore takes about three seconds.
- `/model` rows in Claude Code show the context Claude Code actually gets
  under the 200K cap (`ai& · 200K context`) instead of the model's full
  window, and label only text-only models (`· text only`) instead of
  printing `vision` on most rows.

### Fixed

- `aiand logout` when the server does not revoke the key now says what it
  answered (`https://… answered HTTP 404 to the sign-out request`) instead of
  always telling you to check your connection. The sign-in is still kept.
- `aiand run --no-stream "…" > out.txt` ends the answer with the platform's
  line ending again (`\r\n` on Windows), as it did before the output was
  cleaned.
- Two `aiand` processes waiting on the same dead lock could still both take it:
  one that had judged the lock stale could delete the fresh lock a faster one had
  just created. Takeovers now go one at a time, and each re-checks the lock first.
  A lock that disappears mid-check is retried instead of judged by a missing
  timestamp.
- `aiand claude` could skip the "Your default Claude Code model is ... again" note
  when Claude Code saved a default of its own just before the session ended.
- `aiand models` now uses your stored login when `AIAND_API_KEY` is set to only whitespace, matching every other command.
- Pasting a key that has a stray space or control character inside it at the masked prompt now counts as one of the three attempts instead of ending the login on the spot; leading and trailing whitespace is trimmed.
- `aiand status` no longer fails with exit 2 and no output when the stored sign-in belongs to another endpoint (`--base-url B` while signed in on A): it reports not signed in with the reason (`reason` in `--json`) and the agent table. `whoami` still refuses.
- `aiand login --base-url X` now saves X on the profile, so later commands no longer exit 2 asking you to drop an override you never set. The refusal hint names `aiand config set api-url` / `auth-url`, and only says to drop an override when one is set.
- On Windows, the GitHub Copilot app wiring no longer picks a `sqlite3.cmd` or
  `sqlite3.bat` from PATH, which cannot be launched; it looks for `sqlite3.exe`.
- Coding agents now start with a PATH of absolute entries only, on every platform.
  A `.`, empty or relative entry let `#!/usr/bin/env node` (or an npm shim's
  `node`) run a program planted in a cloned repository.
- On Windows, an `aiand_api_key` or other differently-cased spelling of the
  secret variables is now removed from the environment of agents and npm installs,
  as the exact-case name already was.
- `AIAND_SECRET_STORE_MASTER_KEY` no longer reaches the coding agents you launch
  with `aiand <agent>`, the processes they start, or the `npm install -g` that
  fetches one. Only Codex still gets it, because its `aiand key export` command
  needs it to read the encrypted file store.
- A token refresh that finds its profile signed out by another process now stops
  with "not signed in" instead of rotating the old refresh token, which signed
  the profile back in.
- On Windows, saving a key no longer holds the store lock while it starts `whoami`
  and `icacls`, so a second `aiand` waiting on a cold machine no longer takes the
  lock over mid-write.
- A second `aiand key export` (Codex starts one per session) no longer steals the
  token-refresh lock from a refresh that is merely slow, which could rotate one
  refresh token twice and get the whole sign-in revoked as stolen. A lock is
  now taken over only when its holder has exited; a live holder keeps it alive
  while it works, and the rotation request itself times out after 30 seconds.
  A lock also names its holder by process ID and a random value, and a live
  holder is called hung only after the waiting process has watched the lock
  stay untouched for a minute on its own clock. A process ID that Windows gave
  to something else after a killed `aiand key export` no longer holds everyone
  up for five minutes, and a clock change or a laptop going to sleep no longer
  makes a waiter take a lock whose holder is alive.
- On Windows, `aiand.cmd` finds Node through PATH again when its baked-in
  Node is gone and Node lives under the current directory (a profile-local
  fnm or scoop Node from `%USERPROFILE%`, anything from `C:\`). A hit is
  refused only when it came through an empty, `.`, relative or
  drive-relative PATH entry.
- On Windows, `install.ps1 uninstall` now refuses, before turning anything off,
  a checkout that is a link or junction or holds one, as it already did for
  the config directory, instead of letting PowerShell follow it into the target.
- `uninstall --purge` now stops, deleting nothing, when `logout --all` could
  not read the credentials it was meant to revoke (`complete: false` with
  `problems`, or no profiles while `credentials.json` names some), in
  `install.sh` and `install.ps1`.
- `uninstall --purge` no longer deletes what `logout --all` kept. When
  `logout --all` exits non-zero it lists the keys still on disk and what it
  kept in the config directory, leaves that directory unless it is empty, and
  exits 1.
- On Windows, `install.ps1 uninstall --purge` no longer stops with a PowerShell
  error and exit 1 after it has signed you out: `aiand logout --all` already
  deletes the config directory, which the purge then tried to delete again.
- On Windows, launching an agent through an npm `.cmd` shim now runs it with a
  `PATH` of absolute entries only. `NoDefaultCurrentDirectoryInExePath` stops
  cmd.exe searching the current directory by itself, but not a `.` or relative
  entry you put in `PATH`, so the shim's bare `node` could run a `node.exe`
  planted in a repo you were standing in.
- On Windows, the throwaway folder that holds a key for a launched agent is now
  refused, and removed, when it could not be made owner-only, instead of the
  key being written under the folder's inherited permissions.
- A file where ai& needs a directory (a config path blocked by a file) is a
  clear error with a hint on Windows too, instead of `Unexpected error: EEXIST`.
- A stored sign-in is now bound to the endpoints that issued it, recorded as
  `bound_to` in `credentials.json`. When `--base-url`, `AIAND_BASE_URL`,
  `AIAND_AUTH_URL` or `aiand config set` point elsewhere, the CLI refuses to
  send the stored key (exit 2, with a hint to sign in on a separate profile)
  instead of sending it to that host, and never sends the refresh token
  anywhere but its issuer, so a pasted "faster endpoint" command can no longer
  take over the account. `logout` revokes at the issuer too. Sign-ins saved by
  earlier versions are bound on first use to the profile's stored endpoints
  (the production default unless `config set` changed them), never to a
  one-off override; if you signed in under `AIAND_BASE_URL` before, sign in
  again. `AIAND_API_KEY` is unaffected.
- Codex no longer pulls the stored key to an endpoint it was not issued for.
  `aiand codex on` now writes `aiand key export --for <origin>` into the
  profile (the origin Codex sends to), and `key export --for` refuses, with
  exit 2, unless the stored sign-in was issued for that origin. Before, the
  check used the profile as resolved in Codex's environment, so a profile
  wired by `AIAND_API_KEY=k AIAND_BASE_URL=B aiand codex on` later handed the
  stored key to B. `codex on` also warns when the environment key's endpoint
  differs from the stored sign-in's. A Codex profile written before this
  (no `--for`) is checked against its own `base_url` when it belongs to the
  profile being exported, so `aiand key export` run by hand can now be
  refused for the same reason; run `aiand codex on` again to rewrite it.
  `--for` takes an origin only: a URL with a username or password is refused
  without being printed, and an endpoint quoted in a refusal, a hint or a
  rewire note never carries a username, password, query or fragment.
- `aiand config set api-url` / `auth-url` can no longer redirect an old
  sign-in that has not been used since the upgrade. A credential saved before
  0.8 is pinned to the profile's stored endpoints when it is first used, so
  setting both URLs to a new host first, then running `whoami` or `logout`,
  sent the key and refresh token there and bound the credential to it. The
  pin is now written before the new URL is. `config set api-url` also names
  any agent wired for the old API endpoint, which keeps sending there.
- A stored sign-in with no recorded endpoint is now refused instead of sent
  anywhere. The request gate used to let it through, a token refresh fell
  back to the profile as resolved with this run's overrides, and saving a
  credential without a binding recorded those overrides. The first now fails
  closed, and the others take the profile's stored endpoints, as the first
  use of an older sign-in already did. `status --local` and `whoami --local`
  still read the cached identity without a binding.
- `aiand models --base-url <url>` while signed in for a different endpoint
  now lists that endpoint's public catalog, priced in USD, with a note that
  the stored key was not sent, instead of failing with the endpoint-binding
  refusal. The same applies after `aiand config set api-url`.
- If you keep `AIAND_BASE_URL` (or `AIAND_AUTH_URL`) exported to reach staging
  while signed in on the `default` profile, that sign-in is now refused
  there: it was issued for production, and the override no longer moves it.
  Sign in once on a profile of its own, for example `aiand login --profile
  staging --base-url https://staging.example.com`, then select it with
  `--profile staging`, `AIAND_PROFILE=staging`, or `aiand config use staging`
  and drop the exported URLs. Keeping the `default` profile for production
  leaves it working unchanged.
- Requests that carry a key, refresh token, device code or PKCE verifier no
  longer follow redirects. A 307/308 resent the body to the `Location`, even
  cross-origin; the CLI now stops with an error naming the redirect.
- A key containing a line break, space or other unprintable character (for
  example `AIAND_API_KEY="$(grep sk- .env)"` matching two lines) is refused
  with "API key contains invalid characters (check for a line break or
  space)" when it is read from `AIAND_API_KEY`, pasted, or saved, instead of
  being printed in full in a "Could not reach" error. Error messages and
  crash stacks now redact `Bearer …` values and `sk-…` keys, and a request
  the CLI could not build is no longer reported as a network failure.
- Switching profiles (`aiand config use`) or signing in to another one no
  longer bakes that profile's key into an agent wired for a different API
  endpoint, which sent it to that endpoint. `aiand <agent> on` now records
  the endpoint it wired (`wired.json` in the config directory); an agent
  wired for another one keeps its key and is named in a note with the
  `aiand --profile <name> <agent> on` command that moves it. Agents wired by
  earlier versions are judged by the endpoint of the profile that was active
  before the switch.
- Reads from the gateway are bounded: a server-sent event line over 1 MiB
  ends the stream with an error, error bodies are read up to 64 KiB and
  shown as at most 500 characters (a non-JSON body as its status text plus
  first line), and `aiand logs` stops paging when a page adds no rows or the
  cursor repeats, instead of looping forever.
- On Windows, aiand no longer finds an agent, npm, or itself in the current
  directory. It used `where`, which searches the current directory before
  PATH, so a `claude.cmd`, `npm.cmd` or `aiand.cmd` in a cloned repo would run
  in place of the real one, and `aiand codex on` could bake that `aiand.cmd`
  into Codex's auth command. aiand now walks PATH itself, skipping empty,
  relative and `.` entries, and spawns what it finds by absolute path. A
  directory you put on PATH by its absolute path still counts, even while you
  are in it. Run `aiand codex on` again if you set Codex up from inside a repo
  you did not write.
- On macOS and Linux, an agent or npm that resolves only through an empty,
  `.` or relative PATH entry in the current directory is treated as not
  installed, and aiand spawns the agent by the absolute path it detected
  rather than by name. A directory you put on PATH by its absolute path still
  counts, even while you are in it.
- On Windows, aiand starts `cmd.exe`, `rundll32.exe` and `tasklist.exe` from
  `%SystemRoot%\System32` and `sqlite3` from PATH by absolute path, so a
  same-named file in the current directory never runs in their place. Batch
  shims now always go through System32's `cmd.exe`, not `%ComSpec%`.
- On Windows, batch shims run under `cmd.exe /v:off`, so delayed expansion
  turned on in the registry cannot expand `!name!` in an argument.
- The installed launchers no longer fall back to a `node` in the current
  directory when the Node.js found at install time is gone. `aiand.cmd`
  searched with `where node`, which tries the current directory first; it now
  searches PATH only and refuses a `node.exe` that came through a relative
  PATH entry (an empty or `.` entry, `bin`, a drive-relative one), so a cloned
  repo cannot supply it; a drive-rooted or UNC PATH entry is trusted even when
  it lies under the current directory. It also runs under `setlocal
  DisableDelayedExpansion`, so it no longer leaks variables into your shell
  or expands `!name!` in an argument. The bash launchers (`install.sh`, and
  `install.ps1`'s Git Bash shim) refuse the relative path an empty or `.`
  PATH entry yields. Re-run the installer to get the new launchers.
- On Windows, the files and folders that hold your key are now readable by
  you alone. Windows ignores the owner-only modes the CLI sets elsewhere, so
  the config folder, the key stores, `credentials.json`, agent configs
  carrying the key, snapshots, and the throwaway folders `run-agent` writes
  the key into now get an owner-only ACL (`icacls`, your account's SID with
  full control, inherited entries removed). Before, a session folder under a
  shared `TEMP` could be readable by every user on the machine. If `icacls`
  fails the write still goes ahead; `AIAND_DEBUG=1` prints why.
- `aiand login --paste` no longer shows your key on Windows. The prompt now
  masks it with `*` as it does on macOS and Linux, in Windows Terminal and
  the classic console alike: a Ctrl+V or right-click paste is masked, and
  Backspace and Ctrl+C (exit 130) work as usual. Input is visible only on a
  terminal that offers no raw mode, and the prompt says so first.
- `aiand run` and `aiand chat` no longer pass escape and control sequences
  from a model's answer or reasoning to your terminal. A reply (for example,
  one steered by a prompt-injected page you asked it to summarise) could
  previously write your clipboard (OSC 52), plant a link whose target differs
  from its text (OSC 8), retitle the window, or move the cursor and erase
  lines to fake a prompt. Escape sequences, C0/C1 controls, DEL, and bidi
  override and isolate characters are now removed, including a sequence split
  across streamed chunks; a bare carriage return prints as a new line, so it
  can no longer overwrite what came before it. Japanese, emoji, combining
  marks, tabs, and CRLF are untouched. Only terminal output is filtered:
  piped or redirected output (`aiand run … > out.md`) is still the model's
  raw text, byte for byte.
- Text from the server is now cleaned before it is printed, piped or not:
  organization names, emails, model ids and descriptions, log rows, usage
  labels, response headers in the `run` footer and `chat`, and API error
  messages (cleaned when they are received). Escape and control sequences
  and bidi overrides are removed, and a line break inside a table cell or
  field becomes a space, so it can no longer add a fake row. Cell text is
  cleaned in full and only then coloured, so no escape sequence, a server's
  colour codes included, reaches a pipe, a file, or a `NO_COLOR` terminal
  from a cell. Notes, warnings, hints and error text that quote the gateway
  are cleaned wherever they are printed: `aiand init`, `aiand <agent> on` and
  `off`, the chat banner, the key-refresh notes after sign-in and `aiand
  config use`, and `aiand logs --follow`. A model whose id has control or
  bidi characters is dropped from the catalog, a token count or latency that
  is not a number prints as `-`, and an update notice shows only a
  version-shaped string. `--json` output is unchanged. The installers clean
  the text they print about a release (a tarball entry name, an npm manifest
  field) the same way.
- Sweeping a crashed Hermes session's overlay (the next `aiand run-agent`
  after a day, or `logout`) puts the store shims back first. A session that
  died before its cleanup left your own `hermes` binary pointing into the
  overlay, and deleting the overlay broke it. The overlay now carries a copy
  of the shim snapshot, and is kept while any shim still points inside.
- Hermes's `.env` handling treats a quote as opening a multi-line value only
  straight after the `=`, as python-dotenv does. A stray quote inside an
  unquoted value (`GREETING=it's fine`, `URL=http://x?a="b`) used to hide every
  following line, so `aiand hermes on` left your own `ANTHROPIC_API_KEY` active
  and `off` left `AIAND_HERMES_API_KEY` in the file.
- `aiand logout` no longer deletes the refresh token when it cannot reach ai&
  to revoke the key. You stay signed in, with a message to retry or to run
  `logout --keep-remote`; before, the key stayed valid with nothing left on
  the machine that could revoke it. Pasted-key and no-refresh-token logouts
  now name the console page that revokes the key.
- A snapshot never copies a config file that already carries ai&'s marker or
  a known ai& key. Before, re-running `on` after moving an agent's config dir
  (`PI_CODING_AGENT_DIR`, `COPILOT_HOME`, Oh My Pi's agent dir) copied the
  wired file, key included, into `~/.config/aiand/snapshots` and replaced the
  real pre-aiand snapshot. Now `on` adds a moved dir's files beside the first
  capture instead of replacing it, and Pi, Oh My Pi and the Copilot CLI refuse
  to wire a second dir while the first still holds the key (run `off` first),
  as Claude Code and Codex already did. `aiand restore` says which files it
  had no copy of, and keeps the copies of files the agent no longer reads.
  `aiand logout` deletes snapshot copies an older version left holding the
  logged-out key, and copies carrying ai&'s marker even when the key in them
  is another one. `aiand restore` keeps what `on` recorded while a path it left
  alone (the agent no longer reads it) may still be wired, so `off` run from a
  shell that names that path can still tell your values from ours.
- `aiand omp off` and `aiand copilot off` no longer leave the ai& key behind
  when you edited the `aiand` provider's `baseUrl`. They keep your edit,
  remove the key (and Oh My Pi's `managedBy` stamp) from the block, and say
  so. They remove only a key ai& put there (a stored, session or `AIAND_API_KEY`
  key, or the one `on` wrote); a key you set in the repointed block stays. Before, the key stayed and `off` forgot it had written it, so logout
  could not remove it either.
- `on` and the key refresh after `login` refuse to write the ai& key into an
  agent config that sits inside a git repository, which is where a GNU Stow or
  chezmoi symlink into a dotfiles repo used to put it, one `git add -A` from
  being pushed. The error names the repository and how to proceed; gitignore
  the file and set `AIAND_ALLOW_GIT_TRACKED=1` to write it anyway. A bare
  dotfiles repository directly in your home directory (`git
  --git-dir=~/.dotfiles --work-tree=~`) counts too: it is recognised from its
  `core.worktree`, or from the `index` such a repository grows, without
  running git, and so do the repositories yadm (`~/.local/share/yadm/repo.git`)
  and vcsh (`~/.config/vcsh/repo.d/*.git`) keep. The opt-in is remembered for each file in the agent's recorded
  state, so the key rotation a later `login` runs, without the variable, still
  swaps the key it wrote instead of leaving the agent on a dead one; `off`
  forgets it. Config files that do not hold the key still follow links as
  before.
- `aiand omp on` quotes and escapes every model id or value it writes to
  Oh My Pi's YAML unless it is a plain id, URL or key, so a carriage return,
  NEL, U+2028/2029, tab, control character or a word like `yes` or `0x1F` in
  a catalog string can no longer add keys or change a value's type.
- `aiand opencode on` copies only the descriptive fields of each model from
  the gateway's `/v1/api.json` (name, family, dates, limits, cost,
  modalities, capability flags, status, reasoning options) and drops
  `npm`, `provider`, `options`, `headers`, `variants` and any string carrying
  an OpenCode `{env:…}` or `{file:…}` substitution.
  `aiand opencode` (the session launcher) holds the models it builds from the
  catalog to the same allowlist, and leaves out a model whose id carries one.
- `aiand opencode off` on an `opencode.json` that does not parse no longer
  reports "nothing to turn off" with the key still inside. It says the file
  may still hold your ai& key, asks you to fix the JSON and run `off` again,
  and keeps what `on` recorded so that retry strips exactly what it added,
  as `aiand claude off` already did.
- `install.ps1 uninstall --purge` refuses a config directory with a directory
  link or junction inside it, deleting nothing. Windows PowerShell 5.1 follows
  a junction when it deletes recursively, which would have removed files
  outside the config directory.
- A release install no longer replaces a git clone it did not create. A
  developer's checkout at `AIAND_DIR` has no ownership marker and is not the
  default install directory, so the installer stops and leaves it alone, as
  `uninstall` already did.
- `uninstall --purge` no longer refuses everything when HOME is reached
  through a symlink and `~/.config/aiand` was never created. A config
  directory that does not exist is skipped, not guarded, and the purge says so.
- The installers' "no published release was found" and "release v… was not
  found" errors now tell users to `npm install -g @aiand/cli` meanwhile, which
  matters from merge until the first release with a `SHA256SUMS`.
- A failed `publish.yml` run can be re-run. A version already on npm with no
  complete GitHub release resumes instead of stopping at the "already on
  npm" check: it publishes nothing, requires npm to serve the tarball it just
  packed, and creates the release (as a draft, published once every asset is
  attached). The wait for npm to serve a new version is up to about ten
  minutes, with backoff, up from 150 seconds.
- `install.sh update` and `install.ps1 update` say why when npm's latest
  version, which the update notice reads, is ahead of the latest GitHub
  release, which they install: "already up to date; npm shows X, but its
  GitHub release is not out yet". Before, the notice and the updater looked
  like a loop.
- The Hermes Agent install hint on macOS and Linux no longer pipes the
  site's installer into bash. It downloads the installer at the pinned
  commit to a temp file and runs it only after its sha256 matches. The Oh My
  Pi hint downloads the binary to a temp file, checks it, and only then
  moves it into `~/.local/bin`, so an unverified binary is never on PATH.
  On Windows it is now plain PowerShell that works when pasted at a
  PowerShell prompt: the old `powershell -Command "…"` line broke on its
  nested quotes.
- Opening Claude Code or Codex when it is missing installs a pinned release,
  not whatever npm calls latest: `@anthropic-ai/claude-code@2.1.312` and
  `@openai/codex@0.165.0`. Codex and the Copilot CLI install with
  `--ignore-scripts`, since neither package has an install script. Claude
  Code still runs its postinstall, which puts its native binary in place.
  The question names the exact command it will run. `check:dist` now fails
  any npm install hint that has no exact version, or that runs install
  scripts without a stated reason.
- The update notice for installer installs printed a command that rebuilt
  the version already installed. It now prints `bash ~/.aiand/cli/install.sh
  update`, or on Windows `powershell -NoProfile -ExecutionPolicy Bypass -File
  "…\install.ps1" update`, which runs under the default execution policy.
  `update` always fetches and verifies the latest release, and it updates
  the install directory it runs from. npm installs are told to run
  `npm install -g @aiand/cli@latest`. Installs made before this release
  update by running the one-line install command again.
- The installers refuse an `AIAND_SOURCE` that starts with `-` and end
  `git clone`'s options with `--`, so a source can never be read as a git
  option such as `--upload-pack`.
- On Windows, a program run through an npm `.cmd` shim can no longer be
  planted in the current directory. npm's shim runs `node.exe` beside itself
  if there is one and otherwise a bare `node`, which `cmd.exe` looks for in the
  current directory first (the default Node installer keeps the shims in
  `%APPDATA%\npm` and `node.exe` in Program Files), so `cd cloned-repo &&
  aiand codex` ran a `node.exe` or `node.cmd` from the repo. aiand now sets
  `NoDefaultCurrentDirectoryInExePath=1` for itself and every process it
  starts, and `aiand codex on` bakes Node's absolute path and this install's
  `dist\index.js` as Codex's auth command instead of `aiand.cmd`. Run
  `aiand codex on` again to replace a baked `aiand.cmd`.
- On Windows, aiand finds programs that are Store App Execution Aliases (such
  as a `python.exe` or `winget.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps`)
  again. Those are zero-byte reparse points that `stat` can refuse to open,
  and the PATH walk had stopped seeing them.
- On macOS and Linux, the system tools aiand starts (`which`, `open`,
  `xdg-open`, `pgrep`, `security`, `secret-tool`, `sqlite3`) are found through
  the absolute entries of PATH only. They used to run through the whole PATH,
  so an empty, `.` or relative entry could pick a same-named file in the
  current directory. They also no longer inherit `AIAND_API_KEY` or
  `AIAND_SECRET_STORE_MASTER_KEY`, which the keychain tools never needed.
- On Windows, `aiand logout` and the rest of the credential store no longer
  start `secret-tool`. It was a bare name, so `cmd.exe` tried the current
  directory first, and the child inherited `AIAND_API_KEY`. Nothing is
  spawned there now.
- Two `aiand` processes on Windows can no longer lose a key to each other.
  Moving a sign-in into DPAPI on first read, or saving a new one, rewrites
  whole key stores, and processes running at once (Codex starts one per
  session) could overwrite each other's update: a key whose old copy was
  already removed was gone, and `credentials.json` could lose a concurrent
  sign-in. The key stores and `credentials.json` are now updated under a
  cross-process lock, the old copy is removed only after DPAPI is seen to
  hold the key, and a stale read never overwrites a newer sign-in.
- Signing in on Windows no longer fails when an old encrypted-file store
  cannot be read (for example after `AIAND_SECRET_STORE_MASTER_KEY` changed)
  even though DPAPI already holds the new key. The leftover file copy is
  simply left alone.
- A config folder shared between Windows and WSL or Linux no longer shows the
  Linux side as signed out, nor tries to start a Windows PowerShell from it,
  once Windows has moved the key into DPAPI. The Linux side now says the key
  was stored with Windows DPAPI and to sign in again there.
- A single failed PowerShell start on Windows no longer keeps your key out of
  DPAPI until you sign in again. Constrained Language Mode, which is policy,
  is remembered for good. After a timeout or a PowerShell that would not
  start, the next save tries DPAPI again (once per run), and a read waits ten
  minutes before it tries again: a PowerShell that hangs used to cost every
  `aiand` process, and so every Codex session, 20 seconds on its first read of
  the key. `aiand status` says why the key is in the file in both cases.
- The fallback warning on Windows now says how to stop aiand trying DPAPI
  (`AIAND_KEY_STORAGE=file`) for machines where endpoint security blocks the
  PowerShell call. `docs/windows-key-storage.md` records what a DPAPI read
  costs and a test plan for real Windows machines, Microsoft Defender
  included.
- A stray control character no longer swallows the text after it. A mis-decoded
  quote (`â€\u009d`) carries an 8-bit string introducer that was read as the
  start of a hidden sequence, so `aiand run`, `aiand chat` and every table or
  field cut off at that point. Those introducers are now dropped on their own,
  and an escape-introduced string that is never closed ends at the next line
  break, or after 4096 characters, instead of running to the end of the
  output.
- An emoji or other character outside the basic plane that a model streams
  split across two chunks now prints whole, on a terminal and in a pipe,
  instead of as two replacement characters.
- Ctrl+C inside an agent started by aiand reaches only the agent. aiand used
  to exit and delete the session's settings on the first press, handing the
  prompt back while the agent kept running (Claude Code uses that press to
  clear its input). SIGTERM and SIGHUP are passed on to the agent, and the
  session's files are removed after it exits. A launched agent killed by a
  signal now exits with `128 + n` instead of `1`.
- Saving an ai& model as the default in `/model` inside an `aiand claude`
  (or `aiand run-agent claude`) session no longer leaves plain `claude`
  starting on a model Anthropic does not serve: aiand puts your own default
  back as soon as Claude Code saves the pick, so a `claude` started in
  another terminal meanwhile is not affected either. An ai& default left by
  an earlier session is removed when the next one ends. While
  `aiand claude on` is in effect, an ai& default is yours to keep. A
  `settings.json` symlinked into a dotfiles checkout is covered too.
- `aiand logout --all` no longer deletes a sign-in it could not read. A profile whose
  credential would not load (a locked keychain over SSH) or a corrupt
  `credentials.json` is now reported as `revoked: false, kept: true`, its sign-in
  files stay for a retry, and the run is `complete: false` with a `problems` entry.
- `aiand logout --all` no longer strips the Copilot app while the app is running: like
  `aiand copilot-app off`, it now asks you to quit it first (the app rewrites its
  database on exit and would put the key back), and keeps that agent's state for a retry.
- `aiand restore <agent> --force` no longer drops what `on` recorded while a file it could
  not restore still holds ai& wiring (a Copilot CLI wired at a non-default URL, say), so a
  later `aiand <agent> off` can still find the key it has to remove.
- `aiand opencode on` no longer writes a model id into OpenCode's root `model` unless OpenCode's
  cleaned model map carries it, so an id holding `{env:}` or `{file:}` cannot be read back
  through OpenCode's substitution.
- Sweeping the overlay of a crashed Hermes session no longer reverts a store shim you
  updated since: it puts back only a shim that still points into the overlay.
- Running `aiand claude off` again after one was interrupted during its reload wait now
  removes the keys the first run had emptied, instead of leaving `""` values behind and
  claiming you edited them.
- Signing in, or switching profile, no longer bakes a key into an agent wired for another
  endpoint when `on` left no record of where (pre-0.8 `AIAND_BASE_URL=staging aiand opencode on`,
  then `aiand login --force` against production). Each agent's own config is read for the
  base URL it bakes and compared with the credential's; one that cannot be judged is left alone
  with a note naming `aiand --profile <name> <agent> on`, and a corrupt `wired.json` no longer
  reads as safe.
- `aiand login` over SSH signs in with a device code right away instead of
  waiting five minutes for a browser redirect that can't reach the remote
  machine, and no longer opens a browser on the remote machine.

### Removed

- The organization picker at sign-in. A key belongs to exactly one org, so
  browser and device sign-in, `aiand login --paste` and `--with-token` no
  longer ask a multi-org account to choose one: the CLI records the org the
  gateway names in the token response (or, if it names none, the first org it
  lists; for a pasted key, the first org the gateway lists) instead of one the
  key does not bill, which `status` and `whoami` then misreported.
- The keychain tier on Windows. Windows keeps its key in DPAPI or the
  encrypted file, so `AIAND_KEY_STORAGE=keychain` now fails there with a
  clear error instead of being tried.


## [0.7.1] - 2026-11-02

### Changed

- `aiand claude on` picks `deepseek-ai/deepseek-v4.1-flash-1017` as Claude
  Code's fast model, replacing `deepseek-ai/deepseek-v4.1-flash`, which ai&
  retires on 2026-11-06 0:00 JST. A setup written earlier keeps the old
  model until then: run `aiand claude on` again after that date, or run
  `aiand claude on --model <your main model>` to switch now.

## [0.7.0] - 2026-10-26

### Added

- Hermes Agent is now wired like the rest: `aiand hermes on` ships a
  dedicated `aiand` model-provider plugin under
  `~/.hermes/plugins/model-providers/aiand`, adds a `providers.aiand` block
  to `~/.hermes/config.yaml` (`base_url` carries `/v1`, because Hermes posts
  to `${base_url}/chat/completions`), and writes the session key to
  `~/.hermes/.env` (mode 0600) as `AIAND_HERMES_API_KEY`. The plugin carries
  each model's published reasoning levels, so a user's picked level is clamped
  to a set the model accepts and a level left unset sends no
  `reasoning_effort`, leaving the model's own engine default
  (`reasoning_effort_default`) to apply; reasoning switched off omits the
  field entirely instead of sending a level the model does not publish (models
  that do accept it still receive `none`). The model pin
  comes from the live catalog; `--model <id>` switches it, and
  `--model native` leaves the model section as it is. `off` removes exactly
  what `on` added, puts a set-aside model and any set-aside `ANTHROPIC_*`
  lines back, and leaves a provider block you repointed (`base_url` or
  `key_env`) in place with a note. A `providers:` or `model:` key holding an
  inline flow map or an anchor is no longer rewritten: those shapes refuse with
  a by-hand hint instead of dropping the providers the value carried (or
  leaving a duplicate block behind), and a wired home whose `providers:`
  carries an anchor reads as on again, so a second `on` cannot splice a second
  block. A multi-line quoted `.env` value is stripped whole by `off`, so no
  part of it is left behind in your file and the key reads back in full. A
  foreign `providers.aiand` block or a
  legacy `custom_providers` entry named aiand is refused instead of
  overwritten. `aiand hermes` with no verb opens that wiring: the install
  hint is printed rather than run (it is not an npm install), and inherited
  `ANTHROPIC_*` and `OPENAI_*` values are dropped so they cannot outrank
  the files `on` wrote. `status`, `init --all`, logout, and rebake cover it
  (#17, thanks @fenilmodi00).
- `aiand run-agent hermes` launches Hermes on ai& for one session with
  nothing written under the real `~/.hermes`. A throwaway `HERMES_HOME`
  holds the same `aiand` provider plugin, a routing-only `config.yaml`, and
  the key in the overlay `.env`. The child is started with
  `--provider aiand --model <id>` (a launch always names a model, so
  `--model native` is the usual catalog error). Your plugins, sessions, and
  skills are linked back in; inherited `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, and `OPENAI_BASE_URL` are removed from the child;
  `--provider`, `--model`, and `-m` after `--` are stripped. The overlay is
  deleted when Hermes exits, and store shims that pointed at it are put back.
  On Windows the state links back through junctions (a directory symlink
  there needs Developer Mode), so a session's writes survive cleanup, and
  the Hermes install hint names the PowerShell form of the same pinned
  installer instead of a `curl | bash` line a Windows shell cannot run
  (#17, thanks @fenilmodi00).
- The ai& CLI landing page now lives in `site/` and is published to
  GitHub Pages by `.github/workflows/pages.yml`. It shows four steps:
  create an account in the console, redeem a promo code on the console's
  billing page, install the CLI with npm, and run `aiand code`, with a switch
  that swaps in `aiand codex` or `aiand claude`.

### Changed

- `aiand claude on` picks DeepSeek V4.1 Flash for Claude Code's fast slot,
  then Gemma 4. ai& retires DeepSeek V4 Flash, Kimi K2.7 Code and GLM 5.2 on
  2026-10-27 0:00 JST; Kimi K2.7 Code also leaves the main-slot preference.
  A setup written before that date still names DeepSeek V4 Flash: run
  `aiand claude on` again.
- `--base-url` and `aiand config set api-url|auth-url` refuse `/v1`-suffixed
  URLs (adapters append `/v1` themselves, so a suffixed URL would double to
  `/v1/v1`) and base URLs carrying a query or fragment, at set time. An
  unreachable gateway no longer echoes credentials embedded in the base URL.
  (#34, thanks @fenilmodi00)
- The installers now run the installed `aiand --version` for you and print
  the version, instead of asking you to run it.
- At the end of an install, the installers ask "Log in to ai& now?" and run
  `aiand login` on yes. They skip the question when you are already signed
  in, when `AIAND_API_KEY` is set, in CI, or without a terminal. With
  `AIAND_API_KEY` set they say the key is in use instead of suggesting
  `aiand login`. A failed or cancelled login never undoes the install:
  Ctrl+C at the question counts as no, and Ctrl+C during the login stops
  only the login (`install.sh` still exits 0).

### Fixed

- `aiand pi on` writes each model's `maxTokens` from the catalog's
  `max_output_tokens` instead of its context window. Pi sends at most
  `min(maxTokens, contextWindow - estimated prompt - 4096)` as
  `max_completion_tokens`. On `deepseek-ai/deepseek-v4.1-flash`, copying
  the window into `maxTokens` made that reservation exceed the window. A
  null cap leaves `maxTokens` out. Run `aiand pi on` again to pick it up.
  (#43, thanks @nekomario28)
- `aiand hermes off` hands a set-aside `model.base_url` back exactly where
  it sat: a line the only field in `model:` no longer leaves the section
  empty, the restored line returns to its own place instead of drifting to
  the section's end above the next top-level key, a dropped line's trailing
  comment comes back once instead of twice, and CRLF files and files
  without a trailing newline round-trip byte-identically. A stale
  `model.base_url` is dropped even when `model.provider` already routes
  through ai&, so a user's own endpoint can no longer ride a second `on`,
  and the line is only recorded (and noted on `off`) when a drop actually
  happened. `yaml-probes.ts` moved out of routing.ts without behavior
  change.
- OpenCode Launcher sessions and Pi pass each model's published reasoning
  levels. Pi's own default is medium, and an unsupported level moves up to
  the next published one. On GLM-5.3 that level is high. The 0.6.0 Pi note
  called an omitted level a gateway default. That name was wrong.
- `aiand <agent> on` proves the session key with one authenticated request
  before writing anything, so a gateway-rejected key refuses with the
  rejected-key advice instead of being baked into agent configs (a blank
  `AIAND_API_KEY` still reads as signed out). A padded `AIAND_API_KEY` or
  stored key now wires trimmed, so the header no longer serializes as
  `"Bearer  sk-…  "`. (#34, thanks @fenilmodi00)
- `aiand <agent> --help` no longer prints an empty "Config files" line for
  adapters that own no config files, and unusable config paths (a file where
  a directory belongs, a directory where a file belongs, unreadable files)
  refuse exit 1 with a hint instead of a raw stack. (#34, thanks @fenilmodi00)

## [0.6.0] - 2026-10-06

### Added

- `aiand pi on` wires the Pi coding agent to ai& through
  `~/.pi/agent/`: an `aiand` provider in `models.json` speaking the gateway's
  OpenAI-compatible dialect with every model from the live catalog, the
  session key in `auth.json` (locked to 0600, marked `managedBy: "aiand"`),
  and `defaultProvider`/`defaultModel` in `settings.json`. `off` removes
  exactly what `on` added — including from the files `on` recorded when the
  Pi config dir was relocated in between, instead of orphaning the key there
  — and restores a `defaultModel` it had to set aside because the gateway
  cannot serve it; one it can serve is kept. Pass `--model native` to leave
  Pi's own default model, scoped to the `aiand` provider so the session
  cannot fall back to another provider's key. Reasoning models run at their
  gateway default effort: Pi's client would otherwise send an effort level
  (`medium`) the catalog does not publish for every model, and the gateway
  rejects it.
  `aiand run-agent pi` launches Pi on ai& for one session with no Pi config
  written under `~/.pi/`: a throwaway overlay becomes `PI_CODING_AGENT_DIR`
  holding the generated provider and the session key (never the child env),
  while session history lands in the same session directory plain `pi` uses
  (the settings.json `sessionDir`, project-level files included, else Pi's
  per-cwd default), so `pi -c`/`-r` see launcher sessions.
  User-supplied `--provider`/`--model`/`--models`/`--api-key` passthrough
  flags are stripped so the routing cannot be overridden; the overlay is
  removed after the session ends.

- `aiand omp on` wires Oh My Pi to ai& through `~/.omp/agent/`: an
  override-only `aiand` provider block in `models.yml` — baseUrl, the
  session key locked to 0600, and the `managedBy: "aiand"` marker; omp
  already bundles the aiand provider, so nothing else is written — and a
  `modelRoles.default` pin in `config.yml`. `off` removes exactly what `on`
  added, stripping the files `on` recorded when the agent dir was relocated
  in between, and reports `stripped: false` when a relocated file is
  unreadable and nothing was stripped yet; a `modelRoles.default` ai&
  cannot serve is set aside and put back on `off`, one it can serve is kept.
  `on`/`off` survive what omp's own writer emits: empty flow containers,
  quoted scalars containing `": "`, YAML-only double-quote escapes, comments,
  and flow-sequence values with quoted commas (`modes: ["a,b", c]`). Pass
  `--model native` to leave omp's own default. `aiand run-agent omp` launches
  Oh My Pi on ai& for one session with no omp config written under `~/.omp/`,
  session history kept in omp's own session dir including its XDG location
  (`$XDG_DATA_HOME/omp/sessions`) after `omp config init-xdg`.
  User-supplied `--model`/`--provider`/`--api-key`/`--models` passthrough
  flags are stripped so the routing cannot be overridden; the overlay is
  removed after the session ends. The install hint downloads the pinned
  v18.4.4 release asset for your platform into `~/.local/bin`, checks it
  against the pinned sha256 digest, and marks it executable, so nothing
  unverified reaches your PATH.

- `aiand copilot on` wires the GitHub Copilot CLI to ai& by BYOK: an `aiand`
  provider row speaking the gateway's OpenAI-compatible dialect, plus one
  model row per catalog model, in `~/.copilot/providers.json` (or
  `$COPILOT_HOME`), and the `aiand/<id>` pin in `~/.copilot/settings.json`
  that a bare `copilot` launch needs. `off` removes exactly those rows and
  hands back the `model` selection it replaced — from the files `on`
  recorded when the Copilot config dir was relocated in between, instead of
  orphaning the key there — and leaves a value you changed in between. A
  servable `aiand/<id>` you picked in the model menu is kept when `--model`
  is not passed, and another model is only set aside with a warning. The
  provider row holds the session key literal and no GitHub sign-in is
  involved. `aiand run-agent copilot` launches the CLI on ai& for one
  session with nothing written under `~/.copilot`: a throwaway dir becomes
  `COPILOT_HOME` holding the generated provider rows and the session model,
  with `COPILOT_OFFLINE=true` so the session never phones GitHub; your
  `--model` passthrough flag is stripped so the pin cannot be overridden,
  and the overlay is removed after the session ends (session history lives
  in the overlay, not in your real `~/.copilot`).

- `aiand copilot-app on` wires the GitHub Copilot desktop app to ai&.
  Config-only: it writes an `aiand-`-prefixed provider row and one model row
  per catalog model into the app's own provider database,
  `~/.copilot/data.db`, which must exist first - open the app once. On
  Linux the hint points at the app's download page with an "open it once"
  note instead of the macOS `brew install --cask` command, which never
  works there. The app keeps GitHub sign-in even for BYOK providers, and you
  pick the ai& model in its model menu. Quit the app before `on` or `off`,
  since it rewrites the database as it exits; `--force` escapes the refusal.
  Only a due write refuses, so an open app never fails a key rotation or
  `aiand login` for people who never ran `copilot-app on`. The app is a GUI,
  so there is no `run-agent copilot-app`. `aiand pi`, `aiand omp` and
  `aiand copilot` open their agent the way `aiand code` does, wiring it
  first when needed; the install offer runs only npm install commands, so pi
  and copilot offer it while omp prints its verified install command.
  Bare `aiand copilot-app` wires the desktop app and says how to open it,
  since aiand cannot launch a GUI app.

### Fixed

- Opening an agent no longer hands an exported AIAND_API_KEY to the agent's
  process tree, matching `run-agent`; Codex still gets the one its
  `aiand key export` child needs.
- `aiand <agent> off` lists several notes separated with `; ` instead of
  spaces, so a run-on line like "...config dir moved stripped the..." reads
  as distinct notes; the `--json` note stays a single string.

## [0.5.0] - 2026-10-05

### Added

- `aiand code` opens OpenCode on ai&, and `aiand opencode`, `aiand claude`
  and `aiand codex` open their agent the same way. Signed out, you are
  offered a sign-in. If the agent is missing, aiand offers to install it with
  its npm install command. An agent not wired yet is turned `on`. The agent
  then runs with your arguments exactly as typed. Codex starts on its ai&
  profile, except for management commands such as `login`, which refuse a
  profile. OpenCode starts on an ai& model even when `opencode.json` names a
  model of your own, which stays in the file; `on --model native` and an
  `OPENCODE_CONFIG_CONTENT` of your own are respected. Without a terminal, a
  missing agent still prints the install command and exits `127`.

### Changed

- `aiand <agent>` with no verb now opens the agent instead of only wiring
  it; `aiand <agent> on` still wires without opening. aiand's own flags go
  before the agent name (`aiand --profile work claude`), everything after it
  goes to the agent, and `--` passes a verb through (`aiand opencode -- status`).
  A leading `--profile` or `--base-url` wires the agent again to that target.

### Fixed

- An agent started after a sign-in prompt, by `aiand <agent>` or
  `aiand run-agent`, gets every keystroke, and aiand exits when the agent
  does. Before, aiand kept reading the terminal and took some of the input.
- Ctrl-C at a yes/no prompt cancels with exit `130` instead of reporting an
  unexpected error.
- README logo: the red stroke of the prompt no longer sticks out past the
  dark stroke where the two meet.

## [0.4.0] - 2026-09-29

### Added

- `aiand claude on` lists every ai& model in Claude Code's `/model` picker,
  through its `modelPicker` setting: Claude Code only discovers gateway models
  whose id contains "claude", so ai&'s never appeared there. The built-in
  Opus, Sonnet and Haiku rows are replaced, since they would run ai&'s models
  under Anthropic names. A `modelPicker` of your own is kept, and `off`
  removes only the one `on` wrote. `aiand run-agent claude` lists them too.
- `aiand codex on` writes an ai& profile for Codex, `~/.codex/aiand.config.toml`
  (or `$CODEX_HOME`), and leaves `config.toml` alone: start Codex on ai& with
  `codex --profile aiand`. The profile holds no key; Codex runs
  `aiand key export` for your active aiand profile, so a rotation or
  `aiand config use` needs no rewrite. It pins a reasoning level the model publishes, for Plan Mode too,
  and turns off Codex's hosted tools. Only ai&'s own keys are written and
  removed, so settings you add to the profile survive. `aiand run-agent codex`
  launches Codex on ai& with nothing written.

## [0.3.0] - 2026-09-28

### Added

- `aiand claude on` wires Claude Code to ai& through `~/.claude/settings.json`
  (or `$CLAUDE_CONFIG_DIR`); `off` removes exactly what `on` added, and
  `aiand run-agent claude` launches Claude Code on ai& with nothing written.
  Every model slot is filled from the live catalog: a vision model for the
  main slots unless your profile names one, and a fast model for background
  work. `--model` switches the main slots. A `model` setting or
  `env.ANTHROPIC_MODEL` ai& cannot serve is set aside and put back on `off`;
  one it can serve is kept. The Bedrock, Vertex and Foundry switches are
  written as `0`, so one left on elsewhere cannot route Claude Code away from
  ai&. Claude Code's context budget is capped at 200k tokens, so long sessions
  compact before open models start to degrade, including for a model id
  tagged `[1m]`.
  Claude Code's attribution header is turned off, since ai& would otherwise
  pass it to the model as prompt text. WebSearch is denied, since it relies on
  Anthropic's servers; WebFetch keeps working.
- README logo (`docs/assets/aiand-cli-logo.svg`).

### Changed

- README opening rewritten: it leads with "Less setup. More building." and
  three reasons to use the CLI (browser sign-in, OpenCode setup that keeps
  your providers and model, models with prices in your billing currency).
- README quick start moved to the top and now ends in a working agent:
  `aiand login`, `aiand opencode on`, `opencode`. A one-line
  `git diff | aiand run` example follows for quick prompts.
- README install section is shorter, and now says exactly what
  `AIAND_NO_MODIFY_PATH=1` does: it skips permanent PATH changes but still
  puts `aiand` on the installer's own PATH.

## [0.2.0] - 2026-09-24

### Added

- `aiand opencode on` wires OpenCode to ai& permanently; `off` removes exactly
  what `on` added.
- `aiand run-agent opencode` runs OpenCode on ai& for one session, with
  nothing written to your config.
- `aiand login` signs in through your browser; `--paste` and `--with-token`
  accept a key from the console.
- `aiand status` shows sign-in, key storage, and every agent's wiring at once.
- Agent setup details: `on` adds an `aiand` provider to
  `~/.config/opencode/opencode.json` with model entries from the live catalog.
  Your other providers, your own edits, and a model you already set are left
  alone; pass `--model` to switch, or `--model native` to keep the agent's own
  default. `aiand opencode status` reports routing from the real config
  files. JSONC configs (comments, trailing commas) and symlinked dotfiles are
  supported.
- `aiand restore <agent> --force`: break-glass, byte-for-byte restore of the
  config snapshot taken before aiand's first write, under
  `~/.config/aiand/snapshots/`. Plain `off` never replays it.
- `run-agent` passes the agent's exit status through and takes
  `--model <id>` and `-- <args…>`.
- `aiand init` detects installed agents and wires the ones you pick
  (`--all`, `--off`, `--profile`, or an arrow-key checkbox). It never installs
  an agent; missing ones get their official install command.
- `aiand status` exits 0 when signed in or when the gateway is unreachable
  (`reachable: false` in `--json`), and 1 only when signed out, so scripts
  gating on it do not fail during an outage.
- Browser sign-in uses authorization code + PKCE with the redirect caught on
  a loopback port. It falls back to device login when the gateway has no
  browser flow or the browser flow fails, and an interactive device login
  that cannot reach the service offers key paste. Multi-org accounts pick
  their organization with an arrow-key prompt, and minted keys are labeled
  `aiand@<hostname>`.
- A pasted key is validated before it is stored and never revoked by
  `aiand logout`, since this CLI did not mint it.
- `aiand key export` prints the active session key raw, for piping into other
  tools.
- Tiered secret storage: the OS keychain when usable, otherwise an AES-256-GCM
  encrypted file under the config directory, and a plaintext file only with
  `AIAND_KEY_STORAGE=plaintext`. `credentials.json` now holds metadata only;
  existing credentials migrate automatically.
- Signing in again, switching with `aiand config use`, or the automatic
  30-day key rotation swaps the new key into the agent configs aiand wired,
  so nothing needs a re-run of `on`.
- Model defaults resolve from the live catalog, so a retired model id is never
  written into agent config. `aiand models` gains a vision column.
- A once-a-day update notice on interactive terminals when npm has a newer
  release, and a few "what's new" lines after an upgrade. Disable with
  `AIAND_UPDATE_CHECK=0` or `NO_UPDATE_CHECK=1`; it never runs under `CI`.
- `AIAND_NO_BROWSER=1` never opens a browser; sign-in prints the URL instead.
- A mistyped flag suggests the nearest one (`Did you mean --profile?`).
- One-line installers: `install.sh` (macOS, Linux) and `install.ps1`
  (Windows, including a Git Bash shim). Re-run to update. `uninstall` turns
  every aiand-routed agent off first, aborts without deleting anything if that
  fails, and keeps profiles, credentials, and snapshots.

### Changed

- `aiand login` opens the browser by default instead of starting with a
  device code.
- `aiand logout` asks before revoking a device-minted key on a terminal
  (`--revoke` / `--keep-remote` skip the question), and strips the key from
  agent configs aiand wired.
- `aiand whoami` reports where the key came from (device login, pasted key,
  or `AIAND_API_KEY`) and which storage tier holds it.
- `aiand login` with `AIAND_API_KEY` set notes that the env key wins and exits
  without storing anything.
- Exit code `127` also covers a missing agent binary, printed with its install
  command.
- The banner is the `ai&` wordmark.

### Removed

- `aiand login --no-browser`, along with SSH/WSL browser detection. The CLI
  tries the platform opener and prints the URL when there is none; set
  `AIAND_NO_BROWSER=1` to skip the browser entirely.

### Fixed

- Device login requests sent an empty body.
- Piped stdin from sockets (Node child processes) and Windows pipes was
  silently ignored, dropping `run` context.
- A `200` HTML response from the gateway on `run` or `chat` is reported as a
  gateway error instead of a parse failure.
- `aiand logs` against a gateway without request logs says so and points at
  `aiand usage`, instead of a bare HTTP 404.
- Profile names such as `__proto__` are rejected instead of silently dropping
  credential metadata.

## [0.1.2] - 2026-09-07

### Fixed

- Table columns no longer go ragged when a cell contains a wide character.
  Column padding measured JavaScript string length, but a CJK glyph occupies two
  terminal columns and an emoji ZWJ sequence is several code points in one glyph,
  so an organization or model name outside ASCII shifted every column after it.
  Width is now measured in terminal columns over grapheme clusters.
- `aiand --version` reads the version from the package manifest instead of a
  constant that could drift from what was published.

### Added

- A test suite on the built output, using the Node test runner. Covers column
  alignment across scripts, the Server-Sent Events reader (split frames, CRLF,
  keep-alives, malformed frames), the answerless-response diagnosis,
  configuration precedence, and credential file permissions.

## [0.1.1] - 2026-09-07

Initial public release of the ai& command line interface.

### Added

- `aiand login` / `logout` — browser-approved sign-in over the OAuth 2.0 device
  authorization grant (RFC 8628). Approval mints an organization-scoped API key for the
  machine, stored at `~/.config/aiand/credentials.json` with mode `0600`, rotated
  automatically before it lapses and revoked server-side on logout.
- `aiand whoami` — signed-in identity, organization, and key expiry.
- `aiand run` — one prompt, streamed to stdout, with piped stdin appended as context.
  Reports the resolved model, token counts, cost, and request ID from the response
  headers rather than the body.
- `aiand chat` — interactive conversation with an in-session transcript, `/model`,
  `/system`, `/clear`, and `/tokens`.
- `aiand models` — the model catalog priced in the organization's billing currency,
  filterable by capability and sortable by price or context window.
- `aiand logs` — recent inference requests with keyset pagination, an `--errors` filter,
  and `--follow` to tail new traffic.
- `aiand usage` — requests and tokens for a window against the one before it, plus the
  full metric breakdown under `--metrics`.
- `aiand orgs` — organizations the signed-in user belongs to.
- `aiand config` — profiles and defaults. Separate profiles hold separate credentials, so
  more than one organization can be signed in at once.
- `--json` on every command, plus `--profile` and `--base-url` globally.
- `AIAND_API_KEY` support for CI, which bypasses the device login and writes nothing to
  disk.
- An explanation whenever a `200` carries no answer, on both the streaming and
  non-streaming paths, so a reasoning model that exhausts `max_tokens` before writing
  anything says so instead of printing a blank line.

### Implementation Notes

- No runtime dependencies. Argument parsing uses `node:util` `parseArgs` and requests use
  the built-in `fetch`.
- Requires Node 22 or newer.
- Answers go to stdout and everything else to stderr, so `aiand run … > out.md` captures
  only the model's output.
- Streaming reads Server-Sent Events directly; the API includes usage in the final chunk.
- Cost and timing headers are requested with `X-Aiand-Metrics: true` and are returned on
  non-streaming responses only.
- Apache License 2.0, matching the ai& SDKs.
