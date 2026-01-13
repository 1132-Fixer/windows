# How 1132 Remover Works

A technical guide to what 1132 Remover does and why.

## The Problem

When Zoom bans a user (error 1132), it doesn't just block the account - it fingerprints the device. This means:
- Creating a new account on the same machine gets banned immediately
- Simply uninstalling and reinstalling Zoom doesn't help
- The ban persists across Windows user accounts

## The Solution

1132 Remover performs a **complete device fingerprint wipe** along with Zoom removal, allowing a fresh start.

---

## What Gets Cleaned

### Phase 1: Process Termination
Stops all running Zoom processes to release file locks:
- Main Zoom app (Zoom.exe, Zoomus.exe)
- Screen sharing service (CptHost, CptService)
- Background helpers (aomhost, airhost, zCrashReport)
- Outlook plugins, SDK components, Zoom Rooms
- 50+ process variants

### Phase 2: Uninstall
Runs Zoom's official uninstaller if present:
- Locates Installer.exe in Zoom directories
- Runs silent uninstall (`/uninstall /silent`)
- Verifies Zoom.exe is removed afterward

### Phase 3: Service & Task Cleanup
Removes system-level persistence:
- **Services**: CptService, ZoomCptService, ZoomPresence
- **Scheduled Tasks**: ZoomUpdateTaskMachine, ZoomAutoUpdate

### Phase 4: Registry Cleanup
Removes all Zoom registry entries:

| Location | What's Stored |
|----------|---------------|
| `HKCU\Software\Zoom` | User settings, preferences |
| `HKLM\Software\Zoom` | Machine-wide settings |
| `HKCR\zoommtg` | URL protocol handlers |
| `HKLM\SYSTEM\...\Services\CptService` | Service registration |
| UserAssist | Execution history |
| BAM/DAM | Activity moderator traces |
| MuiCache | Program display names |

### Phase 5: Device Fingerprint Wipe
The critical step - removes device identifiers:

**Telemetry Databases**
- `telemetrydata.db` - Primary device ID
- `zoomus.db` - User/device association

**CptService Folders**
- `C:\ProgramData\CptService` - Screen sharing device ID
- `C:\ProgramData\Zoom CptService`

**Prefetch Files**
- `C:\Windows\Prefetch\*ZOOM*.pf` - Execution history

### Phase 6: Data Folder Deletion
Removes all Zoom data directories:
- `%APPDATA%\Zoom`
- `%LOCALAPPDATA%\Zoom`
- `%PROGRAMDATA%\Zoom`
- `C:\Program Files\Zoom`
- Documents, temp folders, VirtualStore

### Phase 7: System Trace Cleanup
Removes evidence of Zoom execution:
- Jump lists (taskbar recent items)
- Icon cache
- Recycle bin (Zoom files only)
- Windows credentials

### Phase 8: Fresh Install
Downloads and installs clean Zoom:
- Downloads from `zoom.us/client/latest/ZoomInstallerFull.msi`
- Silent install with `msiexec /qn`
- Verifies Zoom.exe exists after install
- Launches Zoom automatically

---

## Verification

After cleanup, the tool verifies:
- Registry keys are gone
- Fingerprint locations are wiped
- Folders are deleted
- No Zoom processes running (unless reinstalled)

The session ends with a clear verdict: **All Clean** or specific failures listed.

---

## Logging

Every operation is logged with timestamps:
```
[2026-01-13 10:30:15] [SECTION] Registry Cleanup
[2026-01-13 10:30:15] [INFO] Checking HKCU\Software\Zoom
[2026-01-13 10:30:15] [OK] Deleted registry key: HKCU\Software\Zoom
```

Logs are saved to: `%LOCALAPPDATA%\1132-Remover\logs\`

---

## CLI Mode

For automation or scripting:

```bash
# Full reset with reinstall
1132-remover.exe --cli --full-reset

# Reset without reinstall
1132-remover.exe --cli --full-reset --no-reinstall

# Skip uninstall (just wipe fingerprint)
1132-remover.exe --cli --full-reset --no-uninstall
```

Exit codes:
- `0` - Success, all clean
- `1` - Completed with issues or failures

---

## Requirements

- **Windows 10/11** (64-bit)
- **Administrator privileges** - Required for:
  - Service deletion
  - Prefetch cleanup
  - HKLM registry access
  - ProgramData cleanup

The tool will warn if not running as admin but can still perform user-level cleanup.

---

## Safety

The tool **only** targets Zoom-related data:
- No system files modified
- No other applications affected
- Credentials cleanup limited to Zoom entries
- Recycle bin cleanup filters for Zoom files only

All operations are logged for transparency.
