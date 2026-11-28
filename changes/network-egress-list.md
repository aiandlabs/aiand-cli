### Added

- Publish every host the CLI, its installers, browser sign-in and each coding agent it sets up contact, with what each is for and how to turn the optional ones off, in `docs/network-egress.json` and in the IT administrator network guide generated from it (English and Japanese). The test suite now fails when the CLI's code or installers name a host the list does not have, or the list keeps a host nothing uses. The scan catches quoted hostnames on any TLD and the static end of hosts built from templates or joined strings, and each agent's entries record the version they were checked at, so bumping an agent's pinned version fails the suite until its hosts are re-checked.

### Changed

- `aiand claude on` and `aiand claude` set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so Claude Code sends no telemetry, feature-flag or update checks to Anthropic. It also turns off Claude Code's auto-updater, error reporting and `/bug`; an empty value of your own (`"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": ""`) keeps them and is left in place, and `off` removes what `on` wrote.
- The Codex `aiand` profile sets `[analytics] enabled = false`, so Codex sends no product analytics to OpenAI even when an OpenAI sign-in is also present.
- `aiand pi on`, `aiand run-agent pi` and `aiand jouzu on` set `enableInstallTelemetry: false`, so Pi and Jouzu do not report installs to pi.dev; a value of your own is left alone, and `off` removes only what `on` wrote.
