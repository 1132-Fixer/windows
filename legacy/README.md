# legacy/

Old artifacts kept for reference. **Not used by the Electron app.**

## user.bat (removed 2026-11-23)

`user.bat` was the original standalone batch script that the app was modeled
on. It set a fixed password for the local `user1` helper account. It was
never packaged and nothing ran it, so it was removed. Earlier commits still
contain it.

Removing the file does not close the exposure. 1132 Fixer 5.2.0 to 5.5.1 set
the same fixed password on every FIX NOW run, and that value stays public in
those releases. Since 5.6.0, the `run-fix` handler in [`../main.js`](../main.js)
deletes and recreates `user1` with a new random password during FIX NOW
(`helper-credential.js`). The app stores the new credential encrypted.
Installing or upgrading alone leaves the account
untouched. If neither a later repair nor an administrator has replaced
the shared password, follow the [6.5.0 release guidance](../docs/releases/6.5.0.md#helper-account-password).
