# Manual QA checklist — v5.3.0 destructive flow

Last automated validation: see [main.js](main.js) commit on local branch.
Live preflight verified on test machine; the destructive flow itself was **not** run from the CLI environment that produced this checklist, because the only available test target was the developer's working machine (user1 is a real account there) and the flow cannot be triggered from the renderer without a UI click.

Run the steps below on a Windows test machine (Win10 1809+ / Win11) that has Zoom Workplace installed at `C:\Program Files\Zoom\bin\Zoom.exe`. Sign in as an administrator account **other than user1**.

The packaged artifact under test is `dist\1132 Fixer Portable 5.3.0.exe` (or the matching NSIS installer if built).

---

## Section 1 — Capture starting state (5 min)

Open an admin PowerShell prompt and run from the project root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\qa-context.ps1
```

Record:

- [ ] Edition / Build / current `$env:USERNAME` (must NOT be `user1`)
- [ ] Zoom path `present`
- [ ] `seclogon` Status + StartType (target: `Running` or `Stopped`, StartType **not** `Disabled`)
- [ ] `LanmanServer` Status (target: `Running` for `net session` admin probe)
- [ ] `user1 SID` (may be empty if user1 doesn't exist yet — both states are valid starting points)
- [ ] `C:\Users\user1` exists/absent
- [ ] Suffixed `user1.*` folders present (record all)
- [ ] Whether user1 is currently in local Administrators

---

## Section 2 — Positive path (15 min)

### 2.1 Launch the app

Right-click `1132 Fixer Portable 5.3.0.exe` → Run as administrator. Click through UAC.

- [ ] Window opens with status badge "Ready" (green dot)
- [ ] "FIX NOW" button enabled
- [ ] Bottom right says "Administrator" (green badge)
- [ ] Version badge reads `v5.3.0`

### 2.2 Click FIX NOW

- [ ] Destructive confirmation dialog appears titled "Confirm Fix - Destructive"
- [ ] Detail enumerates: log off active user1 session, delete account, delete `C:\Users\user1`, wipe ProfileList, recreate user1 password `user1`, launch Zoom, deploy Apply Zoom Settings helper
- [ ] **"Cancel" is the default button** (pressing Enter must cancel, not continue)
- [ ] Press Cancel — dialog closes, no destructive action occurs, status badge unchanged

### 2.3 Click FIX NOW again → Continue

Watch the streaming log. Acceptance criteria per phase:

**Step 0/8 — Preflight**
- [ ] One `OK` line per required tool (powershell.exe, taskkill.exe, robocopy.exe, icacls.exe, takeown.exe, net.exe, reg.exe)
- [ ] `opt` lines for quser.exe / logoff.exe (present or marked optional)
- [ ] `Zoom present: ...Zoom.exe -> YES`
- [ ] `Firstrun script: ...zoom-firstrun-setup.ps1 -> YES`
- [ ] `Interactive user:` shows your admin name (lowercased)
- [ ] No `BLOCK [...]` lines

**Step 1/8 — Terminating user1 processes/sessions**
- [ ] `taskkill /F /FI USERNAME eq user1` runs (succeeds with `SUCCESS:` or harmlessly fails with `ERROR: not found` — both pass)
- [ ] If quser available: either `No active sessions for user1.` or `Found N session(s)` followed by `Logged off N session(s).`
- [ ] If quser unavailable: line `quser.exe unavailable - skipping session enumeration (taskkill still runs).`
- [ ] No silent failures — if any logoff issue, you see `WARNING:` with the specific failure mode

**Step 2/8 — Removing leftover suffixed profile folders**
- [ ] If suffixed folders existed: `Found: C:\Users\user1.<machine>` and `Deleting: ...` lines, then `RESULT: gone in N.Ns`
- [ ] If none: `None found.`

**Step 3/8 — Removing existing account and profile**
- [ ] If user1 existed: `Account deleted.`
- [ ] If `C:\Users\user1` existed: `Deleting: C:\Users\user1` then `RESULT: gone in N.Ns`, then `Profile folder deleted.`
- [ ] `Cleaning ProfileList registry entries for 'user1'...` followed by `Removing ProfileList entry: <SID>  ->  C:\Users\user1` and `Cleaned N ProfileList entries.`
- [ ] No mention of removing entries for other users — only `user1` and `user1.*` paths

**Step 4/8 — Creating account user1 and verifying admin membership**
- [ ] `Account 'user1' created.`
- [ ] `Add-LocalGroupMember OK.` (or fallback line if the cmdlet failed)
- [ ] `Membership check via Get-LocalGroupMember: YES`
- [ ] If `NO`: the line is red, and a `WARNING: user1 admin membership could not be verified.` appears. This is non-fatal — the flow continues.

**Step 5/8 — Launching Zoom as user1**
- [ ] `Zoom launched as user1.`
- [ ] Within ~6 seconds: `Confirmed: Zoom.exe is running as user1.`
- [ ] If you see `Zoom.exe was not detected running as user1 within 6s of launch.` — Zoom crashed on launch; flag for investigation

**Step 6/8 — Resolving user1 profile path**
- [ ] `Resolved via registry: C:\Users\user1` (target — proves the registry-first path works)
- [ ] If you see `Resolved via folder scan` instead, registry write was delayed but folder is materialized (acceptable)
- [ ] If you see `WARNING: Windows created suffixed profile 'C:\Users\user1.<machine>'` — that means the ACLs weren't fully wiped and Windows had to create a new SID-folder. Profile detection still resolves it; the rest of the flow proceeds against the suffixed path
- [ ] `Profile source: registry, path: C:\Users\user1` (or matching pair for whichever source resolved)
- [ ] `SID: S-1-5-21-...`
- [ ] `Copied: C:\Users\user1\Documents\zoom-firstrun-setup.ps1`
- [ ] `Shortcut: C:\Users\user1\Desktop\Apply Zoom Settings.lnk`

**Step 7/8 — Configuring per-user Zoom preferences**
- [ ] `Setting Windows dark mode for 'user1'...` then `Dark mode set.` (requires HKU\<SID> to be loaded; if Zoom never logged in interactively the hive may not be mounted — then you see `WARNING: HKU\<SID> not loaded`)
- [ ] `Force-closing Zoom (full process tree)...` then `Zoom closed.`
- [ ] If Zoom.us.ini exists: `Writing dark mode to Zoom.us.ini...` then editing completes
- [ ] If your profile's Zoom data dir exists: `Copied: viper.ini`, etc.
- [ ] If source dir absent: `NOTE: ...Zoom\data not found. Skipping prefs copy.`

**Step 8/8 — Relaunching Zoom as user1**
- [ ] `Zoom launched as user1.` reappears
- [ ] No `relaunch_failed` warning

**Final**
- [ ] `Done. Zoom should appear momentarily.` in green
- [ ] If any warnings were captured: `FIX COMPLETE (with N warning(s))` and each warning listed with `[code] message`
- [ ] If clean: `FIX COMPLETE`
- [ ] Status badge `Done` or `Done (warnings)`
- [ ] Zoom Workplace window visible on screen (a separate Zoom window owned by user1)

### 2.4 Confirm user1 desktop artifacts

Sign out, sign in as `user1` / password `user1`:

- [ ] `C:\Users\user1\Desktop\Apply Zoom Settings.lnk` is present
- [ ] Shortcut icon is the **1132 Fixer logo** (not the blue PowerShell icon)
- [ ] Right-click → Properties: `Target = powershell.exe`, `Arguments = -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user1\Documents\zoom-firstrun-setup.ps1"`
- [ ] `C:\Users\user1\Documents\zoom-firstrun-setup.ps1` present, hash matches packaged copy:
      ```powershell
      Get-FileHash 'C:\Users\user1\Documents\zoom-firstrun-setup.ps1' -Algorithm SHA256
      # Expected: 1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E
      ```

### 2.5 Confirm registry side effects

Back as admin (Win+R `regedit`):

- [ ] `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\<user1 SID>\ProfileImagePath` = `C:\Users\user1`
- [ ] `HKEY_USERS\<user1 SID>\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme` = `0` (REG_DWORD)
- [ ] **No** new entries under any `Policies\Zoom` key in HKLM or HKU (this app must not touch GPO)

---

## Section 3 — Forced failure: Secondary Logon disabled (10 min)

From admin shell **before** running the fix:

```powershell
sc.exe stop seclogon
sc.exe config seclogon start= disabled
Get-Service seclogon  # should show Stopped/Disabled
```

Launch the app, click FIX NOW → Continue.

- [ ] Step 0/8 preflight emits `BLOCK [seclogon_disabled]: Secondary Logon service (seclogon) is Disabled...`
- [ ] Run-fix returns `FIX FAILED: The Secondary Logon service is disabled...` with the exact `sc.exe config seclogon start= demand & sc.exe start seclogon` remediation
- [ ] **`net user user1 /delete` does NOT run** (confirm `user1` still exists and Admins membership unchanged)
- [ ] No `C:\Users\user1` deletion attempted
- [ ] Status badge `Failed` (red)

Restore:
```powershell
sc.exe config seclogon start= demand
sc.exe start seclogon
```

Re-run fix. The flow should proceed normally past preflight.

---

## Section 4 — Forced failure: not elevated (5 min)

The packaged exe has `requireExecutionLevel: admin` in its manifest, so Windows will UAC-prompt on launch. To test the defense-in-depth guard, two options:

**Option A** — Cancel the UAC prompt:
- [ ] App does not launch; no destructive action possible

**Option B** — If you can launch the exe non-elevated via a custom launcher (e.g., remove the manifest with `mt.exe -remove`), then click FIX NOW:
- [ ] FIX NOW button is **disabled** because the renderer's `isElevated()` check failed
- [ ] If you bypass via DevTools console (`window.electronAPI.runFix()`):
  - [ ] First log line is `ERROR: This action requires Administrator. Re-launch the app elevated.`
  - [ ] Returned error code is `not_elevated`
  - [ ] No destructive PS spawn occurs (confirm by `Get-Process powershell` during the call — should not see new instances)

---

## Section 5 — Forced failure: signed in AS user1 (5 min)

Sign out of admin, sign in as user1 (password `user1` if you ran the positive path; otherwise as it stands). Right-click the portable exe → Run as administrator. **Important: enter different admin credentials at the UAC prompt** so the elevated app is admin but the *interactive session* is user1.

Click FIX NOW → Continue.

- [ ] Step 0/8 emits `BLOCK [running_as_target]: You are signed in AS 'user1'.`
- [ ] Run-fix returns `FIX FAILED: You are currently signed in as user1...`
- [ ] No destructive action runs

---

## Section 6 — Packaging sanity (5 min)

Run from project root:

```powershell
# Hash the packaged firstrun
$src = (Get-FileHash 'scripts\zoom-firstrun-setup.ps1' -Algorithm SHA256).Hash
$pkg = (Get-FileHash 'dist\win-unpacked\resources\zoom-firstrun-setup.ps1' -Algorithm SHA256).Hash
"src=$src"
"pkg=$pkg"
"match=$($src -eq $pkg)"

# Verify icon
Test-Path 'dist\win-unpacked\resources\icon.ico'

# Extract and grep asar for forbidden patterns
npx asar extract 'dist\win-unpacked\resources\app.asar' .asar-check
Get-ChildItem -Recurse -File .asar-check | Where-Object {
    $_.FullName -notlike '*node_modules*'
} | ForEach-Object {
    $c = Get-Content $_.FullName -Raw -EA SilentlyContinue
    if ($c -match 'Policies\\Zoom|WOW6432Node\\Policies|user2|mediaSpec|mediaChoice|Downloads') {
        "HIT: $($_.FullName)"
    }
}
Remove-Item .asar-check -Recurse -Force
Test-Path 'asar-check\legacy', 'asar-check\scripts'   # both should be False
```

- [ ] `match=True`
- [ ] icon.ico present
- [ ] Zero `HIT:` lines (no forbidden references in packaged app code)
- [ ] No `legacy/` or `scripts/` directories in the asar

---

## Section 7 — Submit results

Fill in the "B. Test machine" / "C. Positive-path result" / "D. Forced-failure results" sections of the final report when each block above is checked off. Any unchecked acceptance criterion is a regression — file it before shipping.
