# legacy/

Old artifacts kept for reference. **Not used by the Electron app.**

## user.bat (removed 2026-11-23)

`user.bat` was the original standalone batch script that the app was modeled
on. It set a fixed password for the local `user1` helper account. It was
never packaged and nothing ran it, but a public file must not publish a
known password, so it was removed. Earlier commits still contain it.

The current production behavior lives in [`../main.js`](../main.js)'s
`run-fix` handler. Every FIX NOW run deletes and recreates `user1` with a new
random password (`helper-credential.js`); no password is stored in plain text.
A computer that once ran the old standalone script keeps that fixed password
until FIX NOW runs once.
