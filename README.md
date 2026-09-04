<p align="center">
  <img src="assets/social-preview.png" alt="1132 Fixer for Windows — one-click fix for Zoom Error 1132" width="960">
</p>

<h1 align="center">1132 Fixer for Windows</h1>

<p align="center">
  <strong>Independent open-source Windows profile-isolation utility for Zoom Error 1132.</strong><br>
  Recreates a local helper account and starts an existing Zoom Workplace installation using that separate Windows profile.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-39D353"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-3A82F7?logo=windows11&logoColor=white">
  <img alt="Setup and Portable" src="https://img.shields.io/badge/Builds-Setup%20%2B%20Portable-39D353">
  <a href="https://github.com/1132-Fixer/windows/actions/workflows/ci.yml"><img alt="Build status" src="https://github.com/1132-Fixer/windows/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/1132-Fixer/windows/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/1132-Fixer/windows?label=release"></a>
</p>

<p align="center">
  <a href="https://github.com/1132-Fixer/windows/releases/latest"><strong>Download the latest release</strong></a>
  &nbsp;┬╖&nbsp;
  <a href="https://1132-fixer.xyz/"><strong>Website</strong></a>
  &nbsp;┬╖&nbsp;
  <a href="CONTRIBUTING.md"><strong>Contribute</strong></a>
  &nbsp;┬╖&nbsp;
  <a href="SECURITY.md"><strong>Security</strong></a>
</p>

This is the **canonical public source** for the Windows app. Issues, pull requests, CI, and GitHub Releases all live here: [`1132-Fixer/windows`](https://github.com/1132-Fixer/windows).

Companion products in the same organization:

- [macOS](https://github.com/1132-Fixer/macos)
- [Chrome](https://github.com/1132-Fixer/chrome)

---

## What it does

Error 1132 can stay after Zoom is reinstalled. It is often tied to a Windows user profile, not the Zoom installer.

1132 Fixer resets a separate helper account named `user1`, then opens Zoom under that account.

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

When you press **Fix now**, the app:

1. Checks Windows, admin access, and the Zoom install.
2. Stops active `user1` sessions and removes the old helper profile.
3. Recreates `user1` and applies safe session settings.
4. Opens and checks Zoom Workplace as `user1`.
5. Creates or repairs the desktop shortcut.
6. Shows a clear result when the work is done.

Longer user and contributor guides: [docs/README.md](docs/README.md).

## Main features

| Feature | What it gives you |
| --- | --- |
| Automatic checks | Finds blockers before the fix starts. |
| One-click flow | Runs the full fix from one main button. |
| Fix receipt | Shows what worked and what needs attention. |
| Desktop shortcut | Creates or repairs a shortcut that opens Zoom as `user1`. |
| Camera and microphone setup | Applies safe Windows desktop-app consent settings. |
| Support report | Builds a redacted report you can review before sharing. |
| Feedback | Opens bug, rating, and general feedback choices. |
| Two builds | Setup installer or a portable `.exe`. |

## Important safety note

> [!IMPORTANT]
> 1132 Fixer deletes and recreates the local `user1` helper account. Anything stored in that helper profile is removed. It does not delete files or Zoom data from your normal Windows profile. Do not run it while signed in to Windows as `user1`.

The app manages this local account:

```text
Username: user1
Password: random — a fresh one is generated on every fix run
```

- You never need the password. The desktop shortcut signs in for you: the fix stores the password encrypted with Windows DPAPI in `%APPDATA%\1132 Fixer\helper-credential.bin`, next to the shortcut launcher (`launch-zoom-as-user1.ps1`). Only your own Windows account can decrypt it. No plain-text password is written to disk. Shortcuts from older versions keep working and are upgraded on the next fix run.
- `user1` is a **standard user**, not an administrator. If an older version made it an administrator, the next fix run removes those rights.
- Do not use `user1` as your everyday Windows account.
- The app may ask for Windows admin approval.

## Requirements

- Windows 10 or Windows 11, x64
- Administrator access
- The Windows **Secondary Logon** service must be available
- Zoom Workplace installed (machine-wide). The default path is:

  ```text
  C:\Program Files\Zoom\bin\Zoom.exe
  ```

  Other machine-wide install locations are detected automatically.

## Install and use

1. Download the latest [Setup or Portable build](https://github.com/1132-Fixer/windows/releases/latest).
2. Open **1132 Fixer** (Run as administrator if Windows asks).
3. Read the safety note.
4. Press **Fix now**.
5. Approve any Windows prompt.
6. Sign in to Zoom in the new session.
7. Create the desktop shortcut if you want faster access next time.

**v5.6.0** builds check for updates through `https://botify-network.com/downloads/1132-fixer/updates`, which serves the same installer that is published on [this repository's Releases](https://github.com/1132-Fixer/windows/releases/latest). If you installed **v5.5.1 or earlier**, your copy still checks the old download location (`PrimeUpYourLife/1132-Fixer-Windows-Releases`); that location still answers, but it will not offer newer versions. Install the latest release from this repository once to move off it. The update location is fixed when a build is made, so an existing install cannot be pointed somewhere else remotely.

## Privacy

- The fix runs on your PC.
- The app does not send a report unless you press **Submit**.
- Support reports hide common private values such as usernames, profile paths, and SIDs.
- Read any report before you attach it.

## Quick help

Common fixes are in [docs/user/troubleshooting.md](docs/user/troubleshooting.md).

| Problem | Try this |
| --- | --- |
| The app says permission is missing | Close it, then approve the Windows prompt. |
| Zoom is not found | Install Zoom Workplace with the machine-wide installer. |
| **Fix now** stays unavailable | Open **View details** and fix the marked item. |
| Camera or microphone is missing | Set camera and microphone access for desktop apps while signed in as `user1`. |
| SmartScreen warns, or Smart App Control blocks the app | Releases are unsigned. SmartScreen lets you continue; Smart App Control does not, and has no per-app exception. Do not turn it off for this. See [troubleshooting](docs/user/troubleshooting.md) and [code signing](docs/security/code-signing.md). |

## Known limitations

- **Unsigned releases.** No code-signing certificate is configured. Windows SmartScreen shows a warning on first run, and Windows 11 PCs with Smart App Control in enforcement will not open the app at all. See [docs/security/code-signing.md](docs/security/code-signing.md).
- **One helper account.** The fix always rebuilds the `user1` helper account; it does not manage other accounts.

## Docs

- Users: [how it works](docs/user/how-it-works.md) · [install](docs/user/installation.md) · [privacy](docs/user/privacy.md)
- Contributors: [CONTRIBUTING.md](CONTRIBUTING.md) · [architecture](docs/development/architecture.md)
- Security: [SECURITY.md](SECURITY.md) · [threat model](docs/security/threat-model.md)
- Index: [docs/README.md](docs/README.md)

## Open source

The **code is MIT-licensed; the brand is not.**

1132 Fixer for Windows is MIT-licensed. You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the software, provided the copyright notice and permission notice stay with it. See [LICENSE](LICENSE).

The 1132 Fixer name, logo, and icons are **not** covered by the MIT licence. Using the software under MIT does not grant trademark rights. See [TRADEMARKS.md](TRADEMARKS.md) for what a fork may and may not imply, and [NOTICE.md](NOTICE.md) for attribution and third-party notices.

## Develop

```bash
git clone https://github.com/1132-Fixer/windows.git
cd windows
npm ci
npm test
npm start
```

Build (Windows x64):

```bash
npm run build:all
```

Version bump:

```bash
node scripts/bump-version.js patch
npm install --package-lock-only
```

`npm test` runs every `tools/*-smoke.js` check with Node alone. CI additionally builds the installer on a Windows runner and runs `tools/packaged-acceptance.js` against the packaged executable: it launches the real app, proves it leaves **Checking** within the deadline, checks the footer, focus rings, target sizes and scrollbars at 100 %, 125 % and 150 % scaling, confirms only that state's controls are visible, walks **View details** → category → **Back**, exercises the second-instance guard and the **Fix now** journey, and uploads screenshots and a report as the `packaged-acceptance` artifact. That driver needs an elevated Windows session without Smart App Control enforcement.

A `v*` tag reachable from `main` runs `.github/workflows/release.yml`, which builds Setup and Portable artifacts, checksums, and `latest.yml` onto this repository's GitHub Releases.

Secrets belong in GitHub Actions or the feedback service — never in app source or a packaged config. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development/building.md](docs/development/building.md).

## License

- Code and documentation: MIT. Declared in [`package.json`](package.json)
  (`"license": "MIT"`) and reproduced in full in the root [`LICENSE`](LICENSE).
- Distributed installers and portable builds ship
  [`build/license.txt`](build/license.txt). That file is the same MIT text as
  the root `LICENSE`, plus a canonical-source line; it is not a separate
  end-user agreement.
- Product names, logos, icons, and brand artwork are **not** licensed under MIT,
  prospectively from the notice date — see [ASSET-LICENSE.md](ASSET-LICENSE.md) for the
  exact file list and provenance records.

## Independent project

Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.

1132 Fixer is an independent open-source Windows profile-isolation utility that recreates a local helper account and starts an existing Zoom Workplace installation using that separate Windows profile. It works only on the user’s own Windows computer. It does not change the user’s main Windows profile or personal Zoom files, chats, contacts, or Zoom account data. Zoom Workplace must be installed separately. Obtain it from Zoom’s official Download Center. 1132 Fixer does not download, bundle, modify, or redistribute Zoom Workplace.
