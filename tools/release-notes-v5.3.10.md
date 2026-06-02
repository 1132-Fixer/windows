## 1132 Fixer v5.3.10 — TEMP-profile cascade prevention + wizard simplification

Two concerns in one release. The TEMP-profile cascade fix lands the actual reliability win. The wizard simplification rolls back the v5.3.9 premium guided flow back to a plain step-through after the auto-advance / auto-open / animated progress UX shipped more bugs than value (preflight hangs, stale renders, dead `checkEnvBtn` refs).

### Fixed

**TEMP-profile cascade after fix run.** Closes the failure mode where, after the 1132 reset cycle (delete `user1` → recreate → secondary-logon launch), Windows mints a `C:\Users\TEMP.<machine>.NNN` fallback profile instead of loading `C:\Users\user1`. Failure shape verified via Application log: Event 1509 (cannot load `UsrClass.dat`) → 1515 (backed-up SID key with `.bak` suffix) → 1511 (logged on with temporary profile). Three landings in `main.js`:

- **Widened ProfileList sweep (STEP 3).** Cleanup now matches registry keys by SID (`<sid>` AND `<sid>.bak`) in addition to `ProfileImagePath`. Path-only matching missed the post-failure shape where User Profile Service had renamed the live key to `<sid>.bak` and minted a new `<sid>` key pointing at a `TEMP.*` folder. Any removed `ProfileImagePath` becomes a folder-cleanup candidate (orphan sweep).
- **New STEP 3b: ProfSvc restart.** User Profile Service caches loaded hives in `svchost`; a stale handle into the deleted `C:\Users\user1\AppData\Local\Microsoft\Windows\UsrClass.dat` can survive delete and block the next logon's hive load. Restart drops every retained handle. Falls back to `sc.exe stop/start` if `Restart-Service` is denied (ProfSvc shares a svchost group), then `reg flush HKLM` as belt-and-suspenders.
- **New STEP 6: ACL seed.** After the profile materializes, `icacls` grants `*<sid>:(F)` plus `*S-1-5-18:(F)` (SYSTEM) and `*S-1-5-32-544:(F)` (Administrators) on `NTUSER.DAT` and `AppData\Local\Microsoft\Windows\UsrClass.dat` using the raw-SID `*` prefix. Raw-SID ACEs survive account deletion (NTAccount lookup fails for deleted accounts but the SID-bound ACE remains valid for the recreated account).

### Changed

**Wizard reverted to manual step-through.** Removed from `renderer.js`:

- Auto-open on launch (no more wizard popping over the instruction list).
- Intro overview step + auto-advance timer + countdown fill bar.
- Generation guard / 60s scan-timeout race in `openWizard`.
- Step-enter reflow animation.
- Overall progress bar + status-tinted card outline.
- `wizardBack()` no longer disables auto-advance for the session (auto-advance no longer exists).

The wizard still walks Admin / Zoom / Helper / Cam policy / Mic policy / HKU / FrameServer / Version with Back / Next / Cancel and a colored dot row, ending in the FIX NOW confirmation. Blocked status still disables Next. Esc still closes. Focus trap intact.

Deleted `tools/verify-wizard-autoflow.js` — verified the auto-advance flow that no longer exists.

### Added

- `tools/merge-user1-profiles.ps1` — recovery helper for when the cascade is already on disk. Inventories and additively robocopies stale `user1.MACHINE` / `TEMP.*` folders into canonical `C:\Users\user1`, with `MoveFileEx`-based reboot-pending delete fallback for locked hive files.
- `tools/repoint-profilelist.ps1` — repoints a SID's `ProfileImagePath` and prunes orphan `.bak` / junk subkeys.

### Includes

- All v5.3.6 media-consent hardening.
- All v5.3.7 Slice C foundation (design tokens, glass refresh, stage tracker, Fix Receipt cards, Support Report, focus trap, sanitizer).
- All v5.3.8 guided CHECK & FIX wizard structure.

### Known limitations

- Force Deny via GPO / MDM cannot be overridden by this app.
- Hardware privacy shutters, function-key camera disables, third-party AV webcam shields, and camera-driver failures operate below the OS layer.
- If a `TEMP.*` profile has already been created on a target machine, run `tools/merge-user1-profiles.ps1` before the next fix cycle so data is preserved.

### Artifacts

- `1132-Fixer-Portable-5.3.10.exe` — portable x64 build, self-contained, run as Administrator.
- SHA256: `<fill after build>`

Built from commit `<fill after commit>`.
