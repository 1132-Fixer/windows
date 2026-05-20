# Release checklist — 1132 Fixer v5.3.0

One-page release gate. Every box must be checked (or marked N/A with a reason) before a v5.3.0 tag is pushed to a public release.

Detailed step-by-step is in [QA-CHECKLIST-v5.3.0.md](QA-CHECKLIST-v5.3.0.md). This doc captures the *evidence* a tester produces, not the steps.

---

## 1. Static + packaging gates (developer can run)

These can be checked off from the project root before the manual run.

```powershell
# JS syntax
node --check main.js ; node --check renderer.js ; node --check preload.js

# PS parser on bundled firstrun script
powershell -NoProfile -ExecutionPolicy Bypass -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts/zoom-firstrun-setup.ps1',[ref]$null,[ref]$e); if ($e) { $e } else { 'OK' }"

# Packaging — portable
$env:CSC_LINK=$null; $env:WIN_CSC_LINK=$null; $env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npx electron-builder --win portable --x64 --config.win.signAndEditExecutable=false

# Packaging — NSIS installer (optional but recommended)
npx electron-builder --win nsis     --x64 --config.win.signAndEditExecutable=false

# Hash compare
$src = (Get-FileHash 'scripts\zoom-firstrun-setup.ps1' -Algorithm SHA256).Hash
$pkg = (Get-FileHash 'dist\win-unpacked\resources\zoom-firstrun-setup.ps1' -Algorithm SHA256).Hash
"firstrun src=$src"; "firstrun pkg=$pkg"; "match=$($src -eq $pkg)"

# Forbidden-pattern grep on packaged asar
npx asar extract dist\win-unpacked\resources\app.asar .asar-check
Get-ChildItem -Recurse -File .asar-check |
  Where-Object { $_.FullName -notlike '*node_modules*' } |
  ForEach-Object {
    $c = Get-Content $_.FullName -Raw -EA SilentlyContinue
    if ($c -match 'Policies\\Zoom|WOW6432Node\\Policies|user2|mediaSpec|mediaChoice|Downloads') {
      "HIT: $($_.FullName)"
    }
  }
Remove-Item .asar-check -Recurse -Force
```

| Gate | Pass | Evidence |
|---|---|---|
| `node --check` on all 3 JS files | ☐ | |
| PS parser on `scripts/zoom-firstrun-setup.ps1` | ☐ | |
| `npm run build` (portable) succeeds | ☐ | |
| `npm run build:installer` (NSIS) succeeds | ☐ | |
| Source/packaged firstrun SHA256 match | ☐ | hash=___ |
| `dist/win-unpacked/resources/icon.ico` present | ☐ | |
| Asar grep returns **zero** `HIT:` lines | ☐ | |
| Asar does not contain `legacy/`, `scripts/`, `tools/`, `docs/`, `*.log`, `*.bat`, `*.ps1`, `.qa-*` | ☐ | |

## 2. Manual destructive QA (human tester required)

Detailed steps in [QA-CHECKLIST-v5.3.0.md](QA-CHECKLIST-v5.3.0.md). Each row below corresponds to a section of that checklist.

| Gate | Pass | Notes |
|---|---|---|
| Section 1 — Starting state captured | ☐ | |
| Section 2 — Positive path completes; Zoom launches as user1; Apply Zoom Settings shortcut on user1 desktop; firstrun script hash matches | ☐ | |
| Section 3 — `seclogon` Disabled → preflight blocks, no destructive action | ☐ | |
| Section 4 — Non-elevated → runFix returns `not_elevated`, no destructive action | ☐ | |
| Section 5 — Signed in AS user1 → preflight blocks with `running_as_target`, no destructive action | ☐ | |
| Section 6 — Packaging sanity from the artifact directory | ☐ | |

## 3. Signing / release-grade verification

The local builds above are **QA-grade** (signing disabled). A public release must be signed.

| Gate | Pass | Notes |
|---|---|---|
| `npm run release` succeeds in CI with `CSC_LINK` (or `WIN_CSC_LINK`) + `CSC_KEY_PASSWORD` set, and signature is verifiable | ☐ | |
| `signtool verify /pa /v <release.exe>` returns "Successfully verified" | ☐ | |
| Auto-update wiring: `latest.yml` + `*.blockmap` uploaded to GitHub release per recent CI fixes | ☐ | |

Signing env vars (per `package.json > build.win` and `electron-builder`):

| Var | Required | Purpose |
|---|---|---|
| `CSC_LINK` / `WIN_CSC_LINK` | Yes | Path/URL to .pfx, OR base64 of .pfx |
| `CSC_KEY_PASSWORD` / `WIN_CSC_KEY_PASSWORD` | Yes | .pfx password |
| `GH_TOKEN` | Yes (for `--publish always`) | GitHub release upload token |

## 4. Forbidden-behavior re-confirm (source AND packaged)

Final grep evidence the v5.3.0 artifact still excludes everything required:

| Forbidden pattern | Source-tree match | Packaged-asar match |
|---|---|---|
| `user2` | ☐ none | ☐ none |
| user-selection UI/IPC | ☐ none | ☐ none |
| `mediaSpec` / `mediaChoice` / `mediaLabel` | ☐ none | ☐ none |
| `Downloads` (in copy/staging context) | ☐ none | ☐ none |
| `.gif` / `.jpg` / `.jpeg` / `.mp4` / `.mov` / `.webm` / `.avi` / `.mkv` | ☐ none | ☐ none |
| `Policies\Zoom` / `WOW6432Node\Policies` / `HKLM:\SOFTWARE\Policies` / `HKU.*Policies\Zoom` | ☐ none | ☐ none |
| `legacy/user.bat`, `scripts/Zoom Persistence Toolkit`, `admin-reset.log`, `.qa-*`, `.ps-*` | ☐ not shipped | ☐ not in asar |

---

## Evidence template

Fill this in during/after the manual run. Attach to the release PR or paste into the GitHub release notes.

```
Tested artifact:
  exe path/name:         ____
  size (bytes):          ____
  SHA256:                ____
  signed:                yes / no (CI / local QA)

Test machine:
  Windows edition:       ____
  Windows build:         ____
  Current user:          ____   (must NOT be user1)
  Zoom install path:     C:\Program Files\Zoom\bin\Zoom.exe ?  yes / no
  seclogon status:       ____ / StartType ____
  LanmanServer status:   ____
  user1 starting state:  exists / absent / suffixed
  user1 SID (if known):  ____
  user1 in Admins:       yes / no / n/a

Positive path:
  preflight blockers:    ____ (count)
  preflight warnings:    ____ (codes)
  step 1 logoff:         success / quser unavailable warning
  step 3 ProfileList:    N entries cleaned
  step 4 admin verify:   YES / NO  (method: ____)
  step 5 Zoom owner:     user1 confirmed within ___ s
  step 6 profile source: registry / folder / folder-suffixed
  shortcut on user1 dt:  present  (icon: 1132 Fixer / powershell)
  firstrun hash on dt:   ____  (must match 1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E)
  final status badge:    Done / Done (warnings) / Failed
  warnings list:         [ ____ ]

Forced failures (no destructive action observed in any of these):
  seclogon disabled:     PASS / FAIL — error code surfaced: ____
  not elevated:          PASS / FAIL — error code: ____
  signed in as user1:    PASS / FAIL — error code: ____

Final recommendation:   Ship / Ship with limitations / Do not ship yet
Tester name + date:     ____ / ____
```

---

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Developer (static + package) | | | ☐ |
| Manual tester (destructive flow) | | | ☐ |
| Release approver | | | ☐ |
