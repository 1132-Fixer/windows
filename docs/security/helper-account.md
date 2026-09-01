# Helper account

1132 Fixer uses a local Windows account named `user1` so Zoom can run in a
fresh profile. That account is not your everyday login.

## Current model

- `user1` is a **standard user**, not an administrator.
- Every **Fix now** run mints a new random password.
- The password is sealed with Windows DPAPI (`CurrentUser`) into
  `%APPDATA%\1132 Fixer\helper-credential.bin`.
- The desktop shortcut unseals that blob at click time. You never type it.
- **Fix now** deletes and recreates the helper account. Files in the helper
  profile are removed. Files in your main profile are not.

## What a fix run must prove

- The helper is a standard user
- Zoom is not started from a TEMP or suffixed profile
- Cancellation stops at a safe boundary and does not leave a half-built
  helper as a silent success

Engine tests for those rules live in `tools/profile-safety-smoke.js`,
`tools/helper-credential-smoke.js`, and `tools/fix-cancel-smoke.js`.

## History

The original static `user1` / `user1` administrator password is retired. The
design notes that led to the current model are kept as
[history/security-followup-static-helper-account.md](../history/security-followup-static-helper-account.md).
Do not restore a static password or helper-admin membership.
