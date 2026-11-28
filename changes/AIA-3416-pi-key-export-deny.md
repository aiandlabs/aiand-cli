### Fixed

- Persistent Pi and Jouzu wiring and Pi Launcher overlays now load a packaged extension that denies direct `aiand key export*` Bash tool calls while preserving user-owned extension entries; this direct-command guard does not establish a filesystem credential boundary.
