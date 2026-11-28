### Fixed

- `aiand logout` no longer reports success while the OS keychain still holds the key. When the keychain will not delete it (for example while it is locked), `logout` strips the key from agent configs, keeps the sign-in, says where the key is, and exits 1; `logout --all` lists the profile and keeps its sign-in files for a retry. A keychain that simply has no such item, or that this machine cannot reach at all, is still a no-op.
- `aiand logout` no longer says a profile "was not signed in" when its stored sign-in exists but cannot be read (a locked keychain). It exits 1 and removes nothing, so the key can still be revoked once the keychain is unlocked; `--keep-remote` forgets it without revoking.
- `aiand logout` no longer clears a sign-in that changed while it waited for another aiand process (a login in another terminal): it exits 1 and keeps it, so its key can still be revoked. `aiand logout --all` likewise keeps and reports a sign-in stored while it ran.
- Storing a key in the OS keychain now removes the copy an earlier fallback left in the encrypted key file, which a failed keychain read could otherwise bring back.
- `aiand logout --all` checks again that the config directory is the one it verified before and after taking each profile's lock, so it never creates `locks/` in a directory swapped in while it ran.
- `aiand logout --json` escapes C1 and bidirectional control characters in its output, like every other `--json` command. (Found in fenilmodi00's fork, `1caa982` and `df9f3de`; thanks fenilmodi00.)
