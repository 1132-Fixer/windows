# Scan all Zoom data locations on the system
Write-Host "=== SCANNING ALL ZOOM DATA LOCATIONS ===" -ForegroundColor Cyan
Write-Host ""

# AppData Roaming
Write-Host "--- APPDATA ROAMING ---" -ForegroundColor Yellow
$roaming = "$env:APPDATA"
if (Test-Path "$roaming\Zoom") { Write-Host "  FOUND: $roaming\Zoom" -ForegroundColor Green }
if (Test-Path "$roaming\Zoom Meetings") { Write-Host "  FOUND: $roaming\Zoom Meetings" -ForegroundColor Green }
if (Test-Path "$roaming\zoomus") { Write-Host "  FOUND: $roaming\zoomus" -ForegroundColor Green }
if (Test-Path "$roaming\ZoomLogs") { Write-Host "  FOUND: $roaming\ZoomLogs" -ForegroundColor Green }
if (Test-Path "$roaming\Zoom VDI") { Write-Host "  FOUND: $roaming\Zoom VDI" -ForegroundColor Green }
if (Test-Path "$roaming\ZoomOutlookPlugin") { Write-Host "  FOUND: $roaming\ZoomOutlookPlugin" -ForegroundColor Green }

# LocalAppData
Write-Host "`n--- LOCALAPPDATA ---" -ForegroundColor Yellow
$local = "$env:LOCALAPPDATA"
if (Test-Path "$local\Zoom") { Write-Host "  FOUND: $local\Zoom" -ForegroundColor Green }
if (Test-Path "$local\zoomus") { Write-Host "  FOUND: $local\zoomus" -ForegroundColor Green }
if (Test-Path "$local\ZoomLogs") { Write-Host "  FOUND: $local\ZoomLogs" -ForegroundColor Green }
if (Test-Path "$local\Zoom VDI") { Write-Host "  FOUND: $local\Zoom VDI" -ForegroundColor Green }
if (Test-Path "$local\Programs\Zoom") { Write-Host "  FOUND: $local\Programs\Zoom" -ForegroundColor Green }
if (Test-Path "$local\Programs\zoom.us") { Write-Host "  FOUND: $local\Programs\zoom.us" -ForegroundColor Green }

# ProgramData
Write-Host "`n--- PROGRAMDATA ---" -ForegroundColor Yellow
$pd = "C:\ProgramData"
if (Test-Path "$pd\Zoom") { Write-Host "  FOUND: $pd\Zoom" -ForegroundColor Green }
if (Test-Path "$pd\ZoomVideo") { Write-Host "  FOUND: $pd\ZoomVideo" -ForegroundColor Green }
if (Test-Path "$pd\Zoom Video Communications") { Write-Host "  FOUND: $pd\Zoom Video Communications" -ForegroundColor Green }
if (Test-Path "$pd\CptService") { Write-Host "  FOUND: $pd\CptService" -ForegroundColor Green }
if (Test-Path "$pd\CptHost") { Write-Host "  FOUND: $pd\CptHost" -ForegroundColor Green }
if (Test-Path "$pd\Zoom CptService") { Write-Host "  FOUND: $pd\Zoom CptService" -ForegroundColor Green }
if (Test-Path "$pd\Zoom VDI") { Write-Host "  FOUND: $pd\Zoom VDI" -ForegroundColor Green }

# Program Files
Write-Host "`n--- PROGRAM FILES ---" -ForegroundColor Yellow
if (Test-Path "C:\Program Files\Zoom") { Write-Host "  FOUND: C:\Program Files\Zoom" -ForegroundColor Green }
if (Test-Path "C:\Program Files (x86)\Zoom") { Write-Host "  FOUND: C:\Program Files (x86)\Zoom" -ForegroundColor Green }

# User Profile
Write-Host "`n--- USER PROFILE ---" -ForegroundColor Yellow
$profile = "$env:USERPROFILE"
if (Test-Path "$profile\Documents\Zoom") { Write-Host "  FOUND: $profile\Documents\Zoom" -ForegroundColor Green }
if (Test-Path "$profile\AppData\LocalLow\Zoom") { Write-Host "  FOUND: $profile\AppData\LocalLow\Zoom" -ForegroundColor Green }

# Temp
Write-Host "`n--- TEMP FOLDERS ---" -ForegroundColor Yellow
$temp = "$env:TEMP"
if (Test-Path "$temp\Zoom") { Write-Host "  FOUND: $temp\Zoom" -ForegroundColor Green }
if (Test-Path "$temp\zoomus") { Write-Host "  FOUND: $temp\zoomus" -ForegroundColor Green }
if (Test-Path "$temp\zoom_installer") { Write-Host "  FOUND: $temp\zoom_installer" -ForegroundColor Green }

# Zoom user profiles in C:\Users
Write-Host "`n--- ZOOM USER PROFILES (C:\Users) ---" -ForegroundColor Yellow
Get-ChildItem "C:\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -like "*zoom*" -or $_.Name -like "ZG*") {
        Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    }
}

# Registry Keys
Write-Host "`n--- REGISTRY KEYS ---" -ForegroundColor Yellow
$regKeys = @(
    "HKCU:\Software\Zoom",
    "HKCU:\Software\ZoomUMX",
    "HKCU:\Software\zoom.us",
    "HKCU:\Software\Zoom Video Communications",
    "HKLM:\Software\Zoom",
    "HKLM:\Software\ZoomUMX",
    "HKLM:\Software\zoom.us",
    "HKLM:\Software\WOW6432Node\Zoom",
    "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
    "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService"
)
foreach ($key in $regKeys) {
    if (Test-Path $key) {
        Write-Host "  FOUND: $key" -ForegroundColor Green
    }
}

# Zoom Services
Write-Host "`n--- ZOOM SERVICES ---" -ForegroundColor Yellow
Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*Zoom*" -or $_.Name -like "*Cpt*" } | ForEach-Object {
    Write-Host "  FOUND: $($_.Name) - $($_.Status)" -ForegroundColor Green
}

# Scheduled Tasks
Write-Host "`n--- SCHEDULED TASKS ---" -ForegroundColor Yellow
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "*Zoom*" } | ForEach-Object {
    Write-Host "  FOUND: $($_.TaskName)" -ForegroundColor Green
}

Write-Host "`n=== SCAN COMPLETE ===" -ForegroundColor Cyan
