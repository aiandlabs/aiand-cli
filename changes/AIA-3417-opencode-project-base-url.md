### Fixed

- Refuse permanent OpenCode wiring when a current-repository `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`, or `.opencode/opencode.jsonc` sets `provider.aiand.options.baseURL`, so a project endpoint cannot receive the ai& session key. Document removal, `aiand run-agent opencode`, and the trusted-endpoint-only `--force` escape.
