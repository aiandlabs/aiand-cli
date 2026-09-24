# Security Policy

## Reporting a vulnerability

Report it privately through
[GitHub Security Advisories](https://github.com/aiandlabs/aiand-cli/security/advisories/new)
for this repository. Do not open a public issue.

Please include:

- what an attacker can do, and what they need first
- steps to reproduce, or a proof of concept
- the affected version (`aiand --version`), OS, and key storage tier
  (`aiand status`)
- any mitigation you know of

Fixes ship in the latest release only; there are no backport branches before
`1.0`.

## Trust boundary

`aiand` runs as the local user, inside that user's trust boundary. It stores
an API key and writes it into coding-agent configs, so be precise about what
is in scope.

In scope:

- a key leaking outside the user's own account: into logs, error output,
  crash reports, process arguments other users can read, world-readable
  files, or requests to any host other than the configured ai& endpoint
- a key written somewhere the documentation does not say it goes
- a file or directory created with broader permissions than documented
- the installers (`install.sh`, `install.ps1`) writing, deleting, or executing
  outside their documented paths
- sign-in flaws: device-code phishing that the CLI could have prevented, or
  accepting a token for the wrong account or organization

Out of scope:

- anything that needs prior write access to the user's home directory, shell
  startup files, environment, `~/.config/aiand`, or an agent's config. That
  access already controls every tool the user runs.
- reading the encrypted file tier's key: `secret-store.key` sits next to
  `secret-store.json` by design. That tier guards against a casual read, not
  against someone who can read the config directory (see the README).
- the key being readable in an agent's config after `aiand <agent> on`. The
  agent needs it there; `aiand <agent> off` removes it.
- `AIAND_KEY_STORAGE=plaintext`, which stores the key in plaintext on request
- vulnerabilities in the coding agents themselves (report those upstream)
