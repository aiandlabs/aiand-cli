### Fixed

- Keep the Bash installer's launcher usable when an update between npm and prebuilt layouts is interrupted after the directory swap. Publish the launcher atomically before activation and retain the previous Node path for rollback when Node leaves PATH. Thanks @willbohn.
