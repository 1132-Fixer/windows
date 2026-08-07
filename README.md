<p align="center">
  <img src="assets/social-preview.png" alt="1132 Fixer for Windows — One-click fix for Zoom Error 1132" width="960">
</p>

<h1 align="center">1132 Fixer for Windows</h1>

<p align="center">
  <strong>One-click fix for Zoom Error 1132.</strong><br>
  Opens Zoom Workplace with a separate local Windows helper account.
</p>

<p align="center">
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-3A82F7?logo=windows11&amp;logoColor=white">
  <img alt="Setup and Portable" src="https://img.shields.io/badge/Builds-Setup%20%2B%20Portable-39D353">
  <img alt="MIT license" src="https://img.shields.io/badge/License-MIT-8FC2FF">
  <a href="https://github.com/PrimeUpYourLife/1132-Fixer-Windows/actions/workflows/ci.yml"><img alt="Build status" src="https://github.com/PrimeUpYourLife/1132-Fixer-Windows/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest"><strong>Download Latest Release</strong></a>
  &nbsp;•&nbsp;
  <a href="https://1132-fixer.xyz/"><strong>Visit Website</strong></a>
</p>

---

## What it does

Error 1132 can stay after Zoom is reinstalled. It may be tied to a Windows user profile.

1132 Fixer uses a separate helper account named `user1`. It then opens Zoom under that account.

When you press **Fix now**, the app:

1. Checks Windows, admin access, and the Zoom install.
2. Creates or resets the local `user1` helper account.
3. Opens Zoom Workplace as `user1`.
4. Shows a clear result when the work is done.

On later runs, the app keeps the `user1` profile. This lets the Zoom sign-in stay in place.

## Main features

| Feature | What it gives you |
|---|---|
| ✅ Automatic checks | Finds blockers before the fix starts. |
| 🖱️ One-click flow | Runs the full fix from one main button. |
| 🧾 Fix receipt | Shows what worked and what needs attention. |
| 🔗 Desktop shortcut | Opens Zoom as `user1` without reopening the fixer. |
| 🎥 Camera and microphone setup | Applies safe Windows desktop-app consent settings. |
| 📋 Support report | Builds a redacted report you can review before sharing. |
| 💬 Feedback & Report | Opens bug, rating, and general feedback choices. |
| 🌐 Visit Website | Opens [1132-fixer.xyz](https://1132-fixer.xyz/). |
| 📦 Two builds | Choose Setup or Portable. |

## Important safety note

The app manages this local account:

```text
Username: user1
Password: user1
```

- Do not use `user1` as your normal Windows account.
- Do not run the fixer while signed in to Windows as `user1`.
- The app may ask for Windows admin approval.
- Your normal files, chats, contacts, and Zoom account data stay unchanged.

## Requirements

- Windows 10 or Windows 11
- Administrator access
- Zoom Workplace installed at:

  ```text
  C:\Program Files\Zoom\bin\Zoom.exe
  ```

## Install and use

1. Download the latest [Setup or Portable build](https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest).
2. Open **1132 Fixer**.
3. Read the safety note.
4. Press **Fix now**.
5. Approve any Windows prompt.
6. Sign in to Zoom in the new session.
7. Create the desktop shortcut if you want faster access next time.

## Privacy and support

- The fix runs on your PC.
- The app does not send a report unless you press **Submit**.
- Support reports hide common private values such as usernames, profile paths, and SIDs.
- Read the report before you attach it.

The current feedback service sends accepted items to a private project issue tracker. A new Discord staff view, verified live rating, and **My Messages** inbox are being built. They are not live in the current app yet.

## Quick help

| Problem | Try this |
|---|---|
| The app says admin access is missing | Close it, then choose **Run as administrator**. |
| Zoom is not found | Install Zoom Workplace in the default folder. |
| The fix button stays disabled | Read the check rows and fix the item marked in red. |
| Security software blocks the fix | Allow the app to create the local helper account and start Zoom. |
| Camera or microphone is missing | Check Windows privacy settings, the hardware shutter, the camera driver, and any antivirus webcam shield. |
| A support report is too long | The app trims it and shows a clear notice. |

<details>
<summary><strong>Camera and microphone details</strong></summary>

Open Windows as `user1`, then go to:

```text
Settings → Privacy & security → Camera
```

Turn on **Camera access** and **Let desktop apps access your camera**. Check the matching microphone page too.

If the controls are already on, check:

- the laptop camera shutter;
- a camera function key;
- antivirus webcam protection;
- Device Manager for a driver warning;
- an organization or MDM policy.

</details>

<details>
<summary><strong>For developers and release managers</strong></summary>

### Run checks

```bash
npm ci
npm test
```

### Change the version

```bash
node scripts/bump-version.js patch
npm install --package-lock-only
```

### Publish a release

Push a `v*` tag. `.github/workflows/release.yml` builds Setup and Portable files, makes checksums, and publishes to `PrimeUpYourLife/1132-Fixer-Windows-Releases`.

Keep these names in the right place:

| Name | Where it belongs |
|---|---|
| `RELEASES_PAT` | GitHub Actions secret |
| `FEEDBACK_PROXY_URL` | GitHub Actions variable |
| `GH_ISSUES_TOKEN` | Railway service only |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Optional signing secrets |

Never place a token in app code or a packaged config file. Public `.exe` files can be unpacked and read.

The old `1132-Fixer-Windows-Releases` repo must stay online until existing app updates and download links have moved safely.

</details>

## Independent project

1132 Fixer is not made by or linked to Zoom Video Communications, Inc.

## License

[MIT](LICENSE)
