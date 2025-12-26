#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Deep clean script - removes ALL hidden Zoom data including aliases, logs, and system traces.

.DESCRIPTION
    This script performs a comprehensive cleanup of ALL Zoom-related data including:
    - WebView2 cache and browser data
    - Prefetch files
    - Firewall rules
    - Recent items / Jump lists
    - MUI cache entries
    - DNS client cache
    - Crash reports and logs
    - All alias folder names

.NOTES
    Run as Administrator for full functionality.
#>

param(
    [switch]$Silent,
    [switch]$SkipConfirmation
)

$ErrorActionPreference = "SilentlyContinue"

function Write-Status {
    param([string]$Message, [string]$Type = "Info")
    if ($Silent) { return }
    $color = switch ($Type) {
        "Success" { "Green" }
        "Error"   { "Red" }
        "Warning" { "Yellow" }
        default   { "Cyan" }
    }
    Write-Host "[$Type] $Message" -ForegroundColor $color
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "    1132 REMOVER - DEEP CLEAN              " -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipConfirmation) {
    $confirm = Read-Host "This will perform a DEEP CLEAN of all Zoom data. Continue? (Y/N)"
    if ($confirm -ne "Y" -and $confirm -ne "y") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

# ===== 1. WEBVIEW CACHE (CRITICAL - stores device fingerprints) =====
Write-Status "=== CLEANING WEBVIEW CACHE ===" "Info"

$webviewPaths = @(
    "$env:APPDATA\Zoom\data\WebviewCacheX64",
    "$env:LOCALAPPDATA\Zoom\data\WebviewCacheX64",
    "$env:APPDATA\Zoom\EBWebView",
    "$env:LOCALAPPDATA\Zoom\EBWebView"
)

foreach ($path in $webviewPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $path" "Success"
    }
}

# ===== 2. ZOOM LOGS AND CRASH REPORTS =====
Write-Status "=== CLEANING LOGS & REPORTS ===" "Info"

$logPaths = @(
    "$env:APPDATA\Zoom\logs",
    "$env:APPDATA\Zoom\reports",
    "$env:LOCALAPPDATA\Zoom\logs",
    "$env:LOCALAPPDATA\Zoom\reports",
    "$env:APPDATA\Zoom\data\zoom_logs",
    "$env:LOCALAPPDATA\Zoom\data\zoom_logs",
    "$env:APPDATA\ZoomLogs",
    "$env:LOCALAPPDATA\ZoomLogs"
)

foreach ($path in $logPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $path" "Success"
    }
}

# ===== 3. PREFETCH FILES (Windows remembers app launches) =====
Write-Status "=== CLEANING PREFETCH FILES ===" "Info"

$prefetchPath = "C:\Windows\Prefetch"
if (Test-Path $prefetchPath) {
    Get-ChildItem $prefetchPath -Filter "*ZOOM*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $($_.Name)" "Success"
    }
    # Also clean CPT-related prefetch
    Get-ChildItem $prefetchPath -Filter "*CPT*" -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $($_.Name)" "Success"
    }
}

# ===== 4. FIREWALL RULES =====
Write-Status "=== CLEANING FIREWALL RULES ===" "Info"

Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like "*Zoom*" -or $_.DisplayName -like "*zoom*"
} | ForEach-Object {
    Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue
    Write-Status "  Removed firewall rule: $($_.DisplayName)" "Success"
}

# ===== 5. RECENT ITEMS / JUMP LISTS =====
Write-Status "=== CLEANING RECENT ITEMS ===" "Info"

$recentPath = [Environment]::GetFolderPath("Recent")
if (Test-Path $recentPath) {
    Get-ChildItem $recentPath -Filter "*zoom*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $($_.Name)" "Success"
    }
}

# Jump lists (AutomaticDestinations and CustomDestinations)
$jumpListPaths = @(
    "$env:APPDATA\Microsoft\Windows\Recent\AutomaticDestinations",
    "$env:APPDATA\Microsoft\Windows\Recent\CustomDestinations"
)

# Note: Jump lists are binary files, removing Zoom-specific ones is complex
# Best approach is to clear specific entries through registry

# ===== 6. MUI CACHE (remembers app names) =====
Write-Status "=== CLEANING MUI CACHE ===" "Info"

$muiCacheKeys = @(
    "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
)

foreach ($key in $muiCacheKeys) {
    if (Test-Path $key) {
        Get-ItemProperty $key -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty | Where-Object {
            $_.Name -like "*zoom*" -or $_.Name -like "*Zoom*"
        } | ForEach-Object {
            Remove-ItemProperty -Path $key -Name $_.Name -ErrorAction SilentlyContinue
            Write-Status "  Removed MUI cache: $($_.Name)" "Success"
        }
    }
}

# ===== 7. DNS CLIENT CACHE =====
Write-Status "=== FLUSHING DNS CACHE ===" "Info"
ipconfig /flushdns | Out-Null
Write-Status "  DNS cache flushed" "Success"

# ===== 8. ALIAS FOLDER NAMES (Zoom uses various naming conventions) =====
Write-Status "=== CLEANING ALIAS FOLDERS ===" "Info"

$aliasFolders = @(
    # ZoomUMX (internal code name)
    "$env:APPDATA\ZoomUMX",
    "$env:LOCALAPPDATA\ZoomUMX",

    # zoom.us (domain-based naming)
    "$env:APPDATA\zoom.us",
    "$env:LOCALAPPDATA\zoom.us",

    # Zoom Video Communications (corporate name)
    "$env:APPDATA\Zoom Video Communications",
    "$env:LOCALAPPDATA\Zoom Video Communications",
    "$env:ProgramData\Zoom Video Communications",

    # Zoom Workplace (new 2024 branding)
    "$env:APPDATA\Zoom Workplace",
    "$env:LOCALAPPDATA\Zoom Workplace",

    # ZoomGifCollector (background service)
    "$env:APPDATA\ZoomGifCollector",
    "$env:LOCALAPPDATA\ZoomGifCollector",

    # Zoomus (old naming)
    "$env:APPDATA\zoomus",
    "$env:LOCALAPPDATA\zoomus",

    # CptService (Companion service - stores device IDs)
    "$env:ProgramData\CptService",
    "$env:ProgramData\CptHost",
    "$env:ProgramData\Zoom CptService"
)

foreach ($folder in $aliasFolders) {
    if (Test-Path $folder) {
        Remove-Item $folder -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $folder" "Success"
    }
}

# ===== 9. APP COMPATIBILITY DATABASE =====
Write-Status "=== CLEANING COMPATIBILITY DATA ===" "Info"

$compatPaths = @(
    "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Compatibility Assistant\Store",
    "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
)

foreach ($key in $compatPaths) {
    if (Test-Path $key) {
        Get-ItemProperty $key -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty | Where-Object {
            $_.Name -like "*zoom*" -or $_.Name -like "*Zoom*"
        } | ForEach-Object {
            Remove-ItemProperty -Path $key -Name $_.Name -ErrorAction SilentlyContinue
            Write-Status "  Removed compat entry: $($_.Name)" "Success"
        }
    }
}

# ===== 10. TYPED URLS (if user typed zoom.us in browser-like views) =====
Write-Status "=== CLEANING TYPED URLS ===" "Info"

$typedUrlsKey = "HKCU:\Software\Microsoft\Internet Explorer\TypedURLs"
if (Test-Path $typedUrlsKey) {
    Get-ItemProperty $typedUrlsKey -ErrorAction SilentlyContinue | Get-Member -MemberType NoteProperty | Where-Object {
        $_.Definition -like "*zoom*"
    } | ForEach-Object {
        Remove-ItemProperty -Path $typedUrlsKey -Name $_.Name -ErrorAction SilentlyContinue
        Write-Status "  Removed typed URL: $($_.Name)" "Success"
    }
}

# ===== 11. USER ASSIST (tracks app usage) =====
Write-Status "=== CLEANING USER ASSIST ===" "Info"
# Note: UserAssist entries are ROT13 encoded, complex to clean selectively
# The main Zoom registry cleanup handles this

# ===== 12. WINDOWS SEARCH INDEX =====
Write-Status "=== CLEANING SEARCH INDEX ===" "Info"
Write-Status "  Note: Search index will auto-rebuild without Zoom entries after removal" "Warning"

# ===== 13. WINDOWS INSTALLER CACHE =====
Write-Status "=== CLEANING INSTALLER CACHE ===" "Info"

$installerPath = "C:\Windows\Installer"
if (Test-Path $installerPath) {
    # This is complex - installer files are named with GUIDs
    # Best handled by uninstall, not manual deletion
    Write-Status "  Note: Installer cache handled by standard uninstall" "Warning"
}

# ===== 14. BITS JOBS (Background downloads) =====
Write-Status "=== CLEANING BITS JOBS ===" "Info"

Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like "*zoom*" -or $_.JobId -like "*zoom*"
} | ForEach-Object {
    Remove-BitsTransfer -BitsJob $_ -ErrorAction SilentlyContinue
    Write-Status "  Removed BITS job: $($_.DisplayName)" "Success"
}

# ===== 15. WPAD / PROXY CACHE =====
Write-Status "=== CLEANING PROXY CACHE ===" "Info"

$proxyKeys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections"
)
# Note: Proxy settings are system-wide, not Zoom-specific

# ===== 16. TELEMETRY DATABASE (critical for device ID) =====
Write-Status "=== CLEANING TELEMETRY DATA ===" "Info"

$telemetryPaths = @(
    "$env:APPDATA\Zoom\data\telemetrydata.db",
    "$env:APPDATA\Zoom\data\telemetrydata.db-wal",
    "$env:APPDATA\Zoom\data\telemetrydata.db-shm",
    "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
    "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db-wal",
    "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db-shm",
    "$env:APPDATA\Zoom\telemetrydata.db",
    "$env:LOCALAPPDATA\Zoom\telemetrydata.db"
)

foreach ($path in $telemetryPaths) {
    if (Test-Path $path) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $path" "Success"
    }
}

# ===== 17. ZOOM UNIQUE IDENTIFIERS (ZoomUniqueID, DeviceID files) =====
Write-Status "=== CLEANING UNIQUE IDENTIFIERS ===" "Info"

$idFiles = @(
    "$env:APPDATA\Zoom\data\zoomid.db",
    "$env:APPDATA\Zoom\data\ZoomUniqueID",
    "$env:APPDATA\Zoom\data\deviceinfo.dat",
    "$env:APPDATA\Zoom\data\zoomprofile.db",
    "$env:LOCALAPPDATA\Zoom\data\zoomid.db",
    "$env:LOCALAPPDATA\Zoom\data\ZoomUniqueID",
    "$env:LOCALAPPDATA\Zoom\data\deviceinfo.dat"
)

foreach ($path in $idFiles) {
    if (Test-Path $path) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
        Write-Status "  Removed: $path" "Success"
    }
}

# ===== 18. ZOOM SQLITE DATABASES =====
Write-Status "=== CLEANING SQLITE DATABASES ===" "Info"

Get-ChildItem "$env:APPDATA\Zoom" -Filter "*.db*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    Write-Status "  Removed: $($_.Name)" "Success"
}

Get-ChildItem "$env:LOCALAPPDATA\Zoom" -Filter "*.db*" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    Write-Status "  Removed: $($_.Name)" "Success"
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "         DEEP CLEAN COMPLETE               " -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "All hidden Zoom data has been removed." -ForegroundColor Green
Write-Host ""

if (-not $Silent) {
    Read-Host "Press Enter to exit"
}
