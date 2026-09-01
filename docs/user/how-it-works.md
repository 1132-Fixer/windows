# How 1132 Fixer works

```text
  You (your Windows account)
           |
           v
     1132 Fixer
           |
           v
  helper account (user1)
           |
           v
  Zoom Workplace (already installed)
```

Error 1132 is often tied to a Windows user profile, not to the Zoom installer.
1132 Fixer does not patch Zoom. It resets a **separate** local helper account
named `user1` and starts the Zoom you already installed under that account.

## Five steps

1. **Check.** The app looks at Windows rights, the Zoom install, and whether
   the helper account is already in use.
2. **Confirm.** **Fix now** asks before it deletes the helper account.
3. **Reset.** It signs out leftover helper sessions, removes that helper
   profile, and recreates `user1` as a standard user.
4. **Start Zoom.** It opens Zoom as `user1` and checks that Zoom is using the
   real helper profile, not a temporary one.
5. **Result.** You get a clear success, retry, or details view. A desktop
   shortcut is optional.

Your everyday Windows account and personal Zoom files stay where they are.
Zoom Workplace must already be installed machine-wide. 1132 Fixer does not
download Zoom.

See also [installation](installation.md), [privacy](privacy.md), and the
[helper-account](../security/helper-account.md) security note.
