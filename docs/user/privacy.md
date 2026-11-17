# Privacy

1132 Fixer runs on your PC.

- The repair does not upload your Zoom account, chats, contacts, or personal
  files.
- The app sends nothing to the support service unless you press **Submit** in
  a Feedback form.
- A message that you send carries your words, the app version and the word
  `windows` (the product name). It carries a screenshot only if you attach
  one.
- The Support Report is sent only if you select **Include Support Report** in
  the Bug Report form. Select **Remove Support Report** to change your mind
  before you send. The report goes as a separate attachment, not inside your
  message.
- Support reports hide common private values such as usernames, profile paths,
  and SIDs. Select **preview Support Report** and read the report before you
  include it.
- The helper password is random each fix run. It is stored only as a Windows
  DPAPI blob under **your** `%APPDATA%\1132 Fixer\helper-credential.bin`. Only
  your Windows account can decrypt it. It is not written in plaintext.

The helper account `user1` is a **local** standard user. Anything stored in
that helper profile is removed when you press **Fix now**. Your main Windows
profile is not that profile.

Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.
