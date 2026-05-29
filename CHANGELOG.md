# Changelog

All notable changes to 1132 Fixer (Windows) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
