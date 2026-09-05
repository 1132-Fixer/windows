# Architecture

1132 Fixer for Windows is a permanent **Electron** app. Do not migrate it to
WinUI, WPF, .NET, Tauri, or another framework.

Privileged Windows work stays in the main process. The renderer never gets
Node, and it never sends raw URLs or shell commands.

## Process map

```text
index.html + renderer.js     UI (untrusted)
        |
        |  preload.js  (contextBridge, allowlisted invoke)
        v
main.js + src/main/*         privileged Windows work
        |
        +-- helper account create/delete
        +-- DPAPI credential seal
        +-- Zoom detect / launch
        +-- updater
        +-- support client
```

## Where to look

| Concern | Location |
| --- | --- |
| App entry, window, fix orchestration | `main.js` |
| Renderer isolation, IPC allowlist, openExternal | `src/main/electron-security.js` |
| Cooperative cancel | `src/main/fix-cancel.js` |
| Config / updater feed constants | `src/main/config.js` |
| Support HTTP client | `src/main/support-client.js` |
| Release checksum manifest (generate + byte-level verify) | `scripts/generate-checksums.mjs` |
| Compact presentation shell (state derivation, cancel, exit confirm, applies the screen gate) | `src/preload/compact-shell.js` |
| Screen action map (which controls each screen may show) | `screen-actions.js` |
| Details view model (plain-English checks, four status words) | `details-view.js` |
| Preload bridge | `preload.js` |
| UI state and actions, Details view controller | `renderer.js`, `index.html` |
| User-visible copy | `messages.js` |
| Helper password + DPAPI | `helper-credential.js` |
| TEMP / suffixed profile guards | `profile-safety.js` |
| Zoom install discovery | `zoom-detect.js` |
| Success / partial / fail verdict | `run-verdict.js` |
| Packaging allowlist | `build/package-allowlist.json` |
| Tests | `tools/*-smoke.js`, `feedback-proxy/test.js` |

Issue #154 described a later physical move into
`src/{main,preload,renderer,shared}`. That move is **not** done here: it would
retarget Electron entry points, packaging globs, and every smoke test in one
cut. This map is the auditor index until a dedicated, reviewed move lands.

## Product identity (do not change casually)

- Product name: **1132 Fixer**
- `appId`: `com.hightexas.1132fixer`
- Framework: Electron
- Header mark: `assets/brand/app-mark.png`
- Helper shortcut icon: `assets/1132-helper-shortcut.ico`
- SignPath: not used
