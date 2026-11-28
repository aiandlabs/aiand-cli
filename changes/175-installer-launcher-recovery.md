### Fixed

- Keep the Bash installer's launcher usable when an update between npm and prebuilt layouts is interrupted after the directory swap. Publish the launcher atomically before replacing an existing installation, preserve another checkout's launcher if first activation fails, and retain the previous Node path for rollback when Node leaves PATH. (#175, thanks @willbohn)
