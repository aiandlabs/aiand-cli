### Fixed

- Refuse permanent Claude Code wiring when a current-repository `.claude/settings.json` or `.claude/settings.local.json` sets `env.ANTHROPIC_BASE_URL`, before snapshotting or writing user settings, so a project endpoint cannot receive the ai& session key. Document removal, the safer `aiand run-agent claude` launcher, and the trusted-endpoint-only `--force` escape.
