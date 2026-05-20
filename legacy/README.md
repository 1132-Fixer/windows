# legacy/

Old artifacts kept for reference. **Not used by the Electron app.**

## user.bat

The original standalone batch script the app was modeled on. The current
production behavior lives in [`../main.js`](../main.js)'s `run-fix` IPC
handler, which mirrors the more thorough `reset-user.bat` flow while
excluding media transfer and Zoom group-policy registry edits.

Kept here so the original lineage is greppable. `user.bat` is also
excluded from the electron-builder `files` whitelist via `!*.bat`, so it
is not packaged into the installer.
