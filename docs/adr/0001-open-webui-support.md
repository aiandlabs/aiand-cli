# ADR 0001: What "support" means for Open WebUI

- Status: proposed
- Date: 2026-11-17
- Linear: AIA-2064 (provider listing), AIA-2215 (setup guide), AIA-2081 (model
  metadata), AIA-2821 (one-click deploy)

## Context

Every agent the CLI supports today is a local coding-agent CLI or desktop app.
Its routing lives in config files on this machine, which the adapter edits,
marks, snapshots and strips. Open WebUI is a different kind of tool. It is a
self-hosted chat web app, and one instance is usually shared by many users. Its
OpenAI connections are not stored in a local file. They live in the instance's
database, and only an admin can change them, either in Admin › Settings ›
Connections or through the admin API (`GET /openai/config` and
`POST /openai/config/update`).

What ai& has decided around Open WebUI:

- ai& is positioned as a **model provider** for Open WebUI, not as a front
  end. A hosted or managed Open WebUI from ai& was decided against on
  2026-10-26 (AIA-2064), because it would compete with ai& Chat.
- The plain integration comes first: an admin adds `https://api.aiand.com/v1`
  with their key. The guide (AIA-2215) and Open WebUI's partner page describe
  it. David made this a condition of the one-click deploy (AIA-2821).
- Deployment belongs to Build. The "Deploy with Build" button (AIA-2821) runs
  Open WebUI and injects the connection through `OPENAI_API_BASE_URL` and
  `OPENAI_API_KEY`. The guide ships a Docker Compose example.
- Model metadata (vision, context, reasoning) is being fixed upstream through
  feature requests (AIA-2081, AIA-2090). It is not something a client-side
  tool can patch.

## Options considered

1. **Wire a running instance through its admin API.** `aiand openwebui on`
   adds an ai& OpenAI connection to an instance the user already runs,
   whether it is local Docker, pip, Build, or a company server. This is what
   the guide asks the admin to do by hand.
2. **Launch Open WebUI preconfigured** (`docker run` or `pip install
   open-webui && open-webui serve`, with `OPENAI_API_BASE_URL` and
   `OPENAI_API_KEY` set).
3. **Generate a Compose file and `.env`** for the user to run.

## Decision

Option 1. `openwebui` is an adapter whose managed config is a running
instance's OpenAI connection list. It is not a local file. `on`, `off`,
`status`, `restore --force`, rebake and logout all act on that list through
the admin API.

- **Target instance:** `OPENWEBUI_URL`, defaulting to `http://localhost:3000`
  (the port in Open WebUI's Docker quick start). The URL must be `https`, or
  `http` on loopback, because the CLI sends both the ai& key and an admin
  credential to it. `on` records the URL, so later `off` and `status` calls
  reach the same instance without the variable.
- **Admin credential:** `OPENWEBUI_API_KEY`, which is an Open WebUI API key
  (`sk-…`, from Settings › Account) or a session token belonging to an admin.
  The CLI never stores it. It is read from the environment for each call, the
  same way `AIAND_API_KEY` is.
- **on:** read the connection list, then append
  `https://api.aiand.com/v1` (or the profile's API URL plus `/v1`) with the
  session key, and write the list back. Other connections, their keys, their
  order and their per-connection settings are left as they were. A connection
  to the same base URL that aiand did not add belongs to the user. `on`
  refuses to add a duplicate, and the hint explains that this connection
  already routes to ai&.
- **Ownership:** the connection with the recorded base URL whose key matches
  the SHA-256 fingerprint of the key aiand baked, which is kept in the
  added-state. The key itself is never recorded. Open WebUI's connection
  editor rebuilds `config` from scratch on save, so an in-band marker field
  would not survive an edit. This is the same approach as the Copilot app's
  recorded row id.
- **off:** remove exactly that connection. A connection whose key the user
  changed is now theirs, so `off` leaves it and says so. `on` turns
  `ENABLE_OPENAI_API` on if it was off; `off` turns it back off only when no
  connection has been added since, because a connection added since would
  stop working too.
- **off without the admin credential fails.** Otherwise `init --off` and
  uninstall would carry on and leave a live key on a shared server.
  `off --force` forgets the record when the instance is out of reach or no
  admin credential is set, and
  says the key is still on the instance and should be revoked.
- **status:** read the live list from the instance. This never trusts the
  record alone. With no record there is no network call. With a record but no
  `OPENWEBUI_API_KEY`, `status` reports that it cannot check.
- **Snapshot and restore:** before the first write, the instance's OpenAI
  config is captured with every key literal removed (and every setting named
  like a key, token, secret, password or header). A capture of a different
  instance is replaced when `on` targets a new one. `restore --force` puts
  back the URL list, per-connection settings and the enabled flag. For each
  restored connection it reuses the key the instance holds now. No
  third-party key is ever written to disk.
- **Rebake and logout:** rotate or strip the key on the instance when
  `OPENWEBUI_API_KEY` is set. When it is not set, they tell the user to run
  `aiand openwebui on` or `off` with it set, because a silent skip would leave
  a live key on a shared server.
- **open (`aiand openwebui`):** wire the instance if it is not wired yet, then
  open its URL in the browser, honoring `AIAND_NO_BROWSER`. This is
  config-only, like the Copilot app: the CLI never runs or manages the server.
  Open WebUI installs through pip or Docker, not npm, so the install hint is
  printed with no offer to run it.
- **No `run-agent openwebui`.** One web session cannot be routed separately.

## Why not launch it (options 2 and 3)

- `OPENAI_API_BASE_URL` and `OPENAI_API_KEY` are PersistentConfig in Open
  WebUI. They are read only on first boot, and after that the database wins.
  A launcher could therefore wire a fresh instance once, but could not turn it
  off, report its state, or rotate its key. That breaks `on`, `off`, `status`
  and rebake.
- Passing the key as a container environment variable exposes it through
  `docker inspect` and the process table.
- Running and updating the server is deployment work. That belongs to Build
  (AIA-2821) and the guide's Compose example (AIA-2215). A CLI-run instance
  would also edge toward the ai&-run Open WebUI that AIA-2064 decided against.
- The image is several gigabytes. The CLI's install offer runs only npm
  installs (see "open" in CONTEXT.md).

## Consequences

- Open WebUI support works for any instance the user can reach as an admin,
  including one deployed by Build.
- `aiand status` and `aiand init` make one loopback or HTTPS call per
  recorded Open WebUI instance.
- The adapter is the first one whose managed config is remote, so it adds an
  optional `restore()` hook to the adapter type. `restore --force` uses the
  hook when an adapter has no local files to restore.
- Model metadata defaults stay with AIA-2081. The CLI writes no per-model
  overrides into Open WebUI.
