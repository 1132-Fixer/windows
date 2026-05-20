# QA execution plan — 1132 Fixer v5.3.0

The single sign-off packet for v5.3.0. Run every section in order. Stop and report at the first STOP-SHIP condition (section H).

Expected reference values used throughout:

| Artifact | SHA256 |
|---|---|
| `zoom-firstrun-setup.ps1` (source = packaged) | `1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E` |
| `icon.ico` (source = packaged) | `B1B5D9E516751A3657F156FAD0E30CBE2DE9853BBE21B11DE41E20C29AAB04B7` |
| Zoom executable path | `C:\Program Files\Zoom\bin\Zoom.exe` |
| App version (in footer badge) | `v5.3.0` |
| Target account name / password | `user1` / `user1` |
| Local Administrators well-known SID | `S-1-5-32-544` |

Two QA-grade build artifacts to test (signing disabled — production must be re-built signed in CI before public release):
- `dist\1132 Fixer Portable 5.3.0.exe`
- `dist\1132 Fixer Setup 5.3.0.exe` (NSIS installer + `latest.yml` + `.blockmap`)

---

## A. Final QA runbook

### A.1 What you need before starting
- A real Windows 10 (1809+) or Windows 11 machine. **Not the developer machine that built the artifacts.**
- An administrator account other than `user1` to sign in as for sections 1–4 and section 6.
- Zoom Workplace installed machine-wide at `C:\Program Files\Zoom\bin\Zoom.exe`. The per-user installer at `%LOCALAPPDATA%\Zoom\bin\Zoom.exe` is **not** supported.
- The two artifacts above, copied to the test machine (e.g. `C:\Temp\1132fixer\`).
- An admin PowerShell window for the diagnostic commands.

### A.2 Recommended order
1. **Portable first** — it's faster, has no install step, and gives a clean signal whether the runtime logic works.
2. **If portable passes:** repeat the full plan with the NSIS installer. NSIS install/uninstall is a separate failure surface (registry uninstall keys, Start Menu shortcuts, auto-update wiring).
3. **CI signed release** (section E) only after both QA artifacts pass.

### A.3 Pass / Warning-pass / Fail
- **Pass** — every acceptance box in the relevant section is checked, no warning surfaced in the UI.
- **Warning-pass** — every acceptance box is checked, but `FIX COMPLETE (with N warning(s))` shows up at the end. **Only acceptable** if every warning is in the known-acceptable list (section G). Anything else → Fail.
- **Fail** — any acceptance box is unchecked, or the UI shows an unexpected warning/error/blocker, or the test machine ended up in a state worse than it started (e.g. user1 deleted but not recreated, profile orphaned, Zoom not launching).

### A.4 When to click which button

| Situation | Button |
|---|---|
| Just opened the app | **Check Environment** first |
| Check Environment showed blockers | Fix the blockers, click Check Environment again — do NOT click FIX NOW |
| Check Environment said `ENVIRONMENT OK` | **FIX NOW** (destructive confirmation dialog appears) |
| Destructive confirmation appeared | Read the bullet list, then click **Continue** to proceed or **Cancel** to back out (Cancel is default — pressing Enter cancels) |
| Already ran the fix, need to re-launch Zoom as user1 later | **Desktop Shortcut** (creates a one-click re-launcher on your own desktop) |

### A.5 How to record evidence
Use section D's template. Capture every value before clicking FIX NOW. Capture warnings exactly as the UI shows them (with `[code]` prefix).

### A.6 Restoring the test machine
- After a positive-path run: nothing to restore. user1 will be in a freshly-reset state, which is the goal of the app.
- After a `seclogon`-disabled forced-failure: re-enable per section C.1's restore step. **Do not skip this** — leaving seclogon disabled may break other apps on the test machine.
- After a not-elevated forced-failure: nothing to restore. No state was touched.
- After a signed-in-as-user1 forced-failure: nothing to restore. Sign back into your normal admin account.

---

## B. Positive-path checklist

> Run this section twice — once for the **portable**, once for the **NSIS installer** (after installing via `1132 Fixer Setup 5.3.0.exe`).

### B.0 Capture starting state
From the project root (or wherever you copied `tools/qa/qa-context.ps1`), in an **admin** PowerShell:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\qa-context.ps1
```
Paste output into the evidence template (section D).

### B.1 Launch & basic UI
- [ ] Right-click the exe → **Run as administrator**. UAC prompt appears, click Yes.
- [ ] App window opens, status badge says **Ready** (green dot).
- [ ] Bottom-right badges: green **Administrator** + grey **v5.3.0**.
- [ ] Three buttons visible: **FIX NOW** (gold), **Check Environment** (grey), **Desktop Shortcut** (grey).

### B.2 Check Environment (non-destructive)
- [ ] Click **Check Environment**. Status badge changes to **Checking...** then **Ready** (or **Blocked**).
- [ ] Each of these required tools shows `OK`: `powershell.exe`, `taskkill.exe`, `robocopy.exe`, `icacls.exe`, `takeown.exe`, `net.exe`, `reg.exe`.
- [ ] Optional tools `quser.exe` and `logoff.exe` show `OK` or `opt` (the latter is a known-acceptable warning on Win11 Home — see section G).
- [ ] `Zoom path:` ends with `Zoom.exe` and points to an existing file.
- [ ] `Firstrun script:` points to a file whose SHA256 matches the expected hash (run `Get-FileHash` on the path shown).
- [ ] `Interactive user:` is **not** `user1`.
- [ ] `Elevated:` `YES`.
- [ ] `Secondary Logon:` Status `Running` (or `Stopped`), StartType **not** `Disabled`.
- [ ] No `BLOCKER` lines.
- [ ] Final line: `ENVIRONMENT OK — safe to click FIX NOW.`

### B.3 Confirmation dialog
- [ ] Click **FIX NOW**. Dialog appears with title `Confirm Fix - Destructive`.
- [ ] Dialog detail enumerates: log off active user1 session, delete account, delete `C:\Users\user1`, wipe ProfileList, recreate user1 password `user1`, launch Zoom, deploy Apply Zoom Settings helper.
- [ ] **Cancel is the default button.** Pressing **Enter** must cancel. Verify by pressing Enter once — dialog must close with no destructive action.
- [ ] Click **FIX NOW** again, then click **Continue** in the dialog.

### B.4 Streaming log — destructive flow
Tick each line **as you see it** appear in the streamed log:

**Step 0/8 preflight** (same content as B.2, repeated):
- [ ] All 7 required tools `OK`
- [ ] No `BLOCK [...]` lines

**Step 1/8 — Terminating user1 processes/sessions**
- [ ] `taskkill /F /FI USERNAME eq user1` ran (either `SUCCESS: ...` or `ERROR: not found` — both pass)
- [ ] One of: `No active sessions for user1.` / `Found N session(s)` + `Logged off N session(s).` / `quser.exe unavailable - skipping session enumeration (taskkill still runs).`
- [ ] No silent failures: any `WARNING:` line names a specific failure mode (QUSER_EXIT=, LOGOFF_FAIL=, etc.)

**Step 2/8 — Removing leftover suffixed profile folders**
- [ ] Either `None found.` or `Found: C:\Users\user1.<machine>` + `Deleting:` + `RESULT: gone in N.Ns`

**Step 3/8 — Removing existing account and profile**
- [ ] If user1 existed: `Account deleted.`
- [ ] If `C:\Users\user1` existed: `Deleting: C:\Users\user1`, `RESULT: gone in N.Ns`, `Profile folder deleted.`
- [ ] `Cleaning ProfileList registry entries for 'user1'...` + `Removing ProfileList entry: <SID>  ->  C:\Users\user1` + `Cleaned N ProfileList entries.`
- [ ] **No `Removing ProfileList entry:` line names any path other than `C:\Users\user1` or `C:\Users\user1.*`.** If you see another path, STOP and capture screenshot — see section H.

**Step 4/8 — Creating account user1 and verifying admin membership**
- [ ] `Account 'user1' created.`
- [ ] `Add-LocalGroupMember OK.` (or fallback line)
- [ ] `user1 in Administrators: YES (check method: Get-LocalGroupMember)`
- [ ] If `NO`: this becomes a Warning-pass with code `admin_add_unverified` — verify in section G whether it's acceptable for your environment.

**Step 5/8 — Launching Zoom as user1**
- [ ] `Zoom launched as user1.`
- [ ] Within 6 seconds: `Confirmed: Zoom.exe is running as user1.`
- [ ] If `Zoom.exe was not detected running as user1 within 6s of launch.` appears — Warning-pass with `zoom_not_running_after_launch`. STOP and capture: it usually means Zoom died on startup (AV, missing dependency, broken install). Not shippable until investigated.

**Step 6/8 — Resolving user1 profile path**
- [ ] One of these MATCH lines:
  - [ ] `Resolved via registry: C:\Users\user1` ← preferred (registry-first works)
  - [ ] `Resolved via folder scan: C:\Users\user1` ← acceptable (registry lagged)
  - [ ] `WARNING: Windows created suffixed profile 'C:\Users\user1.<machine>'` ← acceptable (ACLs lingered; flow continues against the new path)
- [ ] `Profile source: <source>, path: C:\Users\user1` (or matching pair)
- [ ] `SID: S-1-5-21-...`
- [ ] `Copied: C:\Users\user1\Documents\zoom-firstrun-setup.ps1`
- [ ] `Shortcut: C:\Users\user1\Desktop\Apply Zoom Settings.lnk`

**Step 7/8 — Configuring per-user Zoom preferences**
- [ ] `Setting Windows dark mode for 'user1'...` + `Dark mode set.` (OR `WARNING: HKU\<SID> not loaded; skipping Windows dark mode.` — Warning-pass; happens when Zoom hasn't fully loaded the user hive yet)
- [ ] `Force-closing Zoom (full process tree)...` + `Zoom closed.`
- [ ] If `Zoom.us.ini` exists: `Writing dark mode to Zoom.us.ini...`
- [ ] If your profile's `~\AppData\Roaming\Zoom\data` exists: `Copied: viper.ini`, `Copied: transcoding.ini`, etc. (only the files that exist locally)
- [ ] If source dir absent: `NOTE: ...Zoom\data not found. Skipping prefs copy.`

**Step 8/8 — Relaunching Zoom**
- [ ] `Zoom launched as user1.` (second time)
- [ ] No `relaunch_failed` warning

**Final UI state**
- [ ] Line `Done. Zoom should appear momentarily.` in green
- [ ] Either `FIX COMPLETE` (clean) or `FIX COMPLETE (with N warning(s))` followed by `• [code] message` for each warning
- [ ] Status badge: `Done` or `Done (warnings)`
- [ ] Zoom Workplace window visible on screen, owned by user1 (verify with Task Manager → Details → right-click columns → enable "User name")
- [ ] Optional: app prompts you to create a "Launch Zoom as user1" shortcut on your own desktop

### B.5 Sign in as user1 to verify desktop artifacts
- [ ] Sign out of admin. Sign in as `user1` / `user1`.
- [ ] `C:\Users\user1\Desktop\Apply Zoom Settings.lnk` is present.
- [ ] Shortcut icon is the **1132 Fixer logo** (not the blue PowerShell square). Right-click → Properties to confirm `Icon Location`.
- [ ] Properties → Target = `powershell.exe`, Arguments = `-NoProfile -ExecutionPolicy Bypass -File "C:\Users\user1\Documents\zoom-firstrun-setup.ps1"`.
- [ ] In PowerShell:
  ```powershell
  (Get-FileHash 'C:\Users\user1\Documents\zoom-firstrun-setup.ps1' -Algorithm SHA256).Hash
  ```
  Output must equal `1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E`.

### B.6 Verify registry side effects (back as admin)
Open `regedit`:
- [ ] `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\<user1 SID>\ProfileImagePath` = `C:\Users\user1`
- [ ] `HKEY_USERS\<user1 SID>\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme` = `0` (REG_DWORD)
- [ ] **No new entries** under `HKLM\SOFTWARE\Policies\Zoom`, `HKLM\SOFTWARE\WOW6432Node\Policies\Zoom`, or `HKEY_USERS\<user1 SID>\SOFTWARE\Policies\Zoom`. (The app must not touch GPO.)

---

## C. Forced-failure checklists

Each test verifies the destructive flow stops cleanly before any account/profile change. Do these **after** the positive-path test (so you have a known-good baseline) and **on the QA machine only**.

### C.1 Secondary Logon disabled

**Setup** (admin PowerShell):
```powershell
sc.exe stop seclogon
sc.exe config seclogon start= disabled
Get-Service seclogon   # expect: Status=Stopped, StartType=Disabled
```

**Test**:
- [ ] Launch app elevated → click **Check Environment**.
- [ ] Output includes `BLOCKER` line: `[seclogon_disabled] Secondary Logon service (seclogon) is Disabled. Start-Process -Credential cannot run. Run "sc.exe config seclogon start= demand" from an admin shell and retry.`
- [ ] Final line: `ENVIRONMENT NOT READY — see blockers above.`
- [ ] **FIX NOW** still clickable, but if you click and Continue: the streamed log shows `BLOCK [seclogon_disabled]:...` and then `FIX FAILED: The Secondary Logon service is disabled...` — **and nothing else** (no Step 1/2/3/... headers).
- [ ] Verify in another shell that user1 is unchanged: `Get-LocalUser user1` still returns the original SID; `Test-Path 'C:\Users\user1'` still True if it was True before.

**Restore** (admin PowerShell — do not skip):
```powershell
sc.exe config seclogon start= demand
sc.exe start seclogon
Get-Service seclogon   # expect: Status=Running, StartType=Manual
```

- [ ] Click **Check Environment** again. Final line: `ENVIRONMENT OK — safe to click FIX NOW.`

### C.2 Not elevated

The packaged exe has `requestExecutionLevel: admin` in its manifest, so Windows shows a UAC prompt on launch. To exercise the defense-in-depth runtime guard you need a non-elevated context.

**Option A — UAC cancel** (simplest):
- [ ] Right-click the exe → Run as administrator → **click No on UAC**.
- [ ] App does not launch. No destructive action possible.

**Option B — dev mode** (requires the source tree):
- [ ] In a **non-admin** PowerShell window from the project root:
  ```powershell
  npm start
  ```
- [ ] The app launches in dev mode without admin token.
- [ ] Status badge says **Not Admin**. **FIX NOW** is disabled, **Check Environment** is enabled.
- [ ] Click **Check Environment** — the output shows `Elevated: NO` and a `BLOCKER` `[not_elevated]`.
- [ ] Open DevTools (`Ctrl+Shift+I`) → Console → type `window.electronAPI.runFix().then(r => console.log(r))`.
- [ ] Returned object: `{ success: false, error: 'not_elevated' }`.
- [ ] Verify in `Get-Process powershell` that no new PowerShell instances spawned during the call.

### C.3 Signed in AS user1

This is the most invasive forced-failure test (it requires switching Windows sessions). Do it last.

**Setup**:
- [ ] Sign out of your current admin account.
- [ ] Sign in as `user1` / `user1`. (If user1's password was changed by an earlier positive-path run, the password is `user1`.)
- [ ] On the user1 desktop, right-click the exe → **Run as administrator**. UAC prompts; user1 must have admin rights to elevate (the positive-path run added them).

**Test**:
- [ ] App opens elevated. Status badge says **Ready**.
- [ ] Click **Check Environment**.
- [ ] Output line `Interactive user: user1`.
- [ ] `BLOCKER` line: `[running_as_target] You are signed in AS 'user1'. Sign in as a different administrator.`
- [ ] Final line: `ENVIRONMENT NOT READY — see blockers above.`
- [ ] Click **FIX NOW** → Continue. Log shows `BLOCK [running_as_target]:...` and `FIX FAILED: You are currently signed in as user1...` — **and nothing else**.
- [ ] Verify in another shell that user1 was not deleted: still able to switch user windows etc.

**Restore**: sign out of user1, sign back into your normal admin account. No state to revert.

---

## D. Evidence template

Copy this block and fill in. Paste the completed block into the v5.3.0 release PR description (or the GitHub release notes draft).

```
=== 1132 Fixer v5.3.0 — Manual QA evidence ===

Tester:                       ____________________
Date / time (ISO):            ____________________
Test machine name:            ____________________
Windows edition:              ____________________
Windows build:                ____________________
Current Windows user:         ____________________   (must NOT be user1)
Zoom install path present:    YES / NO   (path: C:\Program Files\Zoom\bin\Zoom.exe)
Secondary Logon status:       ____________________  /  StartType ____________________
LanmanServer status:          ____________________
user1 starting state:         exists / absent / suffixed
user1 SID (if any):           ____________________
user1 in Admins (start):      YES / NO / n/a

--- Artifact under test ---
Type:                         portable / nsis-installer
File:                         ____________________
Size (bytes):                 ____________________
SHA256:                       ____________________
Signed:                       yes / no
If signed: signtool result:   ____________________

--- Check Environment (B.2) ---
Required tools all OK:        YES / NO   (list any MISS: ______ )
Optional tools status:        ____________________
Zoom path resolved:           YES / NO
Firstrun script resolved:     YES / NO
Firstrun SHA256 on disk:      ____________________   (must = 1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E)
Elevated:                     YES / NO
seclogon:                     ____________________
Final line:                   ENVIRONMENT OK / ENVIRONMENT NOT READY

--- Positive path (B.3 / B.4) ---
Confirmation dialog appeared: YES / NO
Cancel was default:           YES / NO
Step 1 logoff:                __ session(s) found, __ logged off, notes: ______
Step 2 suffixed cleanup:      __ folder(s) removed
Step 3 account delete:        YES / NO / n/a (didn't exist)
Step 3 profile delete:        YES / NO / n/a
Step 3 ProfileList cleaned:   __ entries (target: only user1 / user1.* paths)
Step 4 account created:       YES / NO
Step 4 admin verified:        YES / NO   (method: ______ )
Step 5 Zoom launched:         YES / NO
Step 5 Zoom owner confirmed:  YES (within __ s) / NO
Step 6 profile source:        registry / folder / folder-suffixed
Step 6 path:                  ____________________
Step 6 firstrun copied:       YES / NO
Step 6 shortcut created:      YES / NO
Step 7 dark mode set:         YES / NO / skipped
Step 7 Zoom.us.ini edited:    YES / NO / seeded
Step 7 prefs mirrored:        viper=__ transcoding=__ kvs.enc.db=__
Step 8 relaunch:              YES / NO
Final status:                 FIX COMPLETE / FIX COMPLETE (with N warnings)  N=__
Warnings list (codes):        [ ______, ______, ______ ]
Warnings deemed acceptable:   YES / NO   (cross-check against section G)

--- User1 desktop verification (B.5) ---
Shortcut on user1 desktop:    YES / NO
Shortcut icon = 1132 Fixer:   YES / NO
Shortcut target/arguments:    YES / NO
Firstrun hash on user1 dt:    ____________________   (must match expected)

--- Registry verification (B.6) ---
ProfileImagePath set:         YES / NO
AppsUseLightTheme = 0:        YES / NO / skipped
No new Policies\Zoom keys:    YES / NO   <-- STOP-SHIP if NO

--- Forced failures ---
C.1 seclogon disabled:        PASSED / FAILED   error code surfaced: ____________________
    no destructive action:    CONFIRMED / NOT CONFIRMED
    seclogon restored:        YES / NO
C.2 not elevated:             PASSED / FAILED   error code surfaced: ____________________
    no destructive action:    CONFIRMED / NOT CONFIRMED
C.3 signed in as user1:       PASSED / FAILED   error code surfaced: ____________________
    no destructive action:    CONFIRMED / NOT CONFIRMED

--- Screenshots / log excerpts ---
[ attach: final UI state, confirmation dialog, Check Environment with seclogon disabled, ProfileList registry view ]

--- Recommendation (per section F rules) ---
SHIP / SHIP WITH DOCUMENTED LIMITATIONS / DO NOT SHIP
Reason:                       ____________________

Tester signature:             ____________________   Date: ______
```

---

## E. Signed-release verification checklist

This section runs in CI (or on a developer machine with the production signing cert). It is **not** part of manual QA, but no v5.3.0 release ships without it.

### E.1 Build the signed release
```powershell
# CI environment must have these set:
$env:CSC_LINK            = "<path-or-base64-or-url-to-.pfx>"  # or WIN_CSC_LINK
$env:CSC_KEY_PASSWORD    = "<pfx-password>"                    # or WIN_CSC_KEY_PASSWORD
$env:GH_TOKEN            = "<github-token-with-repo-scope>"    # for --publish always

npm ci
npm run release   # → electron-builder --win nsis --x64 --publish always
```

- [ ] Command exits 0.
- [ ] `dist\1132 Fixer Setup 5.3.0.exe` was uploaded to the GitHub release.
- [ ] `dist\latest.yml` and `dist\1132 Fixer Setup 5.3.0.exe.blockmap` were uploaded alongside (auto-updater wiring).

### E.2 Authenticode verify
```powershell
# From any Windows machine with signtool available (Windows SDK):
signtool verify /pa /v "dist\1132 Fixer Setup 5.3.0.exe"
```
- [ ] Final line: `Successfully verified: dist\1132 Fixer Setup 5.3.0.exe`
- [ ] Certificate subject matches your code-signing identity (currently `High Texas`).
- [ ] Timestamp present (or, if your CA doesn't timestamp by default, intentional).

### E.3 Re-verify resources after signing
Signing the outer exe doesn't change the asar or extra resources. Confirm anyway:
```powershell
# Extract the NSIS installer to a scratch dir using 7-Zip or a temporary install
7z x "dist\1132 Fixer Setup 5.3.0.exe" -o"C:\Temp\release-check" -y

# Verify resources
$expected = '1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E'
$actual   = (Get-FileHash 'C:\Temp\release-check\$PLUGINSDIR\app-64.7z' -Algorithm SHA256).Hash
"app-64.7z SHA256 = $actual"
# Then 7z x app-64.7z, then verify resources\zoom-firstrun-setup.ps1 hash equals $expected
```
- [ ] Packaged `resources\zoom-firstrun-setup.ps1` SHA256 = `1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E`
- [ ] Packaged `resources\icon.ico` SHA256 = `B1B5D9E516751A3657F156FAD0E30CBE2DE9853BBE21B11DE41E20C29AAB04B7`

### E.4 Forbidden-pattern grep on the signed asar
```powershell
npx asar extract "C:\Temp\release-check\<...>\resources\app.asar" .asar-check
$pattern = 'Policies\\Zoom|WOW6432Node\\Policies|HKLM:\\\\SOFTWARE\\\\Policies|user2|mediaSpec|mediaChoice|admin-reset'
Get-ChildItem -Recurse -File .asar-check |
  Where-Object { $_.FullName -notlike '*node_modules*' } |
  Select-String -Pattern $pattern -List |
  Select-Object Path
Remove-Item .asar-check -Recurse -Force
```
- [ ] **Zero** results from the Select-String. Any hit is a STOP-SHIP.
- [ ] Re-confirm no `tools\`, `docs\`, `legacy\`, `scripts\`, `*.log`, `*.bat`, or `*.ps1` inside the asar.

### E.5 Auto-updater spot check
```powershell
Get-Content dist\latest.yml | Select-Object -First 8
```
- [ ] `version: 5.3.0`
- [ ] `files:` entry with `url:` `1132-Fixer-Setup-5.3.0.exe`
- [ ] `sha512:` non-empty, matches the file (`Get-FileHash ... -Algorithm SHA512`)
- [ ] `path:` matches `url:`
- [ ] `releaseDate:` recent

---

## F. Release decision rules

| Outcome | All conditions required |
|---|---|
| **SHIP** | Section B passes clean OR with only known-acceptable warnings (section G); Sections C.1, C.2, C.3 all PASS with no destructive action; Sections E.1–E.5 all checked; no STOP-SHIP condition from section H triggered. |
| **SHIP WITH DOCUMENTED LIMITATIONS** | Same as SHIP except section B warning-passed with one or more warnings that map to section G. Each warning must be called out in the release notes under "Known limitations". |
| **DO NOT SHIP** | Any STOP-SHIP condition (section H) tripped. **OR** any section C destructive-action-suppression check failed. **OR** any section E hash/forbidden-pattern check failed. |

Document the decision and rationale in the evidence template (section D) and in the v5.3.0 release notes.

---

## G. Known acceptable warnings

These warnings cause a **Warning-pass**, not a Fail, provided every other acceptance box is checked. They must be listed in the release notes when they occur.

| Code | When it appears | Why it's acceptable | What user should know |
|---|---|---|---|
| `optional_tool_missing` (`quser.exe` / `logoff.exe`) | Win11 Home and some stripped SKUs ship without `quser`/`logoff`. | `taskkill /FI USERNAME eq user1` already terminates user1 processes. The session-logoff step is best-effort. | "On Windows Home, the active session for user1 may persist until next sign-out. Processes are still terminated." |
| `seclogon_not_running` | `seclogon` exists but `Stopped` and not `Disabled`. | Windows auto-starts `seclogon` on first `Start-Process -Credential` call. | None — Windows handles this transparently. |
| `logoff_partial` | `quser` enumerated sessions but couldn't log one off (e.g. session is the console). | Profile-folder deletion may need a reboot if files are still locked, but the rest of the fix proceeds. | "If profile deletion fails with `delete_profile_failed`, reboot once and re-run." |
| `admin_add_unverified` | Account was created and `Add-LocalGroupMember`/`net localgroup` returned 0, but `Get-LocalGroupMember` couldn't see user1 in the list. | Zoom launches as user1 regardless. user1 may need manual admin if it ever updates Zoom. | "Open `lusrmgr.msc` and add user1 to Administrators manually if needed." |
| `sid_unresolved` | `NTAccount.Translate` failed for user1. | Per-user dark mode + Zoom.us.ini edit are skipped, but Zoom still launches. | "Dark mode wasn't applied — user1 can switch themes manually." |
| `pref_copy_failed` | `viper.ini` / `transcoding.ini` / `zoomus.zmdb.kvs.enc.db` couldn't be copied (e.g. source file locked). | These are non-critical device/preference files. | "user1 may need to re-select camera/audio devices on first Zoom launch." |
| `ini_seed_failed` | Could not create or write `Zoom.us.ini` in the new profile. | Zoom creates its own on first run; dark mode lost. | "Dark mode skipped — user1 can switch theme manually." |
| `relaunch_failed` | Step 8 relaunch failed (first launch succeeded). | Initial launch already triggered profile creation; user1 can open Zoom from Start menu. | "Open Zoom manually as user1 after sign-in." |

---

## H. Stop-ship conditions

If **any** of the following occur, STOP. Do not ship. File the regression before retrying.

| # | Condition | Why it's a stop-ship |
|---|---|---|
| 1 | Destructive confirmation dialog does **not** appear before any destructive action runs. | Safety contract broken. |
| 2 | Cancel is **not** the default button in the confirmation dialog. | Safety contract broken. |
| 3 | Section C.1 (seclogon disabled): any destructive log header (`[1/8] Terminating...`, `[3/8] Removing existing account...`, etc.) appears, OR user1 state changes. | Preflight blocker did not actually block. |
| 4 | Section C.2 (not elevated): the destructive flow runs to any step header, OR user1 state changes. | Defense-in-depth elevation guard failed. |
| 5 | Section C.3 (signed in as user1): the destructive flow runs to any step header, OR user1 is deleted. | Guard against self-destruction failed. |
| 6 | Step 3 ProfileList cleanup logs `Removing ProfileList entry:` for any path that is not `C:\Users\user1` or `C:\Users\user1.*`. | The cleanup targeted the wrong user. |
| 7 | After a positive-path run, an account other than user1 was deleted, modified, or had its profile altered. | Scope violation. |
| 8 | After a positive-path run, `HKLM\SOFTWARE\Policies\Zoom` or `HKLM\SOFTWARE\WOW6432Node\Policies\Zoom` or `HKU\<user1 SID>\SOFTWARE\Policies\Zoom` has any new entry. | Group-policy exclusion contract violated. |
| 9 | After a positive-path run, files matching `*.gif`/`*.jpg`/`*.mp4`/etc. were copied into `C:\Users\user1\Desktop\Documents\Downloads\Pictures\...` from the admin's profile. | Media-transfer exclusion contract violated. |
| 10 | The packaged `resources\zoom-firstrun-setup.ps1` SHA256 does **not** match `1D352AB10344E02C2B88796508AE4D0B414C53CD058EF0EEAC36A1173366D39E`. | Wrong / tampered firstrun script ships. |
| 11 | The packaged `resources\icon.ico` SHA256 does **not** match `B1B5D9E516751A3657F156FAD0E30CBE2DE9853BBE21B11DE41E20C29AAB04B7`. | Wrong icon ships; user1 desktop shortcut won't render as 1132 Fixer. |
| 12 | Section E.4 forbidden-pattern grep returns any HIT on the **signed** asar. | Forbidden code shipped in production artifact. |
| 13 | `signtool verify /pa /v` fails on the signed installer. | Unsigned production artifact. |
| 14 | `latest.yml` or `.blockmap` missing from the GitHub release. | Auto-updater broken for existing users. |
| 15 | Zoom.exe is **not** owned by user1 after Step 5 of the positive-path run (verify in Task Manager → Details → User name column). | The core 1132-bypass behavior didn't happen — fix isn't actually fixing anything. |
| 16 | Apply Zoom Settings shortcut on user1 desktop has the **PowerShell** icon (blue square) instead of the 1132 Fixer icon. | `getIconPath()` resolved wrong path; production users will see a confusing shortcut. |

---

## Done

If sections B (×2 artifacts), C.1, C.2, C.3, and E.1–E.5 all pass per section F, the v5.3.0 release is ready. Tag, publish, and update the version badge in `package.json` for the next dev cycle.
