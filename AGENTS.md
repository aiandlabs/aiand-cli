# @aiand/cli

The ai& command line interface. Node 22+, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Verification

`npm run lint && npm test && npm run check:dist && npm run check:public` before handing over any change (`npm run lint` is tsc, Biome, and knip for unused files, exports, and dependencies; `npm run fix` applies Biome's safe fixes and formatting) (`npm test` builds first via `pretest`). CI runs the suite as `npm run test:coverage`, which fails below the coverage floor in `package.json`; raise the floor when coverage rises, never lower it to land a change. Agent-adapter changes also run `node scripts/e2e.mjs`; installer changes also run `node scripts/install-behavior.mjs`.

## Conventions

Tests isolate with `AIAND_HOME`/`AIAND_CONFIG_DIR`, never the real home.
`npm test` preloads `test/setup.mjs` (`AIAND_NO_BROWSER=1`, stub
`security`/`secret-tool` first on PATH, and `test/net-guard.mjs` on
`NODE_OPTIONS`) so no test opens a browser, touches the OS keychain, or
reaches a non-loopback host. Run test files through it, build hermetic PATHs
with `hermeticPath()` from `test/helpers.mjs`, and point offline base URLs at
`CLOSED_URL` or `withMockGateway`. Only `test/e2e-live.test.mjs` opts out of
the network guard (`AIAND_TEST_ALLOW_NETWORK=1`).

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

Publishing (`publish.yml`) runs only on a pushed `v<version>` tag matching `package.json`, on a main commit that passed CI; merges never publish.

Issues live as GitHub issues on aiandlabs/aiand-cli, managed via the `gh` CLI.
Domain vocabulary, agent-wiring rules, and ADR locations: `CONTEXT.md` at the repo root — use its words exactly.
