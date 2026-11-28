### Added

- Publish every host the CLI, its installers, browser sign-in and each coding agent it sets up contact, with what each is for and how to turn the optional ones off, in `docs/network-egress.json` and in the IT administrator network guide generated from it (English and Japanese). The test suite now fails when the CLI's code or installers name a host the list does not have, or the list keeps a host nothing uses.

### Changed

- `aiand claude on` and `aiand claude` set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `skipWebFetchPreflight: true`, so Claude Code sends no telemetry, feature-flag or update checks and no WebFetch domain checks to Anthropic; `off` removes both.
- The Codex `aiand` profile sets `[analytics] enabled = false`, so Codex sends no product analytics to OpenAI even when an OpenAI sign-in is also present.
- `aiand pi on`, `aiand run-agent pi` and `aiand jouzu on` set `enableInstallTelemetry: false`, so Pi and Jouzu do not report installs to pi.dev; a value of your own is left alone, and `off` removes only what `on` wrote.
