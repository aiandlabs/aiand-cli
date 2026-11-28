### Fixed

- Use Claude Code's fail-closed Bash sandbox for supported `aiand claude` and `aiand run-agent claude` sessions, denying shell reads of launcher and stored credential files without allowing unsandboxed commands.
