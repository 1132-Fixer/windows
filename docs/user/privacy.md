# Privacy

1132 Fixer runs on your PC.

- The repair does not upload your Zoom account, chats, contacts, or personal
  files.
- The app does not send a support report unless you press **Submit**.
- Support reports hide common private values such as usernames, profile paths,
  and SIDs. Read any report before you attach it.
- The helper password is random each fix run. It is stored only as a Windows
  DPAPI blob under **your** `%APPDATA%\1132 Fixer\helper-credential.bin`. Only
  your Windows account can decrypt it. It is not written in plaintext.

The helper account `user1` is a **local** standard user. Anything stored in
that helper profile is removed when you press **Fix now**. Your main Windows
profile is not that profile.

Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.
