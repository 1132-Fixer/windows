# Release audit — 6.3.2

End-to-end framework, design and acceptance audit performed before the 6.3.2
release (PR #194). Evidence is either a command result reproduced here, a CI
run, or the `packaged-acceptance` artifact of the named run. Anything not
measured is labelled **not run** with the reason; nothing below is inferred
from appearance alone.

## 1. Root cause of the startup freeze

| Release | Symptom | Cause | Evidence |
|---|---|---|---|
| 6.3.0 (last release actually published) | stays on **Checking…** | elevation probe ran a PowerShell `Add-Type` compile that could not return in the packaged app, so `startup-status` never replied | PR #193 body; `git log v6.3.0..v6.3.1` |
| 6.3.1 (tag exists, release run 33552908133 succeeded, release later removed) | never reached users; auto-update feed still points at 6.3.0 | — | `gh api repos/1132-Fixer/windows/releases/tags/v6.3.1` → 404 |
| PR #194 as opened (48f3da8) | "Restart as administrator" always reported declined | `Start-Process -LiteralPath` — not a `Start-Process` parameter in Windows PowerShell 5.1 | `powershell -Command "Start-Process -LiteralPath 'x'"` → `A parameter cannot be found that matches parameter name 'LiteralPath'` (this host, 5.1.26100.9168) |
| PR #194 as opened | an approved relaunch could be reported as failed | result read on the child's `exit` event before stdout drained | `runTimed` in `src/main/elevation.js`; regression test `inherited handles do not hold runTimed open past the grace period` |

Correction: `whoami /groups` integrity SID first (synchronous, 2.5 s bound),
bounded PowerShell token query as the only fallback, every child settles once
with `started | declined | timeout | launch-error | failed`, output read on
`close` with a 500 ms grace, whole-line sentinel, validated `SystemRoot`,
`-FilePath`. Worst case before the window: 2.5 s + 5 s.

## 2. Framework trace

| Boundary | Owner | Responsibility | Timeout | Error / cancel behaviour | Tests |
|---|---|---|---|---|---|
| Launch → single instance | `main.js` `singleInstanceReady` | one window; the elevated relaunch retries the lock for 8 s (flag), any other second instance quits | 8 s | second instance exits; first window focused | `packaged-acceptance` `single-instance.*` |
| Elevation probe | `src/main/elevation.js` `snapshot()/isElevated()` | token integrity via `whoami`, PowerShell fallback | 2.5 s + 5 s | doubt → not elevated, never a hang | `elevation-controller-smoke` probe outcomes |
| UAC decision / relaunch | `elevation.relaunchElevated` via `main.relaunchElevated` | `Start-Process -FilePath … -Verb RunAs` through System32 `powershell.exe -Command`; no script file | 120 s (prompt) | declined/timeout → window opens with **Administrator access required** and a retry button; started → this instance quits; retry flag prevents loops | controller smoke relaunch outcomes; `elevation-startup-smoke` |
| Window | `main.createWindow` | shown on `ready-to-show`; `unresponsive` handler offers restart | — | `uncaughtException` / `render-process-gone` show a plain dialog and exit | `elevation-startup-smoke` layout checks |
| Preload / IPC | `preload.js`, `src/main/electron-security.js` | `contextIsolation` on, `nodeIntegration` off, channel allowlist, navigation and new-window denied, Explore URL allowlist by id | — | unknown channel rejected | `electron-security-smoke` |
| Renderer start | `renderer.js` `runStartupSequence` | `startup-status` raced against 8 s → **Unable to complete** with **Try again** | 8 s | timeout records the stage under View details | `elevation-startup-smoke` |
| Compact shell | `src/preload/compact-shell.js` | maps panes to `body[data-compact-state]`; footer = version · disclosure · Support · Feedback; Explore hidden | — | — | `compact-shell-smoke`, `packaged-acceptance` footer/explore checks |
| Confirmation | `index.html` `#fixConfirmOverlay` (`role=dialog`, `aria-labelledby`) | one confirmation; Escape = Go back; focus returns to Fix now | — | — | `packaged-acceptance` `fix.confirm-*` |
| Repair orchestrator | `main.js` `run-fix` | refuse as helper → stop helper Zoom → remove account/profile → recreate → configure → launch → verify | per child (PowerShell 20 s probes, tree kill) | cooperative cancel at checkpoints; second run repairs a partial run | `fix-now-orchestrator-smoke`, `fix-cancel-smoke`, `profile-safety-smoke`, `packaged-acceptance` `fix.*` |
| Zoom launch / verify | `main.js` launcher + verify | `Open Zoom` only after verified success | bounded | verification failure → **Unable** | `run-verdict-smoke`, `packaged-acceptance` `fix.open-zoom-*` |

Unbounded children found and fixed in this release: `net user` (helper
account check, now 15 s + tree kill), shortcut creation (`WScript.Shell`,
now 30 s + tree kill). Every other `spawn` in `main.js` already carried a
kill timer (`runPSCapture`, `runPSScript`, launcher) or is user-driven
(`msiexec` for a chosen installer).

Electron security, unchanged and re-verified by `electron-security-smoke`:
`contextIsolation: true`, `nodeIntegration: false`, `sandbox` per
`rendererWebPreferences`, CSP `default-src 'self'` with no remote content,
`will-navigate`/`setWindowOpenHandler` denied, IPC allowlist, path validation
for user-chosen installers. Nothing was weakened for the startup fix.

## 3. Design-system compliance

Recorded in `DESIGN-SYNC.md` § "Compact repair panel — token reconciliation".
Summary: background, typography and motion match the pinned design-system
(`7f3ddaf4`); surface, accent, status and border values follow the operator
acceptance spec of 2026-08-23 and diverge from the design-system repository,
whose Windows page says no shipped Windows UI exists yet. The pin is not
advanced. Token authority is now one `:root` block; the compact shell defines
no hex.

## 4. Screen and state inventory

| State | Title / primary action | Verified by |
|---|---|---|
| Checking | "Checking…", no action | `packaged-acceptance` first-paint screenshot |
| Elevation required | "Administrator access required" / Restart as administrator | `elevation-startup-smoke`; packaged run cannot reach it (runner is elevated) — **not run in packaged form** |
| UAC pending / cancelled | button text "Waiting for Windows approval…" then declined explanation under View details | controller smoke (fake runner); **not run in packaged form** (no interactive UAC on a runner) |
| Ready | "Ready to fix Zoom" / Fix now | `packaged-acceptance` landing (when Zoom Workplace is installed on the runner) |
| Blocked | requirement card + View details, Fix now unavailable | `packaged-acceptance` landing (when Zoom is absent) |
| Confirmation | "Before we start" / Continue · Go back | `packaged-acceptance` `fix.confirm-*` |
| Fixing | "Fixing Zoom", step n of 4, Cancel fix | `packaged-acceptance` `fix.starts`, `fix.progress-announced` |
| Cancelling / Cancelled | exit-confirm overlay, cooperative cancel | `fix-cancel-smoke`; **not run in packaged form** |
| Complete | "You're all set" / Open Zoom | `packaged-acceptance` `fix.open-zoom-after-success` |
| Unable | "Unable to complete" / Try again · Close | `elevation-startup-smoke`, `messages-smoke` |
| View details | diagnostics toggle, plain English on the primary surface | `packaged-acceptance` `fix.view-details`, `fix.no-raw-powershell-on-primary-surface` |
| Already running | second instance exits, first window focused | `packaged-acceptance` `single-instance.*` |
| Update available | NSIS only; countdown then restart | `updater-channel-smoke`; **not run** (no newer feed during the run) |

## 5. Defect ledger

| # | Area | State/component | Finding | Severity | Correction | Evidence | Result |
|---|---|---|---|---|---|---|---|
| 1 | Elevation | UAC relaunch | `Start-Process -LiteralPath` is rejected by PowerShell 5.1; every relaunch reported declined | P1 | `-FilePath`; real-PowerShell test | `elevation-controller-smoke` transport section | fixed |
| 2 | Elevation | `runTimed` | result read on `exit` before stdout drained; approved relaunch could read as failed | P1 | read on `close` + 500 ms grace | controller smoke `inherited handles…` | fixed |
| 3 | Elevation | `runTimed` | `/STARTED/` substring match could accept unrelated output | P2 | whole-line sentinel `FIXER_RELAUNCH=STARTED` | controller smoke `unrelated output…` | fixed |
| 4 | Elevation | `systemPowerShell` | `SystemRoot` unvalidated | P2 | `resolveSystemRoot` with fallback and null | controller smoke SystemRoot section | fixed |
| 5 | Repair | `userExists` (`net user`) | no timeout | P2 | 15 s + tree kill | code review; `npm test` | fixed |
| 6 | Shortcut | `create-shortcut` PowerShell | no timeout | P2 | 30 s + tree kill | code review | fixed |
| 7 | Text | `main.js` dialogs, README | em dashes shipped as `ΓÇö` in user-visible strings | P2 | byte fix; recovered from `chore/public-vocabulary-and-encoding` | `grep -c 'ΓÇ'` → 0 | fixed |
| 8 | Design | `index.html` | two `:root` blocks; status tints from a palette that no longer ships | P2 | single block, tints recomputed | `grep -c ':root' index.html` → 1 | fixed |
| 9 | Design | compact shell | hex values duplicated from `index.html` | P3 | aliases onto `var(--…)` | `grep -c '#[0-9a-f]\{6\}' src/preload/compact-shell.js` → 0 | fixed |
| 10 | Docs | troubleshooting | Code Integrity evidence on the user-facing page | P2 | plain row; evidence moved to `code-signing.md` §11 | diff | fixed |
| 11 | Governance | `AGENTS.md` | said design-system is not a submodule while the brand-assets check depends on it | P2 | corrected; required-check policy recovered | `git ls-files -s design-system` → `160000 7f3ddaf4…` | fixed |
| 12 | CodeQL | `main.js` shortcut argument, acceptance table | incomplete sanitization (backslash) | P2 | validate path; escape backslashes | CodeQL on 19d932b | fixed |
| 13 | Design | tokens vs design-system | shipped palette diverges from pinned tokens | P3 | recorded in `DESIGN-SYNC.md`; design-system source update tracked separately | issue linked from PR #194 | deferred (tracked) |
| 14 | Signing | host binary | unsigned; Smart App Control blocks it | P1 (platform) | out of scope by ruling: no certificate, no SignPath | `code-signing.md` §11 | known limitation |

## 6. Acceptance results

Filled from the CI run recorded on PR #194 (artifact `packaged-acceptance`,
`report.md`). Node-only suites: `npm test` exit 0 on the final commit;
`node feedback-proxy/test.js` in CI.

Cases that cannot run on any available host and are therefore **not run**:
UAC cancel / approve on the packaged binary (no interactive UAC on a runner;
the operator PC enforces Smart App Control and cannot start the binary),
installer install/upgrade/uninstall on the operator PC (same reason). The
installer is validated in CI by `scripts/package-inventory.mjs`,
`check-signature-state.mjs` and the release asset validation step.
