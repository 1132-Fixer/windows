# Changelog

All notable changes to 1132 Fixer (Windows) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `design-system` submodule pinned to `133fd766b1f53f34c63de1941e9aedeefde48516` (design-system PR #4): the design system now records the shipped Windows palette, radii, spacing and window sizes as a platform overlay (`tokens/windows.json`, `docs/platforms/windows.md`), so the `DESIGN-SYNC.md` token table lists recorded values instead of divergences. Closes #196. No app tokens changed. `tools/design-sync-pin-smoke.js` (in `npm test`) fails when the gitlink, `AGENTS.md` and `DESIGN-SYNC.md` cite different pins, or when the app's `:root` colours drift from the pinned `tokens/windows.json`; CI now checks out submodules so that runs from a clean clone.

### Fixed

- `checksums-sha256.txt` on GitHub Releases was written with CRLF line endings (PowerShell `Out-File`), so `sha256sum -c checksums-sha256.txt` reported "No such file or directory" for every entry — the filename carried a trailing `\r`. Releases 6.3.3 and earlier are affected; verify those with `tr -d '\r' < checksums-sha256.txt | sha256sum -c -`. The manifest is now produced by a repository-owned generator, `scripts/generate-checksums.mjs` (coreutils format, LF, UTF-8 without BOM, sorted, final LF), read back as bytes by its `--verify` mode, and checked with `sha256sum -c` in both `ci.yml` and `release.yml`; `scripts/validate-release-assets.mjs` fails the release if the published file has a BOM, CRLF, a malformed line, or is missing a line for any shipped `.exe`. `tools/release-checksums-smoke.js` is the byte-level regression test with negative controls; `tools/release-identity-smoke.js` pins the workflow wiring.

## [6.3.3] - 2026-09-04

Verified on the packaged build by `tools/packaged-acceptance.js` on the Windows CI runner at `main` `4d48efc` (85 cases passed, 0 failed, 0 not-run: launch, states, only each state's controls visible, the Details round trip, focus rings, target sizes, no scrollbars at 100/125/150 % scaling, second-instance guard, real **Fix now** run). Releases remain unsigned; Smart App Control in enforcement still blocks the app (see `docs/security/code-signing.md` §11).

### Changed — Ready screen composition and the Details view

- **Ready screen** is one centered group: `Ready to fix Zoom`, the two-line explanation, a 240px **Fix now** (the only filled button), the **Create desktop shortcut** checkbox directly beneath it (18px box, body-weight white label, whole label clickable), and **View details** as a tertiary disclosure with a chevron. Content column is capped at 420px; the group sits at the optical center of the space between a fixed 56px header (Back · centered product mark · Exit) and a fixed 48px footer (version + `Independent project. Not affiliated with Zoom.` on the left; Support · Feedback · About grouped on the right). The layout is a header/main/footer flex column — no absolute positioning beyond the centered mark — and fits 520×600, 520×560 and the 440×520 minimum at 100/125/150 % scaling with no scrollbar, overlap or clipped text.
- **View details** now opens a Details view in place of the wizard instead of a bordered, internally scrolling panel. A visible **Back** control (left arrow + "Back") sits in the header; Escape also returns. Back restores the exact prior screen: readiness result, checkbox state and any repair outcome are untouched, and focus returns to **View details**. The overview shows one readiness headline with a pass count and one row per category (App, Zoom, Helper account, Privacy policies, Camera service, plus Repair results after a run); a category opens in the same region with **Back to details**. Every check carries a plain-English label and one of four status words — Checking, Ready, Needs attention, Unable to verify — with a short explanation only when something needs attention. No registry paths, account names, service internals, commands or policy keys appear on that surface (`details-view.js`, guarded by `tools/details-view-smoke.js`). Nothing in the Details view scrolls.
- **Explore** is offered only inside the About dialog (About → Explore). It was a hidden footer control since 6.3.0 — present in the landing markup, hidden by CSS and an attribute — and is no longer part of any wizard state.
- The screen-reader status line (`#statusBadge`) is visually hidden in every tone; the wizard body is the visible status voice.

### Fixed

- **Mixed controls between states.** Two layers owned the same buttons: the renderer's per-outcome `setActions()` table and the compact shell, which reparented View details next to Cancel/Done, moved footer nodes into a shell-built footer, hid Explore with `display:none !important`, and toggled its own Cancel/Done per state with CSS only. A stale flag or a reused slot could show a control from another screen. `screen-actions.js` now holds one explicit allowlist per screen (Checking, Ready, Blocked, Fixing, Cancelling, Cancelled, Complete, Unable, Notice, plus the Details overlay); the shell applies it after every renderer change, hiding anything the screen does not allow and never revealing. Header, footer and action area are static markup; the shell moves no nodes. `tools/screen-actions-smoke.js` asserts the map (Open Zoom only after success, Cancel fix only while running, Copy error details only on Unable, Back only on Details, Explore on no screen) and `tools/ready-screen-capture.js` proves the rendered result per state and viewport.
- Pressing Escape anywhere threw a `ReferenceError` (the handler called a countdown canceller that no longer existed) before it could close a dialog; the dead call is removed.
- **Fix now** lost its keyboard focus ring: the `.btn-primary` box-shadow reset out-ranked the shared `:focus-visible` rule.
- The **Try again** button was announced as "Run the full fix now"; the visible label is now the accessible name.
- Enter no longer triggers **Fix now** while the Details view is open or while focus is on another control.
- `tools/packaged-acceptance.js` read the active pane title with a class name that does not exist (`.wizard-pane`); it now reads `.wiz-pane`, puts the page in keyboard modality before measuring focus rings, checks that only the state's controls are visible, and drives the Details round trip (open, category, Back to details, Back) on the shipped binary.
- `tools/ps-encoding-smoke.js` pins the PowerShell working directory to the temp folder so an unavailable inherited directory cannot fail the encoding checks.

### Removed

- Dead markup and styles: the hidden legacy title bar with Minimize/Maximize/Close, the legacy header and footer, the checklist/receipt/log panel (`#advPanel`, `#checkList`, `#receiptPanel`, `#fileList`) and its rAF-batched DOM log writer (the log buffer that feeds the support report is unchanged), the `.btn-primary.counting` countdown style, and the compact shell's `!important` overrides.

## [6.3.2] - 2026-09-04

Verified on the packaged build by `tools/packaged-acceptance.js` on the Windows CI runner (43 cases passed: launch, leaves Checking within 15 s, no scrollbars at 100/125/150 % scaling, footer, focus rings, target sizes, second-instance guard, confirmation dialog, real **Fix now** run to a truthful end state, View details). Releases remain unsigned; Smart App Control in enforcement still blocks the app (see `docs/security/code-signing.md` §11).

### Fixed

- **Every packaged start since 6.2.0 ended on “Unable to complete” (or stayed on Checking…).** The renderer runs sandboxed, and a sandboxed preload can only `require` Electron’s own modules; `preload.js` required the compact presentation shell from the repository, which threw `module not found`, aborted the whole preload, and left the page without `window.electronAPI`. The shell now loads as a page script from `index.html`; `preload.js` requires only `electron`, and a test fails the build if a repository `require` ever returns there. Found by the new packaged acceptance run on the Windows runner, whose first screenshot showed exactly this screen.
- Startup could stay on **Checking…** forever. The 6.3.0 elevation probe compiled a .NET helper inside PowerShell (`Add-Type`) and, in the packaged app, sometimes never returned. The probe now reads the token integrity level with `whoami /groups` first (synchronous, 2.5 s bound), falls back to the PowerShell token query only when that gives nothing, and every child process in the elevation path settles exactly once with a named outcome (`started`, `declined`, `timeout`, `launch-error`, `failed`). Nothing in startup can wait without a deadline.
- Asking Windows for administrator approval always reported “declined”. The relaunch used `Start-Process -LiteralPath`, which Windows PowerShell 5.1 rejects (`-LiteralPath` is not a `Start-Process` parameter). It is `-FilePath` again, and a test now runs the real System32 PowerShell to prove it.
- A relaunch that Windows had approved could still be reported as failed: the result was read on the child’s `exit` event, before its output had drained. Output is now read through `close`, with a short grace period so an inherited handle cannot hold startup open.
- The relaunch result is a whole-line sentinel, so unrelated PowerShell text can never be mistaken for a successful start.
- `%SystemRoot%` is validated (absolute, exists) with a `C:\Windows` fallback before PowerShell or `whoami` is resolved; a missing Windows directory is a reported launch error, not a crash.
- `net user` (helper-account check) and the shortcut creator now have timeouts and kill their process tree on expiry.
- UAC relaunch no longer writes a temp `.ps1`. Smart App Control treats unknown script files as “part of this app”. The host exe is still unsigned, so SAC in enforcement still refuses to open it until a Trusted Root Program signature exists (publisher High Texas). This release does not change that.
- Garbled em dashes (`ΓÇö`) in dialogs and the README are real em dashes again.

### Changed

- **Fix now** confirmation states that the helper account and helper profile are replaced, personal files are unchanged, Zoom opens in the fresh helper environment, and cancellation is only at safe checkpoints.
- Compact footer shows the exact independence line `Independent project. Not affiliated with Zoom.` with version, Support, and Feedback. Explore stays hidden from landing chrome.
- “Restart as administrator” explains under View details why a restart did not happen (cancelled, not answered in time, PowerShell unavailable), in plain English.

### Added

- `tools/elevation-controller-smoke.js`: every elevation and relaunch outcome under fake and real child runners, quoting of paths with spaces, apostrophes, quotes and non-ASCII text, and the no-temp-file guarantee.
- `tools/packaged-acceptance.js` and a CI step that launches the packaged executable on the Windows runner, proves it leaves Checking within the deadline, checks footer, focus rings, target sizes and scrollbars at 100/125/150 % scaling, exercises the second-instance guard and the Fix now journey, and uploads screenshots and a report as the `packaged-acceptance` artifact.

## [6.3.1] - 2026-09-01

### Fixed

- Packaged app no longer stays on **Checking…**. Elevation is a synchronous `whoami` integrity-SID snapshot (no PowerShell `Add-Type`), and a missed startup IPC shows **Unable to complete** instead of spinning forever.
- Per-machine uninstaller is stamped `requireAdministrator` instead of `asInvoker` + unsigned `elevate.exe` (Smart App Control was blocking that helper as “part of this app”). `elevate.exe` is stripped from the packed tree. The installer no longer auto-launches the app.

## [6.3.0] - 2026-09-01

### Fixed

- Startup no longer stays on **Checking…** with **Admin rights unknown**. Elevation is read from the Windows process token (not `net session`), every startup stage times out, and a declined UAC prompt shows **Administrator access required** with **Restart as administrator**.
- The first window is a compact centered size instead of filling the work area.
- Camera Frame Server is advisory in details. It cannot block **Ready to fix Zoom** or be treated as proof that Zoom is healthy.

### Changed

- After the bounded startup checks, the landing screen is **Ready to fix Zoom** / **Fix now**.
- Production footer is version, Support, and Feedback. Explore and privilege status are not landing chrome.

## [6.2.0] - 2026-09-01

### Fixed

- Support-service snapshot rebuilds take a per-scope advisory lock so two
  concurrent first-ratings cannot undercount the public aggregate or skip
  history prune (`REVIEW#11` / `rating_snapshots are pruned per scope`).

### Changed — public documentation (issue #154)

- Documentation is grouped as a product page (README), a docs index, user
  guides, contributor guides, a security/trust set, and project history.
  Historical files were moved, not deleted. SignPath is still not used.
  Electron source files stay in their current layout; the auditor map is
  [`docs/development/architecture.md`](docs/development/architecture.md).

### Changed

- Initial screen is **Ready to fix Zoom** with **Fix now**. A successful
  preflight no longer claims “Everything looks good” or offers
  “Open Zoom as user1” as the primary action.
- **Fix now** always starts the complete `run-fix` helper-account reset,
  after a short confirmation. It never calls the launch-only handler.
- Compact wizard copy, independence footer, and no-scroll details dialog.
- Header product mark is the canonical 1132 Fixer **gear**
  (`assets/brand/app-mark.png`), window-centered in the top bar. The
  people/arrow artwork stays on the helper-account desktop shortcut only.

### Changed — Explore is a product directory (issue #185)

- **1132 Fixer is the subject of the panel.** It stops being the first cell
  of a grid and becomes the panel's headline: a full-width featured surface
  with a centered logo and title, the largest product name, and one primary
  action (`Visit project`). `Open Source` is a status badge, not a control —
  there is no separate open-source destination, so it must not look like it
  goes somewhere.
- **The independence line moved into the hero.** As a panel footer it read
  as a statement about every product listed, including ones this project
  does not own and cannot speak for. Compact chrome keeps the exact short
  disclosure in the main-window footer and exposes **Explore** as a quiet
  text control next to Support — never as a pill, never beside **Fix now**,
  and never hidden.
- **Destinations are grouped by purpose** — Organizations & Services, Bots,
  Creative Tools. GIF Directory is an organization and discovery utility
  (`Organize and discover GIFs`), not miscellaneous content. The `Other`
  category and the `App page` placeholder descriptions are gone.
- **Prime Hosting added** (<https://primehosting.dev/>), allowlisted as an
  exact host — `*.primehosting.dev` is not reachable. Every other
  destination URL is unchanged, and the security smoke test now pins the
  whole id→URL table so a silent edit fails.
- **Make It GIF and GIF Directory have real logos.** Both previously fell
  back to a generic globe. Together with the Prime Hosting mark these come
  from the artwork supplied on issue #185.
- **The whole panel fits one screen.** At the Explore modal's ~828×630
  logical pixels at 100% scaling, all eight destinations are visible at
  once with no vertical or horizontal scrolling and nothing clipped. On a
  short viewport the hero becomes a compact centered horizontal group — it
  stays the largest, boldest, centered element without consuming half the
  available height. Smaller windows and 125%/150% scaling scroll the panel
  body rather than clipping.

### Fixed

- **Windows installer paths were rejected on non-Windows hosts.**
  `isSafeUserSelectedPath` validates a Windows path but parsed it with the
  ambient `path` module. Under POSIX a backslash is an ordinary filename
  character, so `basename('C:\Users\Public\x.msi')` returned the whole
  string — which contains `:` and `\` and was refused as an illegal
  basename. Every legitimate installer path failed off-Windows, and the
  security test proving this guard works could only pass on Windows, so on
  Linux CI the guard was effectively unverified. Parsing is now pinned to
  `path.win32`, with an explicit absolute-path requirement so `resolve()`
  cannot join a relative input onto the process working directory.
  Behaviour on Windows is unchanged.
- **The Explore hero uses the managed brand export.** It briefly used a
  downscaled copy of `assets/1132-fixer-logo-transparent.png`, which
  packages correctly and then silently drifts the day the design system
  updates the logo. It now uses `assets/logo-transparent.png`, which is
  listed in `.brand-assets.tsv`, and a guard pins that so a derived copy
  cannot be reintroduced.
- Electron 44 no longer ships `libEGL.dll` or `libGLESv2.dll`. Those two
  names were removed from `build/package-allowlist.json` so package
  inventory matches the Electron 44 Windows runtime. Electron 44 itself
  is unchanged.

## [6.1.0] - 2026-08-23

### Changed — repair wizard shell redesign

- **Compact wizard shell.** The oversized hero header is replaced by a
  64px bar with a single window-centered product mark (~44px, the
  canonical 1132 Fixer **gear** from the owner-approved `16.png` master —
  `assets/brand/app-mark.png`) and a right-aligned status indicator; no
  duplicate product-name billboard. The middle is a containerless
  workspace with one shared state layout (state icon → heading →
  description → a single **View details** disclosure → ~448×48 primary
  action → quiet secondary row).
- **The five-step vertical stage rail is the single repair-progress
  model.** During an automatic repair there is no giant disabled
  "Repairing…" button, no second continuous repair progress bar, and no
  redundant "Repairing" pill — the rail alone carries progress:
  completed = success check, active = blue/current with a
  consumer-language detail line nested beneath it, pending =
  subdued/outlined, joined by thin connectors. (The separate app-updater
  download bar is unrelated and still allowed — it represents a different
  operation.) Primary repair copy is consumer language; the helper
  account name and raw log stay behind **View details**.
- **Wizard states:** *Checking* → **Ready to fix Zoom** (**Fix now**) →
  *Fixing Zoom* → **You're all set** with **Open Zoom** and **Done**
  (Open Zoom uses the same launcher artifact as the desktop shortcut via
  the allowlisted `launch-zoom-helper` IPC). Failures offer **Try again**
  and **View details**. Technical information stays behind **View details**,
  never a *View receipt* label. When elevation is missing, **Continue as
  administrator** is shown; after a declined prompt the retry is
  **Restart as administrator**. Manual blockers read *Action required*
  (amber); red is reserved for actual failures. The initial screen does
  not say “Everything looks good” or “Open Zoom as user1”.
- **Footer is quiet utility chrome:** plain version text, **Support**,
  **Feedback**, and the exact independence line
  `Independent project. Not affiliated with Zoom.` Compact repair chrome
  does not put Explore or “Running as administrator” in the normal footer.
- **Design tokens normalized** to the spec palette (SURFACE_1 `#172235`,
  SURFACE_2 `#1D2A3F`, borders `#2B3D57`/`#3B5578`, accent `#337FDB`,
  focus `#71AFFF`; the muddy purple `#2A2530` surface is gone), spacing
  scale 4–64, radii 10/14/18, with pills reserved for status chips.

### Changed — brand / product identity

- The canonical 1132 Fixer product identity is the **gear**, regenerated
  from the owner-approved `16.png` master (2026-08-23). It drives the
  packaged EXE, window/taskbar/Start-menu icon, installer/uninstaller
  icons, the in-app header mark, and the Explore 1132 Fixer card.
  `icon.ico` is a 9-frame ICO (16/20/24/32/40/48/64/128/256).
- The blue+silver **people/arrow** mark is **not** the product icon; it is
  reserved for the Zoom helper-launch shortcut `Zoom — User1.lnk`
  (`assets/1132-helper-shortcut.ico`), which represents launching Zoom as
  the helper identity rather than launching the 1132 Fixer application.
  The separate `Apply Zoom Settings.lnk` (a 1132 Fixer configuration
  action) correctly uses the gear.

### Added — self-elevation

- The app now **restarts itself as Administrator** instead of telling the
  user to right-click. A non-elevated launch attempts one automatic
  elevated relaunch (`Start-Process -Verb RunAs` — the standard Windows
  approval prompt; the app never sees or stores a password), guarded by a
  flag so a declined prompt can never loop. If approval is declined, the
  window opens with a **Restart as administrator** retry button and the
  manual right-click path as fallback. The single-instance lock now lets
  the flagged elevated relaunch retry briefly instead of dying in the
  teardown race with its exiting parent.

### Added — Explore launcher (footer)

- The footer's website button is now **Explore**: a branded modal on the
  same navy system with a featured 1132 Fixer card and a Botify Network
  grid of destination cards (normalized 40×40 logos, generic web-glyph
  fallback for destinations without supplied artwork). Security: the
  renderer sends only a fixed destination **key** over a schema-validated
  channel; the key→URL map is trusted main-process data, so the renderer
  can never supply a URL — not even a different path on an approved host.
  The external allowlist adds `botify-network.com` and `gif.directory`
  (HTTPS only); the old `open-website` IPC is removed. The modal is
  keyboard-accessible (focus trap, Escape/backdrop/Close dismissal, focus
  returns to Explore). A Waiting Room Attendant logo is staged but has no
  destination — no canonical WRA URL exists in the app, so it is
  deliberately not clickable.

### Fixed — desktop shortcut after a 5.x → 6.x upgrade

- **Create Zoom Helper Shortcut no longer dead-ends after an in-place
  upgrade.** Pre-6.0 installs stored the helper sign-in as plaintext inside
  the launcher script; 6.0 looks for the DPAPI-sealed
  `helper-credential.bin`, which those machines never had, so the button
  refused with "No stored helper sign-in was found on this PC" even though
  a working sign-in was on disk. The create-shortcut path now migrates the
  legacy credential in place: it is parsed from the old launcher (exact
  legacy shape and expected helper user only), sealed with DPAPI
  CurrentUser, and the launcher is rewritten in the secret-free format —
  which also removes the plaintext password from disk. If nothing
  migratable exists, the honest "press FIX NOW once" refusal remains. The
  managed shortcut is `Zoom — User1.lnk` (legacy names cleaned; idempotent).

### Known follow-ups

- Cancel-during-repair flow remains future engineering — issue #142.

## [6.0.0] - 2026-08-23

Version rollover to 6.0.0. No application-code change from 5.6.0; this is a
release cut of the current `main` (see the "Unreleased" content below, now
shipped). Application identity, updater channel configuration, and installer
behaviour are unchanged from 5.6.0 — this is an in-place upgrade of the same
application (`appId com.hightexas.1132fixer`), not a new product.

### Security — Electron IPC isolation and updater URL allowlist

- Renderer isolation is now explicit: `contextIsolation`, `sandbox`,
  `webSecurity` on; `nodeIntegration` (including workers/subframes),
  `webviewTag`, and `allowRunningInsecureContent` off. `webContents`
  denies `window.open`, off-app navigation, webviews, and permission
  requests. Shutdown kills tracked child process trees on `before-quit`.
- `ipcMain.handle` is wrapped by an allowlist. Unknown channels cannot be
  registered. Invoke payloads are schema-checked (`submit-feedback`,
  `support-report`); extra arguments on zero-arg channels are dropped.
- `openExternal` and the portable `latest.yml` fetch refuse anything that
  is not https on the named GitHub/CDN/site/Zoom allowlist. Redirects
  cannot leave that list. The renderer still cannot supply those URLs.
- User-selected Zoom MSI paths are resolved and quoted before PowerShell
  interpolation (control characters, NTFS ADS, wrong extension refused).
- Coverage: `tools/electron-security-smoke.js` (isolation flags, IPC
  allowlist rejects, updater URL not arbitrary).

### Fixed — truthful UI state: unknown is never rendered as success

Wrong-data-state audit of the renderer and the main → renderer status path.
Every fix below removes a rendering that claimed more than the data supported.

- **Summary badge no longer reports a repair as "Ready".** `preflight-scan`
  ranks `repairable` above `warning`, so a scan carrying both rolls up as
  `overall: 'repairable'` — and the renderer had no branch for it, falling
  through to the green tick. A detected TEMP or suffixed helper profile is
  exactly a `repairable` card, so the headline badge read green while the
  row below it said TEMP. The summary is now derived from the row statuses
  actually on screen and is never greener than the worst of them.
- **An unrecognised check status no longer draws the success tick.** The
  icon map ended in `default: svgCheck(...)` and the badge word in
  `STATUS_BADGE[status] || ''` — so an unknown state rendered as a green
  check with an empty badge, i.e. state conveyed by colour alone, in the
  wrong colour. `unknown` is now a first-class row state with its own icon,
  word and styling.
- **A check the scan did not return is no longer dropped from the list.**
  The row loop used `if (!card) continue`, which silently shortened the
  checklist so a check that never ran looked identical to one that passed.
  Every row renders every scan; a missing one renders as unknown.
- **Not running as Administrator no longer hides the other eight checks.**
  The elevation gate rendered a single blocked row; the rest vanished. They
  now render as unknown ("needs Administrator rights… not a pass"), and the
  admin row states plainly what needs elevation and that nothing on the
  computer has been changed. An elevation probe that throws is treated as
  not elevated, not as permission to continue.
- **The page no longer ships a green "✓ Ready" badge and a green
  "Administrator" footer badge as static markup.** Both asserted a settled,
  passing state before anything had been measured — and kept asserting it if
  the probe never returned. They ship neutral and are promoted only by a
  measured result.
- **`get-system-info` no longer hardcodes `admin: true`.** The feedback
  dialog printed "Admin: Yes" for every session, including non-elevated
  ones, contradicting the footer badge reading the same probe and misleading
  support triage. It is now measured, with an explicit Unknown rendering.
- **Shortcut creation no longer fails silently, and no longer rewrites the
  fix verdict.** `createShortcut()` had no error handling: an IPC rejection
  from the toolbar button produced an unhandled rejection and nothing at all
  on screen. The same throw raised from the post-fix shortcut step was caught
  by the run handler and repainted an already-successful fix as FIX FAILED.
  The shortcut is now an isolated operation that reports its own outcome.
- **A successful run with no receipt no longer hides the receipt panel.**
  The four receipt results are reported as unknown instead of disappearing
  under a FIX COMPLETE headline.
- **The update banner no longer renders unknown or failed as silence.** An
  unrecognised or malformed `update-status` payload hid the banner, which
  reads as "you are up to date"; the `error` banner auto-hid after 6 seconds,
  so a failed update check erased its own evidence. Both now state that the
  update state could not be confirmed and stay until dismissed.
- **A Zoom installer that never started, or a declined Windows
  administrator prompt, no longer reads as one in progress.**
  `zoom-run-installer` can resolve `{ started: false }` with no message; the
  card changed nothing, leaving the pre-launch notice promising a Windows
  prompt and an automatic re-check. The installer's exit code was also
  discarded, so a declined elevation (1223) or cancelled install (1602) fed
  straight into a silent re-check.
- **A disabled "Fix now" always states a reason.** An empty blocker list hid
  the note entirely, leaving a dead button unexplained. It also now carries
  `aria-describedby` — a disabled button is not focusable, so the `title`
  alone never reached assistive technology.
- Accessibility, scoped to the surfaces above: each checklist row carries an
  accessible name of label + state + detail so it is not understood by icon
  colour; every state has a non-empty badge word; the list reports
  `aria-busy` while scanning; the summary badge (`role="status"`) announces
  every transition.
- New `ui-state.js` holds the pure, DOM-free state → rendering map (same
  browser-script + `module.exports` pattern as `messages.js` and
  `run-verdict.js`). Coverage: `tools/ui-state-smoke.js` — including an
  exhaustive sweep proving that for **every** status string that is not
  exactly `ready`, both the icon and the badge word differ from the ready
  rendering, and that a `repairable` row can never roll up to the green
  summary.

### Fixed — TEMP-profile fallback is no longer a silent success

- After Zoom launches as `user1`, the fix logs the effective `USERPROFILE`,
  `APPDATA`, and `LOCALAPPDATA` and classifies the landing path. A TEMP
  profile (`C:\Users\TEMP*`) or a suffixed profile (`user1.MACHINE`) fails
  the profile-setup step, so the run ends **FIX COMPLETE — NEEDS ATTENTION**
  instead of a green success (unique STEP-6 guard from closed unmerged PR #40,
  rewritten on current `main`; the stale branch was not merged wholesale).
- The environment checklist now inventories the helper profile (account,
  ProfileList image path, folder ownership, TEMP identification). Probe
  failure is a warning, never a clean-ready row. 1132 Fixer still does not
  delete `C:\Users\TEMP*` or ProfileList keys by name guessing — FIX NOW
  rebuilds through the existing account/profile flow.
- The helper-account password is no longer passed as a `net.exe` CreateProcess
  argument (it already rode in a tmp PowerShell file for Zoom launch). Log
  lines are redacted against that secret.
- Coverage: `tools/profile-safety-smoke.js` (TEMP detection, path
  classification, no silent TEMP launch, quoting, env construction, mocked
  Zoom-exe discovery, shortcut name/icon, privilege unknown ≠ success,
  credential presence assertions that never print the secret).

### Added — attach a screenshot of the error to a bug report (#141)

- The in-app Bug Report form gains an "Attach screenshot" control: file
  picker, drag-and-drop, or paste (Ctrl+V), with an inline preview and
  Remove/Replace. Images only (PNG, JPEG, WebP, GIF — verified by content,
  not filename), 5 MB max, one screenshot per report; both limits are also
  re-enforced server-side by the support service, which strips JPEG EXIF and
  PNG textual metadata before storing and forwards the image to the staff
  Discord case thread. The control only appears when the support service
  advertises the capability, so it can never render as a dead button; a
  report with a screenshot travels the authenticated `/v1/cases` API (the
  install mints its own support token on first use — sealed at rest with
  Windows DPAPI), while plain reports keep the existing feedback path.

### Documented — three live updater channels, and which clients are on each

- `build.publish` on `main` targets
  `https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml`.
  That feed governs the **next** build and has **no clients today** — no
  shipped binary was built from a commit carrying it. `package.json` remains
  `5.6.0` (no random bump). HTTPS + SHA-512 integrity + `isAllowedUpdaterUrl`
  (#156). `verifyUpdateCodeSignature` stays false.
- The shipped **v5.6.0** binaries were built at tag `v5.6.0`, whose
  `build.publish` is the generic broker
  `https://botify-network.com/downloads/1132-fixer/updates`. That broker is a
  live proxy of this repository's releases and is what the **entire current
  install base** polls.
- Residual v5.5.1 and earlier clients still poll
  `PrimeUpYourLife/1132-Fixer-Windows-Releases` (`latest.yml` download_count
  2216 on 2026-08-23). That repository is not deleted, and should be archived
  rather than deleted if ever retired. Current source does not fetch it.
- A build's feed is fixed at build time; `autoUpdater.setFeedURL` is never
  called, so no published release can move an already-installed client to a
  different channel.
- Coverage: `tools/updater-channel-smoke.js` asserts live `latest.yml` version
  equals `package.json`, and that the broker has not diverged from it.

## [5.6.0] - 2026-08-08 — finds your Zoom, tells the truth, and locks the helper account down

The largest support-driven release yet: every one of the top reported failure
classes from the last four months is addressed, and the helper account no
longer carries a static password or administrator rights.

### Security
- **The helper account password is now random for every fix run and stored
  encrypted (Windows DPAPI) — never in plain text.** Each FIX NOW mints a
  fresh, cryptographically random password for `user1` and seals it with
  Windows Data Protection (`helper-credential.bin`, decryptable only by your
  own Windows account); the desktop-shortcut launcher script no longer
  contains a password at all. Older shortcuts keep working and are upgraded
  automatically on the next fix run. If Windows Data Protection is disabled
  or blocked on a PC, the fix still completes — only the one-click shortcut
  is unavailable until a later fix run can store the sign-in, and a clear
  warning says so.
- **The `user1` helper account is no longer an administrator.** Every
  privileged repair step already runs under 1132 Fixer's own elevated
  process, and `user1` only runs Zoom — so the account is now created as a
  standard user. If an earlier version left `user1` in the Administrators
  group, the next fix run removes those rights automatically ("Removed
  administrator rights the helper account no longer needs"). Zoom updates
  are unaffected: they install machine-wide from your normal (primary)
  account.

### Fixed
- **"Zoom not found" when Zoom is clearly installed.** Detection now finds
  32-bit and custom-location machine-wide installs (registry lookup), and a
  per-user-only Zoom install gets a real explanation — why the fix can't use
  it and exactly what to install instead — rather than a generic "not found".
  (The most-reported problem: 16 support reports.)
- **"It says it ran fine but I still get the error."** The fix now verifies
  its own outcomes: camera/microphone consent is read back from the registry
  (the per-user value Zoom actually reads is now authoritative), partial data
  clears are counted ("deleted N of M"), service-refresh failures surface,
  and Zoom is confirmed actually running as the helper account. A run with
  unverified outcomes says **FIX COMPLETE — NEEDS ATTENTION** with next steps
  instead of a false green.
- **Zoom sometimes never launched after a green run.** The Secondary Logon
  service is now a hard pre-check that 1132 Fixer starts for you when it can,
  and real launch errors reach the log instead of a guess list.
- **Mid-fix freezes ("My Music cycling over and over").** Profile cleanup no
  longer follows Windows' looping profile junctions; long steps show
  heartbeat progress and time out safely instead of hanging forever.
- **Shortcut creation failed on OneDrive-redirected or non-English
  desktops.** Resolved paths survive Windows' legacy text encoding now; the
  desktop folder is created when redirection removed it.
- **Errors you can act on.** Every blocked pre-check now names a concrete
  next step (including the exact command or download where one exists), a
  failed fix offers **Copy error details** (sanitized), raw internal codes
  no longer appear anywhere, and the app explains itself when the Fix button
  is disabled.
- **No more silent deaths.** A crashed or frozen window now explains what
  happened and how to recover, and an interrupted fix's background steps are
  stopped so they can never keep changing the system behind your back.

### Changed
- The environment checklist is grouped (App · Zoom · Helper account ·
  Privacy policies · Camera service) with an explicit **Check again** button,
  keyboard focus is visible everywhere, and animations honor Windows'
  reduced-motion setting.

## [5.4.0] - 2026-07-17 — reliable updates, working uninstall, one-click flow

Addresses the field reports of freezes, glitches, updates that never complete,
and a broken uninstall.

### Fixed
- **Updates no longer yank the app out from under you.** The old updater called
  `quitAndInstall` 2 seconds after the download finished — with no UI, even
  while the destructive fix flow was mid-run. That was the "app randomly
  closed / froze / update never completed" report. Update state is now shown in
  a banner: when the app is idle, a visible 10-second countdown precedes the
  restart (with "Restart now" / "After I'm done" buttons); once a fix has
  started or completed, the update **never** auto-restarts — it installs when
  you exit the app.
- **Double-launch after update.** `installer.nsh` used to `Exec` the app after
  every silent install *and* electron-updater relaunched it — two elevated
  instances racing each other. The extra `Exec` is gone and the app now holds a
  single-instance lock (a second launch just focuses the existing window).
- **Stuck update downloads.** Differential (blockmap) downloads from GitHub are
  disabled; the updater always fetches the full installer, which is the
  reliable path.
- **Uninstall now works.** The installer was per-user while the app's manifest
  requires Administrator: when a standard user elevated with a *different*
  admin account, the app and its uninstall registry entry landed in that
  admin's profile — invisible and un-uninstallable from the user's own
  account. The install is now **per-machine** (Program Files, HKLM uninstall
  entry visible to every account). The installer also kills a running instance
  before **uninstall** (`customUnInit`) — previously locked files made
  uninstall silently fail — and cleans up the old per-user copy on upgrade.
- **The window can be moved now.** The frameless window had no drag region and
  was `alwaysOnTop`, so it sat immovable above everything — including the Zoom
  window the fix launches. The header is now a drag region and always-on-top
  is gone. The window also waits for `ready-to-show` (no white flash) and
  no longer checks for updates in dev/portable runs (which always errored).
- **Renderer no longer bogs down during long fixes.** Log lines are batched
  into one DOM write per frame and the log DOM is capped at 400 rows;
  previously every robocopy/PowerShell line appended a node and forced a
  reflow, which read as "app freezes".
- Window icon path was wrong in dev runs (`icon.ico` at repo root).

### Changed
- **One click, end to end.** The CHECK & FIX wizard (9 steps of Next), the
  native confirm dialog, and the shortcut prompt are gone. The environment
  checklist now runs **automatically** on launch (and re-runs on window focus)
  and renders inline on the landing screen. FIX NOW is a single click with a
  3-second cancelable countdown on the button itself; the desktop shortcut is
  created automatically after a successful fix if missing.
- Installer is one-click (no directory picker / license page) — it was already
  destined for one location and elevation.
- Removed dead `styles.css` (unreferenced since the inline-token redesign).

## [5.3.12] - 2026-07-15 — credential-free client

Ships the work merged after v5.3.11. The headline: **the app no longer contains a
GitHub token**, so the installer is no longer worth unpacking for secrets. Anyone
still on v5.3.11 or earlier is running a build with a live token inside it — that
token has since been revoked, which also means in-app feedback is broken on those
builds until users update to this one.

Feedback in this release is relayed through the deployed proxy at
`FEEDBACK_PROXY_URL`, verified end to end (issue #84 created via the live
service). No behaviour change to the fix flow itself.

### Security
- **The app no longer ships a credential at all.** Feedback is now relayed
  through a new `feedback-proxy/` service that holds the GitHub token
  server-side; the app POSTs plain JSON to a **public url**. A url is not a
  credential, so it is safe to hardcode and safe to extract.

  This replaces the v5.3.11 approach (inject the token at build time), which was
  never sufficient — it kept the secret out of *git*, but the token still shipped
  inside every build. `config.js` is bundled into `app.asar`, and asar stores
  file contents **uncompressed**, so the token was recoverable from the public
  installer in about a minute:

      7za x 1132-Fixer-Portable-5.3.10.exe -oext
      grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar
      -> GH_ISSUES_TOKEN: 'github_pat_11A674FI...'

  `src/main/config.js` now exposes only `FEEDBACK_PROXY_URL` and has no token
  field whatsoever. `scripts/inject-config.js` **hard-fails the build** if the
  injected value looks like a GitHub token (`ghp_` / `github_pat_`) or is
  plaintext http — a secret cannot reach a build by accident again.
  `release.yml` now reads `${{ vars.FEEDBACK_PROXY_URL }}` (a *variable*, not a
  secret), so no token secret is needed in CI.

  Honest scope: the proxy endpoint is public and unauthenticated by design — any
  shared key shipped in the client would be exactly as extractable as the token
  was. So issue spam remains the worst case, as before. What changes is that the
  token itself can no longer be obtained or reused, abuse is throttled
  (5/hour/IP, 8 KB body cap, strict field validation), the client can no longer
  forge issue bodies or labels, and the whole thing can be disabled or patched by
  redeploying — with no client update and no rotation.

### Added
- **`feedback-proxy/`** — zero-dependency Node service (built-in `http` + global
  `fetch`). `GET /health` reports liveness without revealing the token;
  `POST /feedback` validates `{type, text, version, os}`, builds the issue
  title/body/label itself, and relays to the GitHub API. Never returns GitHub's
  response body to the client (it can carry repo/token detail) — failures are
  logged server-side and answered generically. Ships with `npm test`: a
  12-check smoke that runs the real server against a stubbed GitHub with a fake
  token, asserting among other things that no client response ever contains the
  token and that clients cannot choose their own labels.

### Fixed
- **`feedback-proxy` oversized-payload handling.** The 8 KB cap called
  `req.destroy()` before writing a response, so clients got a socket hang up
  instead of a clean `413`. It now stops buffering but keeps draining, and
  answers properly. Caught by the smoke test before it ever shipped.
- **CI on `master` has been red on every run since at least 2026-05-29.** The
  `build*` scripts called `electron-builder` without an explicit `--publish`
  flag. electron-builder auto-detects CI and, because `package.json` carries a
  `publish` block, tried to publish on its own — failing every `master` push
  with `GitHub Personal Access Token is not set, neither programmatically, nor
  using env "GH_TOKEN"`. It never surfaced on pull requests because
  electron-builder skips publishing for `pull_request` events, so the break was
  invisible from PR checks. `build`, `build:installer` and `build:all` now pass
  `--publish never` — building is not publishing; only `npm run release`
  (`--publish always`) and the tag-triggered `release.yml` publish. This is
  option 2 of the two fixes the README had documented but never applied.
  No effect on shipped artifacts — v5.3.11's binaries are unchanged.

### Changed
- `README.md` — "Release & CI Setup" rewritten: documents the tag-triggered
  release flow, the `package.json` / `package-lock.json` sync requirement that
  `npm ci` enforces (the reason v5.3.10 skipped the pipeline), the build-vs-publish
  split, the full secret table (`RELEASES_PAT`, `GH_ISSUES_TOKEN`, `GH_TOKEN`,
  `CSC_*`), and an explicit warning never to hardcode a token in `config.js`.

## [5.3.11] - 2026-07-14 — FIX NOW crash fix + secret hygiene + toolkit repairs

### Fixed
- **FIX NOW silently did nothing — regression reintroduced by v5.3.10.**
  `runFix()` in `renderer.js` still wrote to a `checkEnvBtn` global that was
  deleted along with the 8-card preflight grid. v5.3.9 removed those two dead
  writes, but the v5.3.10 wizard rollback reverted the whole v5.3.9 changeset
  and brought them back. Clicking **FIX NOW** threw
  `ReferenceError: checkEnvBtn is not defined` at the top of `runFix()` —
  *before* the `run-fix` IPC call — so the fix never ran at all. Because the
  wizard invokes `runFix()` un-awaited, it surfaced only as an unhandled
  promise rejection: no error shown, `isRunning` stuck `true`, and CHECK & FIX
  disabled for the rest of the session. Removed the dead writes and wrapped the
  flow in `try`/`catch`/`finally` so any future throw is surfaced to the user
  and the run lock is always released.
- **`scripts/Zoom-Toolkit.ps1` self-elevation never worked.** The UAC relaunch
  passed `-ArgumentList @(...) + $argsList` with the concatenation *outside* the
  parameter value, so PowerShell parsed the bare `+` as a positional argument
  and `Start-Process` threw "A positional parameter cannot be found that accepts
  argument '+'." Every non-elevated run failed to relaunch, and `-DoAll` /
  `-Reinstall` were silently dropped. Now parenthesised.
- **`scripts/Zoom-Toolkit.ps1` aborted before the deep wipe on some machines.**
  `Get-ZoomMsiGuidsFromRegistry` returns `$null` when no Zoom MSI GUID products
  are registered (per-user EXE install, or Zoom already partly removed), and
  under `Set-StrictMode -Version Latest` the bare `$msiItems.Count` was a
  terminating error — so `-DoAll` died before `DeepWipe-Zoom` and report writing
  ever ran. Now `@($msiItems).Count`.
- **`tools/repoint-profilelist.ps1` deleted ProfileList keys it was meant to
  keep.** The cleanup pass read each key's `ProfileImagePath` into `$p` but never
  tested it, so — despite the banner saying "with empty ProfileImagePath" — it
  hard-deleted *every* `*1098*` key that wasn't the target SID, including
  legitimate profile registrations. Now only removes keys whose
  `ProfileImagePath` is actually empty, and logs the ones it keeps.
- **`scripts/zoom-firstrun-setup.ps1` logged a misleading failure every run.**
  `Echo cancellation` was listed both as a toggle and as a dropdown. It is a
  dropdown, so the toggle pass always logged
  `FAILED (no Toggle pattern): Echo cancellation` before the dropdown pass set
  it correctly — noise in the exact logs users paste into support reports.
  Removed the dead toggle entry; behavior is unchanged.

### Security
- **Removed the hardcoded GitHub feedback token from `src/main/config.js`.**
  This repo is private, so the token was *not* exposed via git — but that was
  never the risk. `config.js` is bundled into the packaged app, and the app ships
  as a **public installer**, so the token landed in `app.asar` inside every
  published `.exe`. asar stores file contents uncompressed, so extracting it from
  the public v5.3.10 download takes about a minute:

      7za x 1132-Fixer-Portable-5.3.10.exe -oext
      grep -a "GH_ISSUES_TOKEN" ext/resources/app.asar

  Verified — the token is present in the published v5.3.10 artifact and must be
  rotated. `config.js` now resolves the token from `process.env.GH_ISSUES_TOKEN`
  or a gitignored, build-time-generated `src/main/config.generated.js` — never
  from source. Builds without a token still succeed; in-app feedback degrades to
  "Feedback service not configured". To restore it: rotate the token, then add it
  as a `GH_ISSUES_TOKEN` repository secret (consumed by `release.yml`).

  **Build-time injection does not make the token secret** — it is still inside
  the shipped `.exe` and extractable by the command above. That is only
  acceptable because the token is scoped to Issues:write on a single repo (worst
  case: issue spam). A server-side proxy is the only way to make it truly secret.

### Added
- `scripts/inject-config.js` — writes the gitignored
  `src/main/config.generated.js` from `GH_ISSUES_TOKEN` / `GH_ISSUES_REPO` at
  build time, so a feedback token can be baked into a build without ever
  entering source control. Wired into every `build*` / `release` script and into
  the `release.yml` build step.
- `scripts/postinstall.js` — self-heals Electron's binary setup. Locked-down
  environments (CI sandboxes, allow-scripts policies) block *dependency*
  lifecycle scripts, so Electron's own `postinstall` never runs and the app dies
  at launch with "Electron failed to install correctly". This re-runs Electron's
  installer when `path.txt` is missing. Idempotent, and never fails an install.
- `tools/sanitizer-smoke.js` — standalone PASS/FAIL smoke for the
  support-report redaction logic. Mirrors `main.js` `sanitize()` exactly
  and covers every redaction class (SID, home dir, username,
  `user1` helper-account guard, hostname). Exits 0 on PASS, 1 on FAIL.
  Now wired to `npm test` and run by CI.
- `docs/zoom-1132-finding.md` — moves the root-cause memo (Zoom error
  1132 follows the Windows user account / SID / DPAPI, not hardware
  identifiers) out of an ad-hoc `MEMORY.md` at the repo root into the
  `docs/` tree alongside the other governance / QA docs.

### Changed
- CI artifact names corrected from the stale `CleanState-Sentinel-*` to
  `1132-Fixer-Portable` / `1132-Fixer-Installer`, and the CI header comment now
  names this project. CI also runs `npm test` before building.
- **Actions artifact uploads no longer fail a build or a release.** They are
  `continue-on-error: true` in both `ci.yml` and `release.yml`. Actions artifact
  storage is a quota-limited bucket *separate* from release assets, and it is
  currently exhausted — so these convenience uploads were failing runs whose
  compile, tests, and (in `release.yml`) actual release publish had all
  succeeded. `release.yml`'s copy is also reduced from 90- to 30-day retention;
  the real deliverables live on the Releases repo as release assets.

## [5.3.10] - 2026-06-02 — TEMP-profile cascade prevention + wizard simplification

### Changed
- **Wizard reverted to manual step-through.** Rolled back the v5.3.9 premium
  guided flow after it shipped more bugs than value (preflight hangs, stale
  renders, dead `checkEnvBtn` refs). Removed: auto-open on launch, intro
  overview step, auto-advance timer + countdown bar, generation guard /
  60s scan-timeout race, step-enter reflow animation, status-tinted card
  outline + overall progress bar. The wizard still walks all 8 preflight
  checks with Back / Next / Cancel and ends in the FIX NOW confirmation;
  user advances each step manually. Deleted dead verification harness
  `tools/verify-wizard-autoflow.js`.

### Fixed
- **TEMP-profile cascade after fix run.** Three changes in `main.js` prevent
  Windows from minting `C:\Users\TEMP.<machine>.NNN` fallback profiles on
  the next `user1` logon after the device-reset cycle.
  - Widened ProfileList cleanup to match registry keys by SID (`<sid>` and
    `<sid>.bak`) in addition to `ProfileImagePath`. Path-only matching
    missed the post-failure shape where UPS had renamed the live key to
    `<sid>.bak` and minted a new `<sid>` key pointing at a `TEMP.*`
    folder, leaving the broken primary key behind across runs.
  - New STEP 3b restarts `ProfSvc` (User Profile Service) after account
    delete + ProfileList sweep. Drops retained hive handles into the
    deleted `C:\Users\user1\...\UsrClass.dat` that otherwise survive the
    delete and block the next logon's hive load (Event 1509 → 1515 →
    1511 → TEMP profile). Falls back to `sc.exe stop/start` if
    `Restart-Service` is denied (ProfSvc shares a svchost group), then
    `reg flush HKLM` as belt-and-suspenders.
  - New STEP 6 ACL seed: after the user1 profile materializes, raw-SID
    `icacls /grant *<sid>:(F) *S-1-5-18:(F) *S-1-5-32-544:(F)` is applied
    to `NTUSER.DAT` and `AppData\Local\Microsoft\Windows\UsrClass.dat`.
    Raw-SID ACEs survive account deletion, so subsequent fix cycles
    can't be denied hive read by stale NTFS inheritance from
    `nuke-acls.ps1` runs.
- **Two reusable PowerShell helpers added** under `tools/` for one-shot
  recovery when a TEMP-profile cascade is already on disk:
  `merge-user1-profiles.ps1` (inventory + additive robocopy merge of
  stale `user1.MACHINE` / `TEMP.*` folders into canonical
  `C:\Users\user1`, with `MoveFileEx`-based reboot-pending delete
  fallback for locked hive files) and `repoint-profilelist.ps1`
  (repoint a SID's `ProfileImagePath` and prune orphan `.bak` / junk
  subkeys).

## [5.3.9] - 2026-05-30 — Premium wizard flow + FIX NOW freeze fix

### Added
- **Premium guided wizard flow.** The wizard now owns the intro: an
  Overview step (status: ready, ~2.6s auto-dwell) is prepended ahead of
  the 8 preflight cards, and the wizard auto-opens on launch when the
  app is running elevated. A linear progress bar at the top of the card
  tracks overall position (step N of total) and tints accent / warning
  / danger as the worst-seen status degrades. Each auto-advancing step
  now shows a thin countdown bar that fills 0→100% over the exact
  auto-advance interval so users have continuous visual feedback. Steps
  fade-and-slide in on render. Per-step auto-advance interval is
  configurable via `step.autoMs` (defaults to 1.4s; intro uses 2.6s).
  Existing safeties preserved: blocked steps halt auto-advance, Back
  disables auto-advance for the session, FIX NOW still requires the
  native consent dialog. Harness extended to 15/15 covering intro step
  invariants and confirm-position offset.
- **Wizard auto-advance.** After CHECK & FIX opens the wizard, each
  non-blocked check step auto-advances after 1.6s so the user lands on
  the CONFIRM FIX summary without N manual Next clicks. The final
  CONFIRM FIX step is never auto-advanced — `FIX NOW` is destructive
  and requires an explicit click. A blocked step also halts
  auto-advance so the user reads the failure and Cancels. Clicking Back
  disables auto-advance for the rest of the wizard session so the user
  can step through manually. Hint text shows "Auto-advancing… click
  Back to pause." while the timer is armed.

### Fixed
- **FIX NOW no longer freezes the app after the wizard summary.** `runFix()`
  referenced a `checkEnvBtn` global that was removed when the 8-card
  preflight grid was replaced by the wizard (Slice C / wizard refactor).
  Clicking FIX NOW on the confirm step threw a `ReferenceError` after the
  native consent dialog, killing the run before stage tracking or IPC
  started. The app appeared stuck on the intro screen with a stale
  "Action needed" badge. Removed the two dead `checkEnvBtn.disabled`
  writes in `renderer.js` so `runFix()` proceeds to the running view.
- **Wizard no longer hangs on "Loading…" when PowerShell probes stall.**
  The `preflight-scan` IPC handler runs two `powershell.exe` capture
  scripts (tool inventory + cam/mic/HKU/FrameServer probe) and neither
  had a timeout. On machines where Defender or another AV throttled
  PowerShell startup, both spawns would sit indefinitely with no
  child-process output, leaving the wizard frozen on its loading state
  with only Cancel as an escape. Each probe now caps at 20s and degrades
  to a `warning` card with a probe-timeout message instead of blocking
  the wizard. The renderer also imposes a 60s overall safety timeout on
  `preflightScan()` so any unexpected IPC hang surfaces a user-readable
  error instead of a perpetual spinner.

## [5.3.8] - 2026-05-29 — Guided CHECK & FIX wizard

Release-hygiene cut. The wizard work landed direct-to-master at commit
`762a649` while package.json was still `5.3.7`, so source diverged from
the published v5.3.7 artifact (which contains the 8-card grid). This
release brings them back into alignment. The v5.3.7 release / tag are
intentionally left untouched.

### Changed
- **Initial view replaces the 8-card preflight grid with the pre-Slice C
  numbered instruction list.** Same content that v5.3.5 shipped, restored
  inside the v5.3.7 tokenized panel.
- **`FIX NOW` and `Re-scan` are unified into one `CHECK & FIX` button.**
  Clicking it opens a guided wizard modal instead of running the fix
  directly or refreshing a card grid.

### Added
- **Wizard modal — guided preflight walkthrough.** Steps 1..N are the
  preflight cards (Admin / Zoom / Helper / Cam policy / Mic policy / HKU /
  FrameServer / Version), one at a time with Back / Next / Cancel
  controls and a status-colored dot row. Blocked status disables Next so
  the user must Cancel and resolve the blocker. Final step is a summary
  list plus the `FIX NOW` confirmation; only enabled when no card is
  Blocked. Reuses the existing `preflight-scan` IPC handler unchanged.
- **Esc closes the wizard** (consistent with the feedback and support
  modals). Focus trap from v5.3.7 composes cleanly.

### Removed
- The 8-card grid view (`#preflightGrid`) and the standalone `Re-scan`
  button. The grid CSS classes (`.pf-card`, `.pf-grid`) are retained as
  dead style for now to keep the diff focused; tracked for cleanup.

### Includes
- All v5.3.6 media-consent hardening.
- All v5.3.7 Slice C foundation (design tokens, glass refresh, stage
  tracker, Fix Receipt cards, Support Report, focus trap, sanitizer).

## [5.3.7] - 2026-05-29 — Slice C: Premium UX

### Added
- **Preflight Scan screen.** New initial view replaces the static instruction list with an 8-card environment grid: Administrator, Zoom Workplace, Helper account (`user1`), Camera policy, Microphone policy, User registry hive (HKU), Camera Frame Server, App version. Each card is tagged Ready / Repairable / Warning / Blocked. `FIX NOW` is gated on no blocked cards.
- **New IPC handler `preflight-scan`** in `main.js` extending `preflightCheck()` with read-only probes for helper-user state, GPO `LetAppsAccess{Camera,Microphone}` policy, FrameServer service state, and HKU hive load state. Pure read — never mutates.
- **Staged progress UI.** Five-pill tracker (`Preparing → Verifying → Consent → Launch → Verify`) advances live by parsing `[N/8]` headers from the existing `fix-log` stream. Raw log auto-collapses behind an "Advanced Details" expander during the run and re-expands on completion.
- **Fix Receipt polish.** The receipt panel introduced in v5.3.6 is now rendered as styled status cards (camera, microphone, HKU path, FrameServer) with status-colored left borders and inline icons.
- **Support Report generator.** New `support-report` IPC handler builds a sanitized markdown bundle (version, OS, preflight summary, last receipt, last ~80 log lines). Usernames, profile paths (`C:\Users\<you>`), and SIDs are redacted before display. Renderer adds a footer Support Report button with a Copy-to-clipboard modal.
- **Design tokens.** CSS custom properties for surfaces (`--bg`, `--panel`, `--border`), text (`--text`, `--muted`), status palette (`--success/warning/danger/accent/info` with bg + bd pairs), radii, shadow scale, and spacing scale. All inline styles reference tokens — no hardcoded colors.
- **Fluent-inspired dark glass refresh.** `backdrop-filter: blur(10px)`, soft borders, depth shadows, refined typography (Segoe UI Variable with Cascadia Code monospace).
- **Brand asset pack** under `assets/brand/`: `logo-mark.svg` (shield + wrench monogram, gradient source for any rasterized derivative), `tray.svg` (16/24/32px tray variant), and `status-{success,warning,error,running}.svg` as canonical icon sources.
- **Accessibility pass.** Global `:focus-visible` rings, ARIA roles (`status`, `log`, `list`, `dialog`, `radiogroup`), `aria-live="polite"` on the status badge / preflight grid / log region, `aria-busy` on the preflight grid during scan, `aria-labels` on every icon-only button, keyboard activation (`Enter`/`Space`) on `.fb-choice` divs, and `Escape` to close either modal. Status palette tested for WCAG AA contrast against `--panel` surfaces.

### Scope-locked (intentionally untouched)
- `scripts/grant-media-consent.ps1` — consent logic from v5.3.6 unchanged.
- `scripts/zoom-firstrun-setup.ps1` — first-run reassertion unchanged.
- `main.js` consent flow (Step 7) — only extended with new read-only IPC handlers (`preflight-scan`, `support-report`); `run-fix` body untouched.
- Static `user1`/`user1` helper-account model — tracked in upstream issue #33 (deferred to v5.4.x).
- `electron-builder` signing config — separate work.

### Out of scope (proposal only, captured in PR body)
- New Repair Mode selector (Standard / Media-Only / Clean-Profile / Full-Reset).

### Post-review hardening
- **Focus trap** on both modals (`#fbOverlay`, `#supportOverlay`). Tab / Shift+Tab cycle within the active modal, Escape still closes, focus restores to the element that opened the modal. Handles the 0- and 1-focusable edge cases without throwing.
- **Machine-name redaction** in the Support Report — `os.hostname()` replaced with `<host>` at word boundaries (catches the `user1.MACHINENAME` residue pattern from step-2 cleanup).
- **Defensive sanitizer guard** — the bare-username regex is skipped when the operator's username collides with the public helper-account constant (`FIX_USER === 'user1'`), so we never corrupt legitimate `'user1'` log lines. preflightCheck() already blocks that case via `running_as_target`; this is belt-and-braces.

## [5.3.6] - 2026-05-29

### Fixed
- **Camera and microphone access for the dedicated `user1` Zoom profile.**
  Newly created local Windows users have per-user privacy gates that block
  desktop apps from reading the camera/microphone by default. Previously,
  users had to manually open Settings → Privacy & security → Camera (and
  Microphone) under `user1` and enable both the master toggle and "Let
  desktop apps access your camera/microphone". The fix now grants this
  consent automatically at user-creation time.

### Added
- `scripts/grant-media-consent.ps1` — modular PowerShell helper that
  writes the `CapabilityAccessManager\ConsentStore` registry values for
  webcam + microphone (parent key + `NonPackaged` subkey, both
  `Value=Allow` REG_SZ) under both HKLM (machine floor) and `HKU\<SID>`
  (per-user toggle Zoom actually reads).
- **HKU hive load/unload fallback.** If `HKU\<SID>` is not yet loaded
  when the consent step runs (race against first Zoom launch as `user1`),
  the script now performs `reg load HKU\<SID> <profile>\NTUSER.DAT`,
  writes consent, then `reg unload` in a `finally` block. This eliminates
  the previous race window where per-user consent was silently skipped.
- **Group Policy detection.** Reads
  `HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy\LetAppsAccessCamera`
  and `LetAppsAccessMicrophone`. If either is set to Force Deny (`2`),
  the script does not attempt registry overrides and surfaces a clear
  warning. Policy is treated as authoritative — the app will NOT claim
  "fixed" when Windows policy blocks access.
- **Write-back verification.** Every consent write is read back and the
  result reported per-device (`CAM_USER_GRANTED=YES/NO`, etc.) so the
  app can distinguish a real fix from a silent failure.
- **FrameServer service repair.** If the Windows Camera Frame Server
  service is `Disabled` (a common privacy-hardening byproduct), the
  script bumps it to `Manual`. Without FrameServer no desktop app can
  enumerate cameras, regardless of consent state.
- **Belt-and-braces reassertion in `zoom-firstrun-setup.ps1`.** Consent
  is re-asserted from inside `user1`'s own session (HKCU = HKU\<user1>)
  after first Zoom sign-in, catching any case where the main step's
  per-user write was missed.
- **`run-fix` IPC now returns a `receipt` object** alongside `warnings`,
  with `{ camera, microphone, hkuPath, frameServer }` fields:
  - `camera` / `microphone`: `OK`, `POLICY-BLOCKED`, or `UNVERIFIED`
  - `hkuPath`: `session` (hive already loaded), `temp-load` (we loaded
    it), or `skipped`
  - `frameServer`: `ok`, `restored-from-disabled`, `disabled-unfixable`,
    or `missing`

### Changed
- Media-consent logic moved out of `main.js` template literals into the
  standalone `scripts/grant-media-consent.ps1`. The previous inline
  approach made the PS unreadable, untestable, and re-escape-prone.
- `package.json` `extraResources` now ships `grant-media-consent.ps1`
  alongside `zoom-firstrun-setup.ps1` and `icon.ico`.

### QA
The following manual cases must pass before tagging the release:

| Case | Expected |
|---|---|
| Fresh Win10, local admin run | Zoom launches as user1; camera + mic work in a test meeting without any Settings trip |
| Fresh Win11, local admin run | Same as above |
| Existing user1 profile present | Password reset preserves Zoom sign-in state; consent reasserts |
| HKU hive not loaded at consent-step time | Script logs `HKU_LOADED_TEMP=YES`, writes succeed, `HKU_UNLOAD_OK=YES` |
| Camera GPO Force Deny | App reports `gpo_deny_camera` warning; does not claim camera fixed |
| Microphone GPO Force Deny | App reports `gpo_deny_microphone` warning; does not claim mic fixed |
| Machine-wide Zoom missing | App reports `zoom_not_found` blocker; no false success |
| Hardware privacy shutter closed | App reports consent OK; user docs advise hardware check |
| Third-party AV webcam shield (Bitdefender/Kaspersky/ESET) | App reports consent OK; user docs advise AV check |
| FrameServer service Disabled | Script bumps to Manual + emits `FRAMESERVER_RESTORED` |

### Known limitations
- Group Policy / MDM "Force Deny" camera or microphone settings cannot
  be overridden by the app. This is enforced by Windows.
- Hardware privacy shutters (Lenovo ThinkShutter, Dell webcam slider,
  function-key camera disable) operate below the OS layer and are not
  controlled by registry consent.
- Camera driver failures are not diagnosed by this release.
- Third-party antivirus webcam shields (Bitdefender, Kaspersky,
  ESET, etc.) gate camera access independently of Windows consent.
- The `CapabilityAccessManager\ConsentStore` registry layout is not
  presented as a stable public API by Microsoft. This release treats
  it as a best-effort implementation detail with write-back verification
  and clear failure surfacing rather than a guaranteed contract.

### Security follow-up (tracked separately)
- **P0:** Replace the static `user1` / `user1` helper-account model with
  a per-install generated credential, prefer non-admin where possible,
  drop admin membership after setup, and store credentials via DPAPI or
  Windows Credential Manager rather than hard-coded in code. This release
  does not change the existing account model.

## [5.3.5] - 2026-05-22

- Release pipeline hardening; workflow-panel copy refresh.

## [5.3.3] - earlier

- Silence Win Home noise warnings; detect existing desktop shortcut.

## [5.3.2] - earlier

- Release pipeline validation; no behavior change.

## [5.3.0] - earlier

- Direct publish of releases to the `1132-Fixer-Windows-Releases` repo
  for the auto-updater.

[6.3.1]: https://github.com/1132-Fixer/windows/releases/tag/v6.3.1
[6.3.0]: https://github.com/1132-Fixer/windows/releases/tag/v6.3.0
[6.2.0]: https://github.com/1132-Fixer/windows/releases/tag/v6.2.0
[6.1.0]: https://github.com/1132-Fixer/windows/releases/tag/v6.1.0
[6.0.0]: https://github.com/1132-Fixer/windows/releases/tag/v6.0.0
[5.3.6]: https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/tag/v5.3.6
[5.3.5]: https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/tag/v5.3.5
