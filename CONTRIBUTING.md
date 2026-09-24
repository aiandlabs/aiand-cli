# Contributing

Node 22+, TypeScript, plain `tsc`, zero runtime dependencies. Domain
vocabulary lives in [CONTEXT.md](CONTEXT.md); use its terms in code, docs,
and commit messages.

## Checks

```bash
npm ci
npm run lint                        # tsc build + biome check + knip (unused code/deps)
npm run fix                         # apply Biome's safe fixes and formatting
npm test                            # builds, then node:test
npm run test:coverage               # same suite, fails below the coverage floor
npm run check:dist                  # asserts on the built binary
npm run check:public                # repository hygiene checks
node scripts/e2e.mjs                # agent-adapter and uninstall changes
node scripts/install-behavior.mjs   # install.sh / install.ps1 changes
```

`npm test` preloads `test/setup.mjs`, which keeps the run off your machine:
no browser opens, the OS keychain is stubbed out, and `fetch` to anything but
loopback fails as if offline. Run test files through
`npm test` (or `node --import ./test/setup.mjs --test <file>`), not bare
`node --test`.

## Live gateway runs

Two scripts talk to the real gateway with a real key and spend a few cents of
credit per run. Both keep every bit of state in a fresh temp directory and
stub the OS keychain, so they are safe on a workstation.

- `test/e2e-live.test.mjs` runs inside `npm test` when `AIAND_API_KEY` is set
  and `opencode` is on PATH: `aiand opencode on`, then a real `opencode run`.
- `scripts/sbx-test.mjs` is the full command matrix: pasted-key sign-in,
  `whoami`, `status`, `run`, `models`, `logs`, `usage`, `orgs`, `config`,
  logout, `opencode on`/`status`/`off`, `restore --force`, `init`, and the
  `run-agent` launcher.

```bash
npm run build
export AIAND_API_KEY=sk-…
node scripts/sbx-test.mjs dist/index.js   # full live matrix
node scripts/sbx-test.mjs --smoke         # offline subset, no key or network
node scripts/sbx-test.mjs --plan          # list the checks and exit
```

To run the matrix in a throwaway box instead, copy `dist`, `package.json`,
`CHANGELOG.md`, and `scripts/sbx-test.mjs` in and run the same command, for
example `docker run --rm -e AIAND_API_KEY -v "$PWD:/work" -w /work node:22-slim
node scripts/sbx-test.mjs dist/index.js`. `scripts/contree-e2e.sh` does the
same in a ConTree microVM.

## CI

The coverage floor (`--test-coverage-*` in `package.json`'s `test:coverage`)
sits just under the current numbers, measured without `AIAND_API_KEY`. Raise it
when coverage goes up; never lower it to land a change.

- `build`: lint, `npm run test:coverage`, `scripts/e2e.mjs`, the offline `sbx-test.mjs
  --smoke`, `check:dist`, and `check:public`. With the `AIAND_API_KEY` secret
  (pushes to main and pull requests from branches of this repository),
  the test run includes the live OpenCode run.
- `live`: the full `sbx-test.mjs` matrix against the real gateway, on the same
  events. Fork pull requests get no secrets and skip it.
- `installer` / `installer-windows`: a real install into an isolated home on
  Ubuntu and Windows, `scripts/install-behavior.mjs`, and uninstall.
- `npm audit` (daily, not per PR): advisories and registry signatures for the
  installed toolchain.

Security reports go through GitHub Security Advisories; see `SECURITY.md`.

## Releasing

Merges to main never publish; a pushed `v<version>` tag does. Changes land
with a `CHANGELOG.md` entry under `## [Unreleased]`; released sections are
never edited.

```bash
npm run release -- prepare patch   # or minor, major, x.y.z
# review and merge the release/v<version> PR, wait for CI on main
npm run release -- tag
```

`prepare` runs from an up-to-date main: it bumps `package.json`, turns
`[Unreleased]` into `[<version>] - <date>` with a fresh empty `[Unreleased]`
above, runs the checks, and opens the PR. `tag` refuses unless main is clean,
at `origin/main`, and has a successful CI run, then pushes the tag.

`publish.yml` checks the same things again (tag matches `package.json`, commit
on main with a successful CI run, version not yet on npm), publishes to npm,
and creates the GitHub release with that version's changelog section as its
notes.
