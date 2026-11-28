### Fixed

- Codex profiles and one-session launches omit the unsupported Statsig feature key on known older Codex versions, keeping the pinned 0.165.0 release compatible with `--strict-config` while retaining metrics-export and credential-filter settings. CI now exercises the installer-pinned Codex binary, and the trusted-project smoke uses a real Git repository and a valid provider definition. (#174, thanks @willbohn)
