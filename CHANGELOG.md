# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [0.1.2] - 2026-09-07

### Fixed

- Table columns no longer go ragged when a cell contains a wide character.
  Column padding measured JavaScript string length, but a CJK glyph occupies two
  terminal columns and an emoji ZWJ sequence is several code points in one glyph,
  so an organization or model name outside ASCII shifted every column after it.
  Width is now measured in terminal columns over grapheme clusters.
- `aiand --version` reads the version from the package manifest instead of a
  constant that could drift from what was published.

### Added

- A test suite on the built output, using the Node test runner. Covers column
  alignment across scripts, the Server-Sent Events reader (split frames, CRLF,
  keep-alives, malformed frames), the answerless-response diagnosis,
  configuration precedence, and credential file permissions.

## [0.1.1] - 2026-09-07

Initial public release of the ai& command line interface.

### Added

- `aiand login` / `logout` — browser-approved sign-in over the OAuth 2.0 device
  authorization grant (RFC 8628). Approval mints an organization-scoped API key for the
  machine, stored at `~/.config/aiand/credentials.json` with mode `0600`, rotated
  automatically before it lapses and revoked server-side on logout.
- `aiand whoami` — signed-in identity, organization, and key expiry.
- `aiand run` — one prompt, streamed to stdout, with piped stdin appended as context.
  Reports the resolved model, token counts, cost, and request ID from the response
  headers rather than the body.
- `aiand chat` — interactive conversation with an in-session transcript, `/model`,
  `/system`, `/clear`, and `/tokens`.
- `aiand models` — the model catalog priced in the organization's billing currency,
  filterable by capability and sortable by price or context window.
- `aiand logs` — recent inference requests with keyset pagination, an `--errors` filter,
  and `--follow` to tail new traffic.
- `aiand usage` — requests and tokens for a window against the one before it, plus the
  full metric breakdown under `--metrics`.
- `aiand orgs` — organizations the signed-in user belongs to.
- `aiand config` — profiles and defaults. Separate profiles hold separate credentials, so
  more than one organization can be signed in at once.
- `--json` on every command, plus `--profile` and `--base-url` globally.
- `AIAND_API_KEY` support for CI, which bypasses the device login and writes nothing to
  disk.
- An explanation whenever a `200` carries no answer, on both the streaming and
  non-streaming paths, so a reasoning model that exhausts `max_tokens` before writing
  anything says so instead of printing a blank line.

### Implementation Notes

- No runtime dependencies. Argument parsing uses `node:util` `parseArgs` and requests use
  the built-in `fetch`.
- Requires Node 22 or newer.
- Answers go to stdout and everything else to stderr, so `aiand run … > out.md` captures
  only the model's output.
- Streaming reads Server-Sent Events directly; the API includes usage in the final chunk.
- Cost and timing headers are requested with `X-Aiand-Metrics: true` and are returned on
  non-streaming responses only.
- Apache License 2.0, matching the ai& SDKs.
