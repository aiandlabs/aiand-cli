### Changed

- Change empty or whitespace-only required key-prompt failures from exit 2 to exit 1, classifying them as usage errors rather than missing sign-ins. (Reference: `e493cc7`; thanks @fenilmodi00.)

### Fixed

- Report `Input required.` with `AIAND_API_KEY` guidance for empty input and non-TTY end-of-input, so empty input no longer masquerades as being signed out.
