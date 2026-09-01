# Threat model

1132 Fixer is a local, elevated Windows utility. The trusted computing base is
the user's PC plus this repository's published artifacts. There is no 1132
Fixer cloud that receives Zoom credentials.

## Trust boundaries

| Boundary | Inside | Outside |
| --- | --- | --- |
| Main process | `main.js`, `src/main/*`, allowlisted IPC | Renderer HTML/JS |
| Helper account | local `user1` profile | The signed-in user's profile |
| Zoom | already-installed Zoom Workplace | This app's package |
| Updater | GitHub Releases for this repo, plus documented legacy feeds | Arbitrary HTTPS hosts |
| Support | user-submitted, redacted reports | Automatic telemetry |

The renderer is untrusted relative to main. See [electron-trust.md](electron-trust.md).

## Does

- Create, reset, and delete the local helper account `user1`
- Write local app state and a DPAPI-sealed helper credential under the
  signed-in user's `%APPDATA%`
- Start Zoom Workplace as `user1` through Secondary Logon
- Apply local camera/microphone desktop-app consent for that helper
- Ask Windows for administrator approval for those steps

## Does not

- Upload credentials, Zoom chats, contacts, or personal files
- Make the helper account an administrator
- Store the helper password in plaintext
- Modify the user's main Windows profile or personal Zoom data
- Download, bundle, modify, or redistribute Zoom Workplace
- Change device identity, bypass Zoom authentication, or alter Zoom itself
- Use SignPath or any other signing service in the current pipeline

Current installers are **unsigned**. That is documented in
[code-signing.md](code-signing.md), not hidden.

Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.
