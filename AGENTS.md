# @aiand/cli

The ai& command line interface. Node 22+, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Verification

`npm run lint && npm test && npm run check:dist && npm run check:public` before handing over any change (`npm test` builds first via `pretest`). Agent-adapter changes also run `node scripts/e2e.mjs`; installer changes also run `node scripts/install-behavior.mjs`.

## Conventions

Tests isolate with `AIAND_HOME`/`AIAND_CONFIG_DIR`, never the real home.
`npm test` preloads `test/setup.mjs` (`AIAND_NO_BROWSER=1`, stub
`security`/`secret-tool` first on PATH) so no test opens a browser or touches
the OS keychain; run test files through it, and put `AIAND_TEST_STUB_BIN` on
any hermetic PATH a test builds.

CLI-error coverage: `test/mock-gateway.mjs` (loopback HTTP double) plus
`withMockGateway` in `test/helpers.mjs` drive the built CLI against scripted
429/401/happy-path responses — extend those before adding live-gateway
coverage. `install.sh` / `install.ps1` uninstall stay covered in `scripts/e2e.mjs`
(`install.ps1` uninstall only on win32, run by the `installer-windows` job) and
`scripts/install-behavior.mjs`. The `installer-windows` job is the
full PS1 install path on `windows-latest`: local-checkout `npm ci` + build,
`aiand.cmd` and Git Bash shim `--version`, then `uninstall --force`, then
`scripts/e2e.mjs`. Do not run `install.ps1`
install against a Linux checkout — Windows `npm ci` would replace
`node_modules`. Its rm -rf target must stay canonicalized and HOME-bounded.

Publishing (`publish.yml`) runs only after CI succeeds on a push to main.

Issues live as GitHub issues on aiandlabs/aiand-cli, managed via the `gh` CLI.
Domain vocabulary, agent-wiring rules, and ADR locations: `CONTEXT.md` at the repo root — use its words exactly.
