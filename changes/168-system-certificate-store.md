### Fixed

- Trust the operating system's certificate store for every request, not only when a proxy is set, so a network that inspects HTTPS with a company root installed in that store works with no variable set. A request that fails on an untrusted root says so in plain words, and `aiand status` reports it instead of a plain outage. `AIAND_SYSTEM_CA=0` keeps Node's own roots only. On Linux the store is the distribution's CA bundle; `SSL_CERT_FILE` and `SSL_CERT_DIR` do not add roots the CLI trusts.
- Pass the store on to the agents and `npm install -g` runs that aiand starts (`NODE_USE_SYSTEM_CA=1` on Windows and macOS, and `NODE_EXTRA_CA_CERTS` for roots Node lacks, for the agents that do not read the store themselves). `aiand <agent> on` for Pi, Oh My Pi and Jouzu names the setting when the gateway's certificate chains to a root only the store holds.
- The installers' release download reads the store too, and every installer download names an untrusted root when it fails on one.

### Added

- An IT administrator guide to company root certificates, in English and Japanese.
