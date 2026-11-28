**English** | [日本語](it-admin-certificates.ja.md)

# Company root certificates and HTTPS inspection

For IT administrators whose network inspects HTTPS: a gateway re-signs every
site with a company root certificate. This page says what `aiand`, its
installers and the coding agents it sets up need for that root to be trusted.

Short version: install the root in the operating system's certificate store,
the way every other managed application needs it. Nothing else is required for
`aiand` itself, and no environment variable has to be set.

## Where the root goes

| Platform | Store | Typical deployment |
| --- | --- | --- |
| Windows | Local Computer, **Trusted Root Certification Authorities** (the Enterprise and Group Policy stores also count) | Group Policy, Intune, or `certutil -addstore Root company-root.cer` |
| macOS | **System** keychain, marked as trusted for SSL | An MDM configuration profile, or Keychain Access: import into the System keychain and set *When using this certificate* to *Always Trust* |
| Linux | The distribution's CA bundle | Debian/Ubuntu: copy to `/usr/local/share/ca-certificates/` and run `update-ca-certificates`. RHEL/Fedora: copy to `/etc/pki/ca-trust/source/anchors/` and run `update-ca-trust` |

## The `aiand` CLI

- Every request the CLI makes trusts three sets together: the roots Node.js
  ships with, the operating system's store, and `NODE_EXTRA_CA_CERTS` if it is
  set. That covers sign-in (browser and device code), `models`, `status`,
  `aiand <agent> on`, chat and run, and the update check.
- This holds with or without a proxy. The CLI reads the store itself before
  its first request, through Node.js's own system-store support (the same
  store `node --use-system-ca` reads). The release binaries are built with
  `--use-system-ca`.
- Requirement: Node.js 22.21 or later, which the CLI already requires. An older
  Node.js cannot read the store; there, set `NODE_EXTRA_CA_CERTS` to a PEM file
  holding the company root.
- `AIAND_SYSTEM_CA=0` turns the store off and keeps Node.js's own roots only,
  for a site that wants exactly that. It also stops the CLI passing the store
  on to agents (below).
- When a request does fail on the certificate, the CLI says so in plain words:
  `Could not reach https://api.aiand.com: its certificate is not trusted on this
  computer.`, followed by what to do. `aiand status` prints the same reason in
  place of "Check your network and retry.", and `aiand status --json` carries
  it in `auth.reason`.

## The installers

| Step | What it uses | Trusts the store |
| --- | --- | --- |
| `curl -fsSL …/install.sh \| bash` | Your `curl` | Yes, through `curl`'s TLS library (the Linux bundle; the keychain on macOS) |
| `irm …/install.ps1 \| iex` | PowerShell | Yes (Windows certificate store) |
| Release binary download (`install.sh`) | `curl` | Yes, as above |
| Release binary download (`install.ps1`) | .NET `HttpWebRequest` | Yes (Windows certificate store) |
| npm package download (both installers) | Node.js | Yes on Node.js 22.19 or later; on an older Node.js, set `NODE_EXTRA_CA_CERTS` |

A certificate failure in any of these says `its certificate is not trusted on
this computer` and leaves the existing installation unchanged.

Building from source (`AIAND_SOURCE`) runs `git clone` and `npm ci`, which use
their own settings: on Windows, `git config --global http.sslBackend schannel`
makes Git use the Windows store; for npm, set `NODE_EXTRA_CA_CERTS`.

## Coding agents

Each agent has its own HTTP client and decides for itself which roots it
trusts. Most read the operating system's store already.

When `aiand` starts an agent (`aiand <agent>`, `aiand run-agent <agent>`), or
runs `npm install -g` to install one, it adds two variables to that process
only, and to nothing else on the machine:

- `NODE_USE_SYSTEM_CA=1`, which makes Node.js 22.19+ and Bun 1.2.23+ read the
  store.
- `NODE_EXTRA_CA_CERTS`, pointing at `system-ca.pem` in the aiand config
  folder (`~/.config/aiand/` by default, `%USERPROFILE%\.config\aiand\` on
  Windows). The file holds the roots in the store that Node.js's own set lacks,
  and is rewritten from the store on each launch. It is set only when the
  store holds such roots.

A variable that is already set is left as it is. `SSL_CERT_FILE` is never set:
on Linux it replaces Codex's store instead of adding to it. The variables are
inherited by what the agent itself runs.

| Agent | Reads the store by itself | Running the agent directly, without `aiand` |
| --- | --- | --- |
| Claude Code | Yes (`CLAUDE_CODE_CERT_STORE` defaults to `bundled,system`; an npm install needs Node.js 22.15+) | Nothing to set. `NODE_EXTRA_CA_CERTS` adds a PEM file |
| Codex | Yes (the operating system's roots) | Nothing to set. `CODEX_CA_CERTIFICATE` adds a PEM file. On Linux, do not point `SSL_CERT_FILE` at a file holding only the company root: Codex then trusts that file alone |
| OpenCode | Yes (built with `--use-system-ca`) | Nothing to set. `NODE_EXTRA_CA_CERTS` adds a PEM file |
| GitHub Copilot CLI | Yes | Nothing to set. `NODE_EXTRA_CA_CERTS` adds a PEM file |
| GitHub Copilot app | Yes | Nothing to set (`aiand` does not start the app) |
| Hermes Agent | Yes (Python `truststore`) | Nothing to set. `SSL_CERT_FILE` adds a PEM file; a provider's own `ssl_ca_cert` replaces the store for that provider |
| Pi | No (Node.js's own roots only) | Set `NODE_USE_SYSTEM_CA=1` (Node.js 22.19+), or `NODE_EXTRA_CA_CERTS` to a PEM file holding the company root |
| Oh My Pi | No (Bun's own roots only) | Set `NODE_EXTRA_CA_CERTS` to a PEM file holding the company root. `NODE_USE_SYSTEM_CA=1` works on Bun 1.2.23+ |
| Jouzu | No (Node.js's own roots only) | As for Pi |

For Pi, Oh My Pi and Jouzu, `aiand <agent> on` prints a note naming
`NODE_USE_SYSTEM_CA=1` when the store holds roots those agents would not
trust. Set it machine-wide (a Group Policy environment variable on Windows,
`/etc/environment` or a profile script elsewhere) for people who start the
agent directly.

This table describes the agent versions `aiand` installs; an agent's own
documentation is the reference for later versions.

## Checking a machine

- `aiand status` reports the gateway as reachable, or names the certificate.
- `node -p "require('tls').getCACertificates('system').length"` prints how many
  roots Node.js finds in the store. Zero on a machine with a company root means
  the root is not in the store Node.js reads (for example, a macOS root in a
  user's login keychain that is not marked trusted).

Do not work around certificate errors by turning verification off
(`NODE_TLS_REJECT_UNAUTHORIZED=0`, `--insecure`, `ssl_verify: false`). That
accepts any certificate from anyone on the network path.
