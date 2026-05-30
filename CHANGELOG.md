# Changelog

All notable changes to 1132 Fixer (Windows) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
