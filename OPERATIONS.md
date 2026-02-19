# 1132 Remover - Complete Operations Reference

This document lists all processes, files, registry keys, scheduled tasks, services, and system operations performed by the 1132 Remover application.

---

## EXECUTION ORDER (Quick Reset & Reinstall)

1. Kill all Zoom processes
2. Uninstall Zoom
3. Remove Zoom services
4. Remove scheduled tasks
5. Clean registry
6. Delete all Zoom data folders
7. Clean prefetch files
8. Deep clean system traces (firewall, MUI cache, DNS)
9. Download fresh Zoom installer
10. Install Zoom
11. Cleanup installer
12. Launch Zoom (simple version only)

---

## 1. PROCESSES KILLED

### Main Zoom Workplace Processes
- `Zoom.exe`
- `Zoomus.exe`
- `Zoom_launcher.exe`
- `ZoomHybridConf.exe`
- `zSafeChecker.exe`

### Screen Sharing / Companion Processes
- `CptHost.exe`
- `CptService.exe`
- `CptControl.exe`
- `CptInstall.exe`

### SDK Renamed Variants
- `zcscpthost.exe`
- `zCSCptService.exe`
- `zcsairhost.exe`

### Audio/Video Optimization
- `aomhost.exe`
- `aomhost64.exe`
- `airhost.exe`

### Crash Reporting
- `zCrashReport.exe`
- `zCrashReport64.exe`

### Outlook Integration
- `ZoomOutlookIMPlugin.exe`
- `ZoomOutlookMAPI.exe`
- `ZoomOutlookMAPI64.exe`

### Document/Media Processing
- `ZoomDocConverter.exe`
- `zTscoder.exe`

### Updater/Installer
- `zUpdater.exe`
- `ZoomInstaller.exe`
- `Installer.exe`

### Web/CEF Components
- `ZoomWebHost.exe`
- `zWebview2Agent.exe`
- `zCefAgent.exe`
- `msedgewebview2.exe`

### SDK/Messenger
- `ZoomSDKMessenger.exe`

### Zoom Rooms Processes
- `ZoomRooms.exe`
- `zrshell.exe`
- `Controller.exe`
- `DigitalSignage.exe`
- `zrairhost.exe`
- `zrcpthost.exe`
- `bcairhost.exe`
- `conmon_server.exe`
- `mDNSResponder.exe`
- `ptp.exe`
- `ZAAPI.exe`
- `zCECHelper.exe`
- `zJob.exe`
- `zPrinterAgent.exe`
- `ZR3rdHW.exe`
- `zrusplayer.exe`
- `apec3.exe`
- `notification_helper.exe`

### VDI Processes
- `ZoomVDITool.exe`
- `zWspExtension.exe`
- `ZoomVDIPluginManagement.exe`

### Process Kill Methods (run 3x each)
1. `taskkill /F /IM {process}`
2. `taskkill /F /T /IM {process}` (tree kill with children)
3. PowerShell: `Get-Process | Where-Object { $_.Name -like '*zoom*' } | Stop-Process -Force`
4. WMIC: `wmic process where "name like '%zoom%'" delete`

---

## 2. WINDOWS SERVICES

### Services Stopped
- `Zoom Sharing Service`
- `CptService`
- `ZoomCptService`
- `zCSCptService`
- `ZoomRooms`

### Services Deleted
- `CptService`
- `ZoomCptService`
- `Zoom Sharing Service`

### Commands Used
```cmd
net stop "Zoom Sharing Service"
net stop "CptService"
sc stop CptService
sc delete CptService
sc delete ZoomCptService
sc delete "Zoom Sharing Service"
```

---

## 3. SCHEDULED TASKS DELETED

- `Zoom`
- `ZoomUpdateTaskMachine`
- `ZoomUpdateTaskUserS-*`
- `ZoomInstallUpdate`
- `ZoomGifCollector`
- `ZoomCleaner`
- `ZoomAutoUpdate`
- Any task with "Zoom" in the name (via PowerShell)

### Commands Used
```cmd
schtasks /delete /tn "Zoom" /f
schtasks /delete /tn "ZoomUpdateTaskMachine" /f
```
```powershell
Get-ScheduledTask | Where-Object {$_.TaskName -like '*Zoom*'} | Unregister-ScheduledTask -Confirm:$false
```

---

## 4. REGISTRY KEYS DELETED

### HKCU (Current User)
- `HKCU\Software\Zoom`
- `HKCU\Software\ZoomUMX`
- `HKCU\Software\zoom.us`
- `HKCU\Software\Zoom Video Communications`
- `HKCU\Software\Zoom Workplace`
- `HKCU\Software\ZoomGifCollector`
- `HKCU\Software\CptService`
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (value: "Zoom")
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (value: "ZoomUMX")
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX`
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zoom`

### HKLM (Local Machine)
- `HKLM\Software\Zoom`
- `HKLM\Software\ZoomUMX`
- `HKLM\Software\zoom.us`
- `HKLM\Software\Zoom Video Communications`
- `HKLM\Software\Zoom Workplace`
- `HKLM\Software\CptService`
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX`
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zoom`
- `HKLM\SYSTEM\CurrentControlSet\Services\CptService`
- `HKLM\SYSTEM\CurrentControlSet\Services\ZoomCptService`

### WOW6432Node (32-bit on 64-bit)
- `HKLM\Software\WOW6432Node\Zoom`
- `HKLM\Software\WOW6432Node\ZoomUMX`
- `HKLM\Software\WOW6432Node\zoom.us`

### MUI Cache (Full Reset Only)
- `HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache` (entries containing "zoom")

### App Compatibility Flags (Full Reset Only)
- `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` (entries containing "zoom")

---

## 5. WINDOWS CREDENTIALS DELETED

- `zoom.us`
- `Zoom`
- `ZoomVideo`
- `ZoomUMX`
- `ZoomWorkplace`

### Command Used
```cmd
cmdkey /delete:zoom.us
cmdkey /delete:Zoom
cmdkey /delete:ZoomVideo
cmdkey /delete:ZoomUMX
cmdkey /delete:ZoomWorkplace
```

---

## 6. DIRECTORIES/FILES DELETED

### AppData\Roaming
- `%APPDATA%\Zoom`
- `%APPDATA%\Zoom Meetings`
- `%APPDATA%\zoomus`
- `%APPDATA%\ZoomLogs`
- `%APPDATA%\ZoomUMX`
- `%APPDATA%\zoom.us`
- `%APPDATA%\Zoom Workplace`
- `%APPDATA%\ZoomOutlookPlugin`
- `%APPDATA%\ZoomGifCollector`
- `%APPDATA%\Zoom VDI`

### AppData\Local
- `%LOCALAPPDATA%\Zoom`
- `%LOCALAPPDATA%\zoomus`
- `%LOCALAPPDATA%\ZoomLogs`
- `%LOCALAPPDATA%\ZoomUMX`
- `%LOCALAPPDATA%\zoom.us`
- `%LOCALAPPDATA%\Zoom Workplace`
- `%LOCALAPPDATA%\ZoomOutlookPlugin`
- `%LOCALAPPDATA%\ZoomGifCollector`
- `%LOCALAPPDATA%\Zoom VDI`
- `%LOCALAPPDATA%\Programs\Zoom`
- `%LOCALAPPDATA%\Programs\zoom.us`
- `%LOCALAPPDATA%\Zoom\data`
- `%LOCALAPPDATA%\Zoom\cache`
- `%LOCALAPPDATA%\Zoom\EBWebView`

### AppData\LocalLow
- `%USERPROFILE%\AppData\LocalLow\Zoom`

### Documents
- `%USERPROFILE%\Documents\Zoom`

### Temp
- `%TEMP%\Zoom`
- `%TEMP%\zoomus`
- `%TEMP%\zoom_installer`

### ProgramData (System-wide)
- `C:\ProgramData\Zoom`
- `C:\ProgramData\ZoomVideo`
- `C:\ProgramData\Zoom Video Communications`
- `C:\ProgramData\CptService`
- `C:\ProgramData\CptHost`
- `C:\ProgramData\Zoom CptService`
- `C:\ProgramData\Zoom VDI`

### Program Files
- `C:\Program Files\Zoom`
- `C:\Program Files (x86)\Zoom`
- `C:\Program Files\Zoom\bin`
- `C:\Program Files\Zoom Workplace`
- `C:\Program Files (x86)\Zoom Workplace`
- `C:\Program Files\Common Files\Zoom`
- `C:\Program Files (x86)\Common Files\Zoom`
- `C:\Program Files\Common Files\zoom.us`
- `C:\Program Files (x86)\Common Files\zoom.us`

### Updater Folders
- `%LOCALAPPDATA%\zoom-1132-eliminator-updater`
- `%LOCALAPPDATA%\zoom-updater`
- `%LOCALAPPDATA%\squirrel-zoom`

### Telemetry Files (specifically targeted)
- `%APPDATA%\Zoom\data\telemetrydata.db`
- `%LOCALAPPDATA%\Zoom\data\telemetrydata.db`
- `%APPDATA%\Zoom\telemetrydata.db`
- `%LOCALAPPDATA%\Zoom\telemetrydata.db`

### All User Profiles Scanned
The app scans `C:\Users\*` and deletes Zoom data from ALL user profiles, not just the current user.

---

## 7. PREFETCH FILES DELETED

```powershell
Get-ChildItem 'C:\Windows\Prefetch' -Filter '*ZOOM*' | Remove-Item -Force
Get-ChildItem 'C:\Windows\Prefetch' -Filter '*CPT*' | Remove-Item -Force
```

---

## 8. FIREWALL RULES REMOVED

```powershell
Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*Zoom*' } | Remove-NetFirewallRule
```

---

## 9. DNS CACHE FLUSHED

```cmd
ipconfig /flushdns
```

---

## 10. ZOOM UNINSTALL METHODS

1. **Zoom's Own Uninstaller:**
   ```cmd
   "C:\Program Files\Zoom\bin\Installer.exe" /uninstall
   "C:\Program Files (x86)\Zoom\bin\Installer.exe" /uninstall
   ```

2. **WMI Uninstall:**
   ```cmd
   wmic product where "name like '%Zoom%'" call uninstall /nointeractive
   ```

3. **MSI Uninstall (if GUID known):**
   ```cmd
   msiexec /x {zoom_msi_guid} /qn /norestart
   ```

---

## 11. ZOOM DOWNLOAD & INSTALL

### Download URL
```
https://zoom.us/client/latest/ZoomInstallerFull.msi
```

### Download Location
```
%TEMP%\ZoomInstallerFull.msi
```

### Install Command
```cmd
msiexec /i "%TEMP%\ZoomInstallerFull.msi" /qn /norestart ALLUSERS=1
```

### Launch Methods
1. **Direct executable:**
   - `C:\Program Files\Zoom\bin\Zoom.exe`
   - `%APPDATA%\Zoom\bin\Zoom.exe`
   - `%LOCALAPPDATA%\Zoom\bin\Zoom.exe`

2. **Protocol handler:**
   ```cmd
   start zoommtg://
   ```

---

## 12. GHOST USER FEATURES (Full Version Only)

### User Created
- Username: `zoom1132eliminator` or `Zoom`
- Password: `Z1132elim!` or `Zoom1132!`

### User Operations
1. Create user: `net user {username} {password} /add`
2. Add to Users group: `net localgroup Users {username} /add`
3. Initialize profile via PsExec
4. Create junction links for Documents, Downloads, Desktop, Pictures, Videos, Music
5. Delete user: `net user {username} /delete`

### PsExec Download
```
https://live.sysinternals.com/PsExec64.exe
```
Downloaded to: `%TEMP%\PsExec64.exe`

---

## SUMMARY TABLE

| Category | Count |
|----------|-------|
| Processes | 47 |
| Services | 5 |
| Scheduled Tasks | 7+ |
| Registry Keys (HKCU) | 11+ |
| Registry Keys (HKLM) | 12+ |
| Credentials | 5 |
| Directory Paths | 40+ |
| Firewall Rules | All matching *Zoom* |
| Prefetch Files | All matching *ZOOM* or *CPT* |

---

*Generated from 1132 Remover v2.1.0 source code*
