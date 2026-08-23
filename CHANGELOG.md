# Changelog

All notable changes to 1132 Fixer (Windows) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed — update feed moves to the Botify Network download broker (#136)

- The updater feed and the portable "download it" link now point at the
  Botify Network download broker
  (`botify-network.com/downloads/1132-fixer/updates` /
  `…/downloads/1132-fixer/latest`) instead of anonymous GitHub release
  URLs. Releases keep publishing on this repository's GitHub Releases —
  the broker reads them server-side, so the repository can stay private
  and installed apps need no GitHub access. `build.publish` becomes the
  matching `generic` provider (the release workflow already creates the
  GitHub release itself with `-p never`, unchanged). The first release
  tag after this change must wait until the broker's `1132-fixer` entry
  is live.
- The `npm run release` script drops `--publish always` for `--publish never`:
  electron-builder cannot upload to a `generic` provider, so `always` no longer
  publishes anything and only implied one. Publishing stays exclusively on the
  tag-triggered `release.yml` (`action-gh-release`), which uploads `latest.yml`
  and the installers to this repo's GitHub Releases for the broker to serve.

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

[5.3.6]: https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/tag/v5.3.6
[5.3.5]: https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/tag/v5.3.5
