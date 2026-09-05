# Updater channel and install handoff — 1132 Fixer for Windows

`main` publishes to **this repository's GitHub Releases**. Version truth is
`package.json`. This document is the live channel record plus the install
handoff contract; it is not a release.

## Feed

| | |
| --- | --- |
| Source of version truth | `package.json` `version` |
| Publish target | `build.publish` → GitHub `1132-Fixer` / `windows` |
| Clients on this feed | every install from **v6.1.0** on |
| Feed URL | `https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml` |
| Integrity | SHA-512 and size of the Setup installer, inside `latest.yml`; re-hashed by the client before install |
| Transport | HTTPS only. The portable notice walks redirects through `isAllowedUpdaterUrl` (#156) |
| Renderer steering | none — `autoUpdater.setFeedURL` is never called |
| Code-signature check | `verifyUpdateCodeSignature` stays **false** while artifacts are unsigned |
| Channel | derived from the running version: a prerelease tag (`6.4.0-beta.1`) is the beta channel, anything else is stable. A stable client refuses a prerelease `latest.yml`. |
| Architecture | x64 only. The client refuses an artifact whose name carries another arch suffix and a `latest.yml` that lists no x64 installer. |

NSIS installs use `electron-updater` for the check and download only.
Portable builds cannot self-update; they fetch the same `latest.yml` and show
a download banner.

Proof: `tools/updater-channel-smoke.js` (wired into `npm test`) fetches the
live feed through the allowlist and asserts `latest.yml` `version` equals
`package.json` (or lags it by exactly one pending release).

## Install handoff (September 2026 repair)

### What broke

Releases **6.3.1 – 6.3.3** could download an update and then close without
installing it. Manual reopen started the old version, and every later start
armed the same restart again.

- electron-builder writes `isAdminRightsRequired: true` into `latest.yml` for
  every per-machine one-click installer.
- electron-updater's `quitAndInstall()` honours that flag by starting the
  installer through `resources/elevate.exe`.
- This package deletes that unsigned helper at pack time (Smart App Control
  policy, [`../security/BINARY-POLICY.md`](../security/BINARY-POLICY.md)),
  so the spawn failed with `ENOENT`. electron-updater reports that failure
  asynchronously, *after* it has already scheduled `app.quit()`. The app
  exited; the installer never started; the downloaded file stayed in
  `%LOCALAPPDATA%\1132-fixer-updater\pending`.
- `build/installer.nsh` also ran `taskkill /F /IM "1132 Fixer.exe" /T` in
  `customInit`. During a silent update the installer is a descendant of the
  still-exiting app, so `/T` could kill the installer itself.
- The relaunch after a silent install went through electron-builder's
  `--force-run` → `ExecShellAsUser`, which de-elevates. The app manifest
  requires administrator, so the relaunch produced a second approval prompt
  and could run under a different account than the one that updated.

### What the client does now (`src/main/updater.js`)

One state machine, registered once, observable in the UI and in the log:

```text
idle → checking → available → (user: Download update) downloading → verifying → ready
     → installing → restarting → (new process) updated
any step → failed;  a failed or unverified handoff at start → recovery
```

| User-visible state | Controller state | Banner |
| --- | --- | --- |
| Checking for updates | `checking` (30 s timeout) | quiet strip |
| Application is current | `idle` | none |
| Update available | `available` | *Update available* — Download update / Not now |
| Downloading update | `downloading` | real progress, no actions |
| Ready to install | `ready` | *Ready to restart* — Restart now / Later |
| Installing and restarting | `installing`, `restarting` | blocking notice |
| Update check unavailable | `failed` (stage `check`/`metadata`) | *Couldn’t check for updates* — Retry / Dismiss / Check the download page |
| Update download failed | `failed` (stage `download`/`verify`) | *The update didn’t finish downloading* — Retry / Dismiss |
| Update installation failed | `failed` (later stages), `recovery` | *The update could not be installed* — Retry / Continue with current version / View diagnostic details |

Failure reasons recorded in the log and diagnostics: `offline`, `timeout`,
`service-unavailable`, `invalid-response`, `no-compatible-asset`,
`integrity-failed`, `download-failed`, plus the metadata / install /
relaunch reasons below. The banner never shows them; a failed check never
offers a download. **Dismiss** on a failed check hides it for the session
(automatic re-checks that fail stay quiet until the next launch or a manual
retry).

1. **Check** — refused while a fix runs, while another check or a download
   is in flight, and inside the backoff window after a failed handoff.
2. **Metadata** — version must parse and be newer; channel must match;
   the installer name must be `1132-Fixer-Setup-<version>[-<arch>].exe`
   for the running arch; a SHA-512 must be present.
3. **Download** — only when the user chooses *Download update*
   (`autoDownload` is off); full file (no blockmap); one attempt per
   available version.
4. **Verify** — the downloaded file's name, size and SHA-512 are re-checked
   against the metadata before it is called *ready*.
5. **Ready** — 10 s visible countdown when the app is idle; deferred (no
   countdown) while a fix runs or after a previous handoff attempt failed.
6. **Install** — exactly once per process. Refused unless the build is the
   installed one (not portable, not development), the process is elevated,
   the file is byte-identical to what was verified, and the registry's
   `InstallLocation` is the directory this executable runs from. A handoff
   record is written, then the installer is started **directly** (the app
   already runs elevated):

   ```text
   "<pending>\1132-Fixer-Setup-<v>.exe" --updated /S --fixer-relaunch /D=<install dir>
   ```

   `--updated /S` is the same silent-update invocation electron-updater
   uses; `/D=` pins the install directory (unquoted, spaces allowed, always
   last — `windowsVerbatimArguments` keeps it that way); `--fixer-relaunch`
   asks `build/installer.nsh` to relaunch. Only after Windows confirms the
   installer process started does the app quit, with shutdown reason
   `update_restart`.
7. **Relaunch** — `customInstall` in `build/installer.nsh` runs
   `"$INSTDIR\1132 Fixer.exe" --updated --fixer-relaunch` from the elevated
   installer: same account, same interactive session, no second prompt.
   Electron-builder's own run-after-finish is untouched for interactive
   installs and for installers started by older clients (`--force-run`).
8. **Validate** — the new process reads the handoff record. Version equals
   the target and the executable is the one inside the recorded install
   directory → `updated`, shown as *1132 Fixer was updated*. The record is
   removed only when the renderer reports the app is ready. Any other
   outcome (previous version running, unexpected path, installer never
   confirmed) → `recovery`, shown as *The update could not be completed*
   with **Retry update**, **Continue with current version** and **View
   diagnostic details**.

A deferred update installs silently when the user exits (no relaunch);
`autoInstallOnAppQuit` is not used.

### Retry policy

Per target version, persisted in `<userData>\update-state.json`:

| attempts so far | automatic countdown | Restart now / Retry | automatic re-check |
| --- | --- | --- | --- |
| 0, 1 | yes | yes | immediately / after 15 min |
| 2, 3 | no | yes | after 1 h / 4 h |
| 4 | no | no — **Download update** (manual fallback) | after 4 h |

Handoff records older than seven days are discarded.

### Files

| Path | Purpose |
| --- | --- |
| `%APPDATA%\1132-fixer\update-handoff.json` | current version, target version, executable path, install directory, channel, artifact name/size/SHA-512, timestamp, state, attempt. No credentials. |
| `%APPDATA%\1132-fixer\update-state.json` | attempts and last outcome per target version (retry policy) |
| `%APPDATA%\1132-fixer\logs\updater.log` | JSON lines, sanitized (no URL query strings, tokens, home directory or user name); rotated at 512 KB |
| `%LOCALAPPDATA%\1132-fixer-updater\pending\` | electron-updater's download cache |

`%APPDATA%\1132-fixer` is kept across updates (`--updated`) and uninstalls
(`deleteAppDataOnUninstall: false`), so the log of a failed relaunch is still
there afterwards. **View diagnostic details** and the support report both
read it.

### Release metadata

`scripts/finalize-update-metadata.mjs` runs after every build (`ci.yml`,
`release.yml`). It removes `isAdminRightsRequired` from `dist/latest.yml`
and fails the build if the version, installer name, size or SHA-512 in that
file do not match the bytes in `dist/` (and the tag, at release time).
Without the flag, the shipped **6.3.1 – 6.3.3** clients start the installer
directly — they run elevated — and can update to the first release that
carries this change; their relaunch goes through electron-builder's
`--force-run`, so Windows asks for approval once more on that one update.
`scripts/validate-release-assets.mjs` then re-reads the *published*
`latest.yml`, confirms the flag is absent, the version equals the tag, and
the uploaded installer hashes to the recorded SHA-512 at the recorded size.

### Tests

- `tools/updater-lifecycle-smoke.js` — the controller with fakes: 25 lifecycle
  cases (no update, metadata, checksum, arch, ready, handoff exactly once,
  duplicate events, installer failure, relaunch verified / wrong version /
  wrong path, elevation, interrupted install, recovery, loop prevention,
  spaced paths, per-user location, settings intact) plus install-on-exit,
  shutdown reasons and the log sanitizer.
- `tools/updater-handoff-smoke.js` — static wiring (main, preload,
  allowlist, renderer, `installer.nsh`, workflows) and a fixture run of the
  metadata finalizer.
- `tools/packaged-update-acceptance.js` — the real thing: installs version A
  with the real installer, serves version B through electron-updater's
  provider, and proves B relaunches from the installed path. Needs an
  elevated Windows session; see the script header.

## Broker channel (v5.6.0 clients)

`build.publish` at tag **`v5.6.0`** is the **generic** provider
`https://botify-network.com/downloads/1132-fixer/updates`. Every v5.6.0
install polls the broker, which serves the same installer this repository
publishes.

`tools/updater-channel-smoke.js` fetches the broker directly (outside the
app's allowlist, which is deliberate — the *app* must not poll it) and fails
if the broker is unreachable, or if its `version`, `sha512`, `path` or `size`
diverge from the channel `main` publishes to.

## Residual old channel — deletion blocked

`PrimeUpYourLife/1132-Fixer-Windows-Releases` is **not** deleted. v5.5.1 and
earlier clients still poll its `latest.yml`; the pinned transition release
there is v6.0.0. **Read its counts through the REST release object, never by
GETting the asset** — an asset GET increments the `download_count` that the
retirement decision reads.

`isAllowedUpdaterUrl` **rejects** the old GitHub path, the generic
`botify-network.com/downloads/1132-fixer` broker, `http:`, other repos, and
arbitrary hosts. Residual clients keep working only because their *already
installed* binary has the old URL baked in.

**Archive over delete.** If that repository is ever retired, archive it so
legacy updater checks keep resolving instead of 404ing. See
[`../history/release-migration-2026-08.md`](../history/release-migration-2026-08.md).

## Related

- [`release-process.md`](release-process.md) — how a `v*` tag publishes `latest.yml`
- [`../security/electron-trust.md`](../security/electron-trust.md) — URL allowlist, IPC surface
- [`../security/code-signing.md`](../security/code-signing.md) — unsigned policy / updater trap
- [`../security/BINARY-POLICY.md`](../security/BINARY-POLICY.md) — why `elevate.exe` is not shipped
- [`../user/troubleshooting.md`](../user/troubleshooting.md) — what a user sees when an update fails
