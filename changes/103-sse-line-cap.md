### Fixed

- A server-sent event line over 1 MiB now stops the stream however the gateway's bytes are split across network reads. Before, a line that ended in the same read that took it past the cap got through as one oversized delta. (#103, thanks @willbohn)
