# Electron trust boundary

1132 Fixer is an elevated Electron app. The renderer is untrusted relative to
the main process: a bug in the UI must not become arbitrary command execution,
an arbitrary `openExternal`, or an arbitrary updater feed.

The controls live in [`src/main/electron-security.js`](../../src/main/electron-security.js)
and are wired from [`main.js`](../../main.js). They are proven by
[`tools/electron-security-smoke.js`](../../tools/electron-security-smoke.js).

This document is the runtime trust boundary. Signing of the shipped installer
is a separate link — see [`code-signing.md`](code-signing.md). The two must not
be conflated: a locked-down renderer does not prove origin, and a signature
does not prove the IPC surface is small.

## Isolation

`BrowserWindow` is created with `rendererWebPreferences()`:

| Flag | Value |
| --- | --- |
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `nodeIntegration` | `false` |
| `nodeIntegrationInWorker` | `false` |
| `nodeIntegrationInSubFrames` | `false` |
| `webSecurity` | `true` |
| `allowRunningInsecureContent` | `false` |
| `webviewTag` | `false` |
| `navigateOnDragAndDrop` | `false` |

Preload is [`preload.js`](../../preload.js) only. It exposes `window.electronAPI`
through `contextBridge` and has no Node beyond `require('electron')`.

`index.html` ships a CSP that allows `'self'` scripts and styles, `data:`
images for the screenshot preview, and nothing else. `object-src`, `frame-src`,
and `form-action` are `'none'`.

After the window is created, `hardenWebContents()`:

- denies `window.open` (`setWindowOpenHandler` → `deny`)
- prevents navigation that is not `file:` `index.html` under the app path
- prevents `<webview>` attach
- denies permission requests (media, openExternal, etc.)

## IPC allowlist

Every `ipcMain.handle` channel is listed in `IPC_INVOKE_CHANNELS`. Installing
the allowlist wraps `ipcMain.handle` so that:

- registering a channel that is not on the list throws
- invoke arguments are schema-checked; extra arguments are dropped and never
  forwarded to the handler
- `submit-feedback` accepts only the three catalog types, a bounded string,
  and an optional image screenshot (PNG/JPEG/WebP/GIF, 5 MB)
- `support-report` accepts a plain context object with a bounded log tail and
  a receipt of primitive values

Main → renderer send channels (`fix-log`, `update-status`, `zoom-installer-done`)
are documented in `IPC_SEND_CHANNELS`. They are not invoke targets.

`products-page-available` and `open-products-page` (the Complete screen's
**Explore Our Products**) take no arguments: the destination is
`PRODUCTS_URL` in `src/main/config.js`, checked by
`productsPageAvailability()` against the same https allowlist and opened only
through `openExternalSafe()`. An unlisted or missing destination hides the
section rather than showing a dead control.

The renderer cannot spawn a process, choose an updater URL, or pass a
filesystem path into `msiexec`. The Zoom installer path comes from the native
file dialog and is re-validated in the main process.

## External URLs

`openExternal` is only called through `openExternalSafe()`, which requires
`https:` with no userinfo, on:

- `github.com/1132-Fixer/windows/...` (releases page)
- `1132-fixer.xyz` / `www.1132-fixer.xyz`
- `botify-network.com` / `www.botify-network.com` (Explore destinations)
- `gif.directory` / `www.gif.directory` (Explore destination)
- `zoom.us` / `www.zoom.us` (the catalog admin download)

Anything else, including `http:`, `file:`, `javascript:`, a GitHub repo that
is not this one, or a suffix host (`github.com.evil.example`), is refused.

The footer's Explore modal never sends a URL over IPC at all: the renderer
sends one of the fixed destination keys in `EXPLORE_DESTINATIONS`
(`open-explore-destination` schema rejects everything else), the main
process maps the key to its hard-coded URL, and that URL still has to pass
`openExternalSafe()`. A renderer compromise cannot open an arbitrary page —
not even a different path on an approved host.

## Updater feed

The portable notice fetches `LATEST_YML_URL`, hardcoded to this repository's
`latest.yml`. `httpsGetText` refuses the first URL and every redirect that
fails `isAllowedUpdaterUrl()`:

- `github.com/1132-Fixer/windows/...`
- `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `github-releases.githubusercontent.com`

`autoUpdater.setFeedURL` is never called. electron-updater reads
`build.publish` from `package.json` — on `main` that is the GitHub provider,
owner `1132-Fixer`, repo `windows`. The renderer has no API that can change
that. Note that the value is fixed at build time: the shipped v5.6.0 binaries
were built at a tag whose `build.publish` is the generic `botify-network.com`
broker, so they poll the broker, not this repository.

Live channel, residual old-channel clients, and the version-match test are
recorded in [`../development/updater-channel.md`](../development/updater-channel.md).
`PrimeUpYourLife/1132-Fixer-Windows-Releases` is still serving v5.5.1
`latest.yml` and must not be deleted; if retired, archive it.

`verifyUpdateCodeSignature` stays `false` until a release is actually signed.
Enabling it while artifacts are unsigned permanently breaks the update
channel — see [`code-signing.md`](code-signing.md) §4 and
`scripts/check-signature-state.mjs`.

## Paths and PowerShell

A user-selected MSI is resolved, must end in `.msi`, must not contain control
characters or an NTFS ADS in the basename, and is single-quote-escaped before
interpolation into a PowerShell literal. The helper-account password is not
part of this module: it is minted per run in `helper-credential.js` and must
not appear on `net.exe` argv (see the TEMP-profile safety work).

## Shutdown

`before-quit` kills the tracked child-process tree. Fatal paths already did
this; a normal quit now does too, so a PowerShell child cannot outlive the
window and keep mutating accounts after the UI is gone.
