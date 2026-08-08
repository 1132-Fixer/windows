# P0: Replace static `user1` / `user1` helper-account credential model

**Status:** proposed — not opened as a GitHub issue yet.
**Update 2026-08-08:** item 2 (local admin by default) is RESOLVED — `user1`
is now created as a **standard user**, and a fix run strips the
Administrators membership from a legacy admin `user1`
(W5-SECURITY-DESIGN Option B / SEC-A6). The static-password items
(1, 4, 5) remain open.
**Severity:** P0 (security architecture)
**Tracking suggestion:** open at
`https://github.com/PrimeUpYourLife/1132-Fixer-Windows/issues/new` once
approved.

## Background

1132 Fixer creates a local Windows user account named `user1` with the
password `user1` and adds it to the local **Administrators** group, then
launches Zoom under that account. This account persists between fixes —
re-running the fixer only resets the password and re-asserts admin
membership.

This model was chosen for simplicity (no per-install state, predictable
desktop-shortcut credentials, runs the same way on every machine), but
it creates several real security problems:

1. **Public static password** — `user1` / `user1` is documented in the
   README and is the same on every install. Anyone with brief physical
   or RDP access to a machine with the fixer installed has a known
   local-admin login.
2. **Local admin by default** — the account is added to Administrators
   so Zoom updates can run cleanly. For day-to-day Zoom usage (and even
   for most Zoom updates, which are user-scope on machine-wide installs)
   admin is not actually required.
3. **No cleanup path** — the account stays around, in Administrators,
   indefinitely. There is no built-in way to disable or remove it once
   the user no longer needs the workaround.
4. **Credentials live in source/docs** — the password appears literally
   in README.md, scripts, and code. Any internal log, screenshot, or
   support handoff that includes the README leaks the credential.
5. **DPAPI / Credential Manager not used** — even when a credential
   must persist (one-click relaunch via desktop shortcut), Windows has
   first-class APIs for sealing it to the current machine. We use
   neither.

## Acceptance criteria

A future release must:

- [ ] Generate a per-install random password (≥ 20 chars, mixed) at
      first run and persist it via DPAPI (`ProtectedData`) or the
      Windows Credential Manager (`cmdkey` / `wincred` API), never in
      plain text.
- [ ] Prefer a **standard user** account unless admin membership is
      strictly required. Default to non-admin and surface the trade-off
      to the user with a checkbox.
- [ ] If admin is required only during initial profile materialization,
      **drop the admin membership after the first Zoom launch succeeds**.
- [ ] Provide an in-app **Remove helper account** action that disables
      the account, optionally removes the profile, and revokes the
      stored credential.
- [ ] Display in the app exactly which local account was created or
      modified (current behavior is implicit) and its admin / non-admin
      status.
- [ ] Stop documenting the password in README.md.
- [ ] Stop hard-coding `'user1'` as both username and password in
      [main.js:39-40](../main.js:39).

## Out of scope for this issue

- The actual Zoom 1132 fix mechanism. This issue is about the account
  model, not the repair flow.
- Code-signing of the installer (tracked separately).
- The Telegram-driven cross-org work in `Botify-Network/*` — different
  org, different product.

## Notes for whoever picks this up

- The auto-updater target repo `PrimeUpYourLife/1132-Fixer-Windows-Releases`
  has v5.3.5 as latest; this work would land in **v5.4.x** at the
  earliest because it's a behavioral break for any user with an
  existing `user1` account.
- Migration path for users with existing `user1`: detect the
  legacy-credentials state, prompt for opt-in re-generation, keep
  the existing profile data.
- Electron security checklist:
  https://www.electronjs.org/docs/latest/tutorial/security
