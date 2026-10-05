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
| Windows system-tool resolution and tool-check result validation | `src/main/windows-tools.js` |
| Cooperative cancel | `src/main/fix-cancel.js` |
| Update lifecycle: state machine, verification, install handoff, relaunch validation, retry policy | `src/main/updater.js` |
| Sanitized updater log (`%APPDATA%\1132-fixer\logs\updater.log`) | `src/main/updater-log.js` |
| Shutdown reasons (`user_exit`, `inactive_exit`, `update_restart`, …) | `src/main/shutdown.js` |
| Inactivity warning and automatic exit (authoritative main-process timer, monotonic clock) | `src/main/inactivity.js` |
| Critical-operation registry (what suspends the inactivity exit) | `src/main/critical-ops.js` |
| Silent-update relaunch (`--fixer-relaunch`) | `build/installer.nsh` |
| Release metadata finalizer (strips `isAdminRightsRequired`, verifies `latest.yml`) | `scripts/finalize-update-metadata.mjs` |
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
| Tests | `tools/*-smoke.js` |

Issue #154 described a later physical move into
`src/{main,preload,renderer,shared}`. That move is **not** done here: it would
retarget Electron entry points, packaging globs, and every smoke test in one
cut. This map is the auditor index until a dedicated, reviewed move lands.

## Windows repair process boundary

`src/main/windows-tools.js` owns the allowlisted Windows executable names
and absolute system-folder candidates. The Node resolver accepts validated,
drive-absolute `SystemRoot` and `windir` roots, then the standard Windows
root as a fallback. The shipped app is x64; the resolver also handles
`Sysnative` for a 32-bit process on 64-bit Windows. It never searches the
working folder or PATH for a privileged repair executable. PowerShell repair
scripts resolve native tools through Windows' system directory and
`$PSHOME`; they use the same tool allowlist.

PowerShell starts from its resolved absolute path. Its fixed command-line
bootstrap reads UTF-8 script source from standard input and creates the
script block in memory. Node closes standard input after sending the prepared
script. Dynamic script source and helper passwords are absent from PowerShell
arguments and temporary script files. The existing native `net.exe` account
creation receives the password in its own arguments. Terminating-error output is generic;
it must not echo source or secrets into diagnostics.

Preflight accepts a tool inventory only after the process completes with
exit code zero, without timeout or launch failure, and returns a complete
boolean inventory. Empty output, malformed JSON, missing or mistyped fields,
nonzero exit and timeout produce one check-failure blocker. Valid JSON cannot
override failed process status. A successful inventory with absent required
tools produces one missing-tool blocker. Optional tools remain optional;
they do not cause a required-tool failure.

Secondary Logon is a separate service check. A nonrunning service must be
started and verified before repair can continue. A failed or timed-out start
attempt cannot pass on the strength of its output alone. Tool-check failures
also block account/profile mutation; startup scanning is not proof that a
later repair check succeeded.

### 6.4.0 incident diagnosis

The old preflight parsed empty output as `{}`, converted absent fields into
seven missing-tool blockers, and blamed PATH. It also accepted a complete
JSON inventory even when PowerShell exited unsuccessfully or timed out. Those
source defects are reproducible with controlled process results and explain
how one failed check became a wall of false missing-tool messages in both
Setup and Portable builds, which share the same repair code.

The reported affected Windows session has no accompanying process log.
Its exact PowerShell failure, security policy or local environment trigger
is unproven. The repair corrects the process and inventory contracts rather
than treating the misleading PATH message as evidence of a broken PATH.

## Product identity (do not change casually)

- Product name: **1132 Fixer**
- `appId`: `com.hightexas.1132fixer`
- Framework: Electron
- Header mark: `assets/brand/app-mark.png`
- Helper shortcut icon: `assets/1132-helper-shortcut.ico`
- SignPath: not used
