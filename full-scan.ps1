# Comprehensive Zoom Data Location Scanner
# Finds ALL Zoom data including aliases, logs, registry, and hidden locations

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  COMPREHENSIVE ZOOM DATA SCANNER          " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

$found = @()

# === APPDATA ROAMING ===
Write-Host "--- APPDATA ROAMING ---" -ForegroundColor Yellow
$roaming = $env:APPDATA
$roamingFolders = @("Zoom", "Zoom Meetings", "zoomus", "ZoomLogs", "ZoomUMX", "zoom.us",
                    "Zoom Video Communications", "Zoom Workplace", "ZoomGifCollector",
                    "Zoom VDI", "ZoomOutlookPlugin")
foreach ($f in $roamingFolders) {
    $path = Join-Path $roaming $f
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === LOCALAPPDATA ===
Write-Host "`n--- LOCALAPPDATA ---" -ForegroundColor Yellow
$local = $env:LOCALAPPDATA
$localFolders = @("Zoom", "zoomus", "ZoomLogs", "ZoomUMX", "zoom.us", "Zoom VDI",
                  "ZoomOutlookPlugin", "Zoom Workplace", "ZoomGifCollector")
foreach ($f in $localFolders) {
    $path = Join-Path $local $f
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}
# Programs subfolder
$progFolders = @("Zoom", "zoom.us", "Zoom Workplace")
foreach ($f in $progFolders) {
    $path = Join-Path $local "Programs\$f"
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === PROGRAMDATA ===
Write-Host "`n--- PROGRAMDATA ---" -ForegroundColor Yellow
$progData = $env:ProgramData
$pdFolders = @("Zoom", "ZoomVideo", "Zoom Video Communications", "CptService", "CptHost",
               "Zoom CptService", "Zoom VDI", "Zoom Workplace")
foreach ($f in $pdFolders) {
    $path = Join-Path $progData $f
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === PROGRAM FILES ===
Write-Host "`n--- PROGRAM FILES ---" -ForegroundColor Yellow
$pfPaths = @("C:\Program Files\Zoom", "C:\Program Files (x86)\Zoom",
             "C:\Program Files\Zoom Workplace", "C:\Program Files (x86)\Zoom Workplace",
             "C:\Program Files\Common Files\Zoom", "C:\Program Files (x86)\Common Files\Zoom",
             "C:\Program Files\Common Files\zoom.us", "C:\Program Files (x86)\Common Files\zoom.us")
foreach ($path in $pfPaths) {
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === USER PROFILE ===
Write-Host "`n--- USER PROFILE ---" -ForegroundColor Yellow
$userProfile = $env:USERPROFILE
$userFolders = @("Documents\Zoom", "AppData\LocalLow\Zoom")
foreach ($f in $userFolders) {
    $path = Join-Path $userProfile $f
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === TEMP ===
Write-Host "`n--- TEMP FOLDERS ---" -ForegroundColor Yellow
$temp = $env:TEMP
$tempFolders = @("Zoom", "zoomus", "zoom_installer")
foreach ($f in $tempFolders) {
    $path = Join-Path $temp $f
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === ZOOM USER PROFILES ===
Write-Host "`n--- ZOOM USER PROFILES (C:\Users) ---" -ForegroundColor Yellow
Get-ChildItem "C:\Users" -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*zoom*" -or $_.Name -like "ZG*" -or $_.Name -like "*1132*"
} | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}

# === PREFETCH FILES ===
Write-Host "`n--- PREFETCH FILES ---" -ForegroundColor Yellow
Get-ChildItem "C:\Windows\Prefetch" -Filter "*ZOOM*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}
Get-ChildItem "C:\Windows\Prefetch" -Filter "*CPT*" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}

# === REGISTRY KEYS ===
Write-Host "`n--- REGISTRY KEYS ---" -ForegroundColor Yellow
$regKeys = @(
    "HKCU:\Software\Zoom",
    "HKCU:\Software\ZoomUMX",
    "HKCU:\Software\zoom.us",
    "HKCU:\Software\Zoom Video Communications",
    "HKCU:\Software\CptService",
    "HKCU:\Software\ZoomGifCollector",
    "HKCU:\Software\Zoom Workplace",
    "HKLM:\Software\Zoom",
    "HKLM:\Software\ZoomUMX",
    "HKLM:\Software\zoom.us",
    "HKLM:\Software\Zoom Video Communications",
    "HKLM:\Software\CptService",
    "HKLM:\Software\Zoom Workplace",
    "HKLM:\Software\WOW6432Node\Zoom",
    "HKLM:\Software\WOW6432Node\ZoomUMX",
    "HKLM:\Software\WOW6432Node\zoom.us",
    "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
    "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX"
)
foreach ($key in $regKeys) {
    if (Test-Path $key) {
        Write-Host "  FOUND: $key" -ForegroundColor Green
        $found += $key
    }
}

# === SERVICES ===
Write-Host "`n--- SERVICES ---" -ForegroundColor Yellow
Get-Service -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -like "*Zoom*" -or $_.Name -like "*Cpt*"
} | ForEach-Object {
    Write-Host "  FOUND: $($_.Name) - Status: $($_.Status)" -ForegroundColor Green
    $found += "Service: $($_.Name)"
}

# === SCHEDULED TASKS ===
Write-Host "`n--- SCHEDULED TASKS ---" -ForegroundColor Yellow
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -like "*Zoom*"
} | ForEach-Object {
    Write-Host "  FOUND: $($_.TaskName)" -ForegroundColor Green
    $found += "Task: $($_.TaskName)"
}

# === FIREWALL RULES ===
Write-Host "`n--- FIREWALL RULES ---" -ForegroundColor Yellow
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like "*Zoom*" -or $_.DisplayName -like "*zoom*"
} | ForEach-Object {
    Write-Host "  FOUND: $($_.DisplayName) [$($_.Direction)]" -ForegroundColor Green
    $found += "Firewall: $($_.DisplayName)"
}

# === RECENT ITEMS ===
Write-Host "`n--- RECENT ITEMS ---" -ForegroundColor Yellow
$recentPath = [Environment]::GetFolderPath("Recent")
Get-ChildItem $recentPath -Filter "*zoom*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}

# === WEBVIEW/BROWSER DATA ===
Write-Host "`n--- WEBVIEW CACHE ---" -ForegroundColor Yellow
$webviewPaths = @(
    "$env:APPDATA\Zoom\data\WebviewCacheX64",
    "$env:LOCALAPPDATA\Zoom\data\WebviewCacheX64",
    "$env:APPDATA\Zoom\EBWebView",
    "$env:LOCALAPPDATA\Zoom\EBWebView"
)
foreach ($path in $webviewPaths) {
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === TELEMETRY/ID FILES ===
Write-Host "`n--- TELEMETRY & ID FILES ---" -ForegroundColor Yellow
$telemetryPaths = @(
    "$env:APPDATA\Zoom\data\telemetrydata.db",
    "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
    "$env:APPDATA\Zoom\data\zoomid.db",
    "$env:APPDATA\Zoom\data\ZoomUniqueID",
    "$env:APPDATA\Zoom\data\deviceinfo.dat"
)
foreach ($path in $telemetryPaths) {
    if (Test-Path $path) {
        Write-Host "  FOUND: $path" -ForegroundColor Green
        $found += $path
    }
}

# === WINDOWS CREDENTIALS ===
Write-Host "`n--- WINDOWS CREDENTIALS ---" -ForegroundColor Yellow
$credOutput = cmdkey /list 2>&1
if ($credOutput -match "zoom") {
    Write-Host "  FOUND: Zoom credentials in Windows Credential Manager" -ForegroundColor Green
    $found += "Credentials: zoom"
}

# === DATABASE FILES ===
Write-Host "`n--- DATABASE FILES (.db) ---" -ForegroundColor Yellow
Get-ChildItem "$env:APPDATA\Zoom" -Filter "*.db*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}
Get-ChildItem "$env:LOCALAPPDATA\Zoom" -Filter "*.db*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  FOUND: $($_.FullName)" -ForegroundColor Green
    $found += $_.FullName
}

# === MUI CACHE ===
Write-Host "`n--- MUI CACHE ENTRIES ---" -ForegroundColor Yellow
$muiKey = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
if (Test-Path $muiKey) {
    $props = Get-ItemProperty $muiKey -ErrorAction SilentlyContinue
    $props.PSObject.Properties | Where-Object { $_.Name -like "*zoom*" -or $_.Name -like "*Zoom*" } | ForEach-Object {
        Write-Host "  FOUND: MUI Cache - $($_.Name)" -ForegroundColor Green
        $found += "MUI: $($_.Name)"
    }
}

# === COMPATIBILITY FLAGS ===
Write-Host "`n--- COMPATIBILITY FLAGS ---" -ForegroundColor Yellow
$compatKey = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
if (Test-Path $compatKey) {
    $props = Get-ItemProperty $compatKey -ErrorAction SilentlyContinue
    $props.PSObject.Properties | Where-Object { $_.Name -like "*zoom*" -or $_.Name -like "*Zoom*" } | ForEach-Object {
        Write-Host "  FOUND: Compat Flag - $($_.Name)" -ForegroundColor Green
        $found += "Compat: $($_.Name)"
    }
}

# === SUMMARY ===
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "               SCAN SUMMARY                " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Total items found: $($found.Count)" -ForegroundColor $(if ($found.Count -gt 0) { "Yellow" } else { "Green" })

if ($found.Count -eq 0) {
    Write-Host "No Zoom data found on this system!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Run nuke-zoom.ps1 followed by deep-clean.ps1 to remove all data." -ForegroundColor Yellow
}

Write-Host ""
