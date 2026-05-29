# Manual QA checklist — v5.3.6 (media-consent release)

This release adds camera/microphone consent handling for the `user1`
Zoom-launch profile. Prior v5.3.0 destructive-flow QA still applies as
the base — see [QA-CHECKLIST-v5.3.0.md](QA-CHECKLIST-v5.3.0.md). This
document adds **only the new cases introduced in 5.3.6**.

Run on a Windows 10 1809+ or Windows 11 test machine with Zoom Workplace
installed at `C:\Program Files\Zoom\bin\Zoom.exe`. Sign in as an
administrator account **other than `user1`**.

The packaged artifact under test is
`dist\1132 Fixer Setup 5.3.6.exe` (or the matching portable build).

---

## Section A — Happy path (camera + mic actually work)

The whole point of the release. If A1 or A2 fails, do not ship.

### A1. Windows 10 — fresh machine

- [ ] Run the installer; launch the app as Administrator
- [ ] Press **Fix Now** and approve UAC
- [ ] Wait for `FIX COMPLETE`
- [ ] Confirm **Fix Receipt** panel shows:
  - `Camera (desktop apps): GRANTED`
  - `Microphone (desktop apps): GRANTED`
  - `HKU hive: active user1 session` OR `loaded NTUSER.DAT to write consent, unloaded after`
  - `Frame Server: OK` (or `restored from Disabled`)
- [ ] Sign into Zoom as `user1`
- [ ] Start a test meeting (Join with Computer Audio)
- [ ] **Camera dropdown enumerates real devices** (not "No cameras detected")
- [ ] Selected camera produces a live preview
- [ ] **Microphone dropdown enumerates real devices**
- [ ] Test Mic button shows input level
- [ ] **NO trip required to Settings → Privacy & security → Camera/Microphone under user1**

### A2. Windows 11 — fresh machine

Repeat A1 on Windows 11 (any supported build, 22H2 minimum).

### A3. Existing `user1` profile with valid Zoom sign-in

- [ ] Sign-in state survives the fix (no re-login required)
- [ ] Receipt still shows `GRANTED` for both devices
- [ ] Meeting test from A1 passes

---

## Section B — HKU hive race coverage

The biggest correctness change in 5.3.6 — verify both paths work.

### B1. HKU hive already loaded (typical case)

The default flow now keeps `user1`'s Zoom session alive between
account creation and consent step, so HKU should be loaded.

- [ ] Run fix
- [ ] In the log stream, confirm `HKU_ALREADY_LOADED=YES` appears
- [ ] Receipt shows `HKU hive: active user1 session`
- [ ] Consent values written to `HKU\<sid>\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam` are `Allow` after the fix (verify with `reg query` from an elevated shell)

### B2. HKU hive NOT loaded — temp load path

Force this case by killing user1's Zoom + logging off user1 between
account creation and consent. Easiest path: insert a Sleep or breakpoint
in `main.js` between steps 5 and 7 during dev testing.

- [ ] Log shows `HKU_LOADED_TEMP=YES`
- [ ] Log shows `HKU_UNLOAD_OK=YES`
- [ ] After unload, `C:\Users\user1\NTUSER.DAT` is NOT in use (verify with `handle.exe` from Sysinternals or by running the fix a second time without error)
- [ ] Receipt shows `HKU hive: loaded NTUSER.DAT to write consent, unloaded after`
- [ ] Camera + mic enumeration in test meeting works

### B3. HKU hive cannot be loaded

Rename `C:\Users\user1\NTUSER.DAT` to `NTUSER.DAT.bak` between
account creation and consent (dev-only synthetic test).

- [ ] Log shows `HKU_LOAD_FAILED=<reason>`
- [ ] Log shows `HKU_NOT_LOADED`
- [ ] App displays warning: "HKU\\<sid> hive could not be loaded for per-user consent — first-run reassertion will retry"
- [ ] After signing into Zoom as user1 and double-clicking **Apply Zoom Settings**, the firstrun reassertion writes consent in HKCU
- [ ] Camera + mic work in a fresh test meeting

---

## Section C — Policy-blocked cases (app must NOT claim "fixed")

This is the most important UX correctness gate.

### C1. Camera blocked by group policy

From an admin PowerShell, set the policy:

```powershell
$p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy'
if (-not (Test-Path $p)) { New-Item $p -Force | Out-Null }
New-ItemProperty -Path $p -Name LetAppsAccessCamera -PropertyType DWord -Value 2 -Force
```

- [ ] Run fix
- [ ] Log shows `GPO_DENY_CAMERA`
- [ ] Receipt shows `Camera (desktop apps): BLOCKED BY WINDOWS POLICY`
- [ ] Receipt does NOT claim camera "GRANTED"
- [ ] Warnings panel includes a `gpo_deny_camera` entry with admin-action guidance
- [ ] App does NOT retry / loop

Clean up:

```powershell
Remove-ItemProperty -Path $p -Name LetAppsAccessCamera -Force
```

### C2. Microphone blocked by group policy

Same as C1 with `LetAppsAccessMicrophone = 2`.

- [ ] Log shows `GPO_DENY_MICROPHONE`
- [ ] Receipt shows `Microphone (desktop apps): BLOCKED BY WINDOWS POLICY`

### C3. Both blocked

Set both. Both receipt rows show policy-blocked. Receipt header still
reads `FIX COMPLETE (with N warnings)` — not "FAILED" — because account
creation + Zoom launch did succeed; only consent was blocked.

---

## Section D — FrameServer service

### D1. FrameServer Disabled

From an admin PowerShell:

```powershell
Set-Service -Name FrameServer -StartupType Disabled
```

- [ ] Run fix
- [ ] Log shows `FRAMESERVER_RESTORED`
- [ ] Receipt shows `Frame Server: was Disabled, restored to Manual`
- [ ] `(Get-Service FrameServer).StartType` returns `Manual` after the fix
- [ ] Camera enumerates in test meeting

### D2. FrameServer Disabled and cannot be restored

Simulate by removing write permission on the service config (advanced
test; skip if not reproducible). Expected: `FRAMESERVER_DISABLED` marker
and warning, no "fixed" claim.

---

## Section E — Negative / boundary cases

### E1. Zoom not installed at expected path

- [ ] Uninstall machine-wide Zoom
- [ ] Preflight reports `zoom_not_found` blocker
- [ ] **Fix Now button is disabled** OR fix bails before destructive steps
- [ ] No false success

### E2. Hardware privacy shutter closed

- [ ] Close Lenovo ThinkShutter / Dell webcam slider / function-key
      camera disable
- [ ] Run fix → completes successfully, receipt shows camera GRANTED
- [ ] Test meeting shows "Cannot start video" — this is correct
- [ ] Receipt footer note mentions hardware shutters are not controlled
      by this fix

### E3. Third-party antivirus webcam shield

- [ ] Install Bitdefender Total Security / Kaspersky Internet Security
      / ESET with webcam protection enabled
- [ ] Run fix
- [ ] Receipt shows camera GRANTED at the OS layer
- [ ] AV may still block camera at app level — this is correct (out of scope)
- [ ] Receipt footer note mentions third-party AV webcam shields

### E4. Re-running the fix

- [ ] Run fix end-to-end
- [ ] Run fix again immediately (no reboot)
- [ ] Second run does not corrupt the user1 profile
- [ ] Receipt still shows GRANTED for both devices

---

## Section F — Build / packaging verification

### F1. Installer artifact

- [ ] Installer filename matches `1132-Fixer-Setup-5.3.6.exe`
- [ ] App About / version display shows `v5.3.6`
- [ ] Installer is signed (publisher name visible in UAC prompt;
      blocking unless the operator is shipping unsigned for testing)

### F2. Bundled resources

After install, verify the new script ships:

```text
C:\Program Files\1132 Fixer\resources\grant-media-consent.ps1
C:\Program Files\1132 Fixer\resources\zoom-firstrun-setup.ps1
C:\Program Files\1132 Fixer\resources\icon.ico
```

- [ ] All three present
- [ ] PowerShell parse-check on `grant-media-consent.ps1` succeeds:
  ```powershell
  $e=$null; [System.Management.Automation.Language.Parser]::ParseFile('grant-media-consent.ps1',[ref]$null,[ref]$e); $e
  ```

### F3. Pre-merge static checks

From the repo root:

```bash
node --check main.js
node --check renderer.js
node --check preload.js
node --check src/main/config.js
```

```powershell
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts\grant-media-consent.ps1',[ref]$null,[ref]$e); $e
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('scripts\zoom-firstrun-setup.ps1', [ref]$null,[ref]$e); $e
```

- [ ] All pass with no output

---

## Section G — Sign-off

- [ ] All of A, B, C, D, E, F checked
- [ ] Test machine receipts attached to the release PR
- [ ] CHANGELOG.md entry matches what was actually verified
- [ ] No section claims "GRANTED" while user-visible Zoom still shows
      a camera/mic problem

Tester: _________________________  Date: _________________________

Build under test: _________________________
