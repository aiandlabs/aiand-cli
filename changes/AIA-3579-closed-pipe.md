### Fixed

- Exit quietly when a downstream consumer closes stdout early, avoiding an unhandled `EPIPE` stack trace while preserving the command's selected exit status. (Reference: `54169ee`; thanks @fenilmodi00.)
