#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Complete Zoom removal script - removes all Zoom data, registry entries, services, and scheduled tasks.

.DESCRIPTION
    This script performs a thorough cleanup of all Zoom-related data from the system including:
    - All Zoom processes
    - Zoom services (CptService, ZoomCptService)
    - Scheduled tasks
    - Registry entries (HKCU, HKLM, WOW6432Node)
    - Windows credentials
    - All Zoom data folders (AppData, LocalAppData, ProgramData, temp)
    - Telemetry databases

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

function Stop-ZoomProcesses {
    Write-Status "Stopping all Zoom processes..." "Info"

    $processes = @(
        "Zoom", "ZoomWebHost", "CptHost", "CptService",
        "zCrashReport", "ZoomOutlookIMPlugin", "ZoomInstaller",
        "Zoomus", "ZoomSDKMessenger"
    )

    foreach ($proc in $processes) {
        Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force
    }

    # Stop services
    Stop-Service -Name "CptService" -Force -ErrorAction SilentlyContinue
    Stop-Service -Name "ZoomCptService" -Force -ErrorAction SilentlyContinue
    Stop-Service -Name "Zoom Sharing Service" -Force -ErrorAction SilentlyContinue

    Start-Sleep -Seconds 2
    Write-Status "Zoom processes stopped" "Success"
}

function Remove-ZoomServices {
    Write-Status "Removing Zoom services..." "Info"

    $services = @("CptService", "ZoomCptService", "Zoom Sharing Service")

    foreach ($svc in $services) {
        $service = Get-Service -Name $svc -ErrorAction SilentlyContinue
        if ($service) {
            Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            sc.exe delete $svc 2>$null
            Write-Status "  Removed service: $svc" "Success"
        }
    }
}

function Remove-ZoomScheduledTasks {
    Write-Status "Removing Zoom scheduled tasks..." "Info"

    Get-ScheduledTask | Where-Object { $_.TaskName -like "*Zoom*" } | ForEach-Object {
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Status "  Removed task: $($_.TaskName)" "Success"
    }
}

function Remove-ZoomRegistry {
    Write-Status "Removing Zoom registry entries..." "Info"

    $regPaths = @(
        # HKCU
        "HKCU:\Software\Zoom",
        "HKCU:\Software\ZoomUMX",
        "HKCU:\Software\zoom.us",
        "HKCU:\Software\Zoom Video Communications",
        "HKCU:\Software\CptService",

        # HKLM
        "HKLM:\Software\Zoom",
        "HKLM:\Software\ZoomUMX",
        "HKLM:\Software\zoom.us",
        "HKLM:\Software\Zoom Video Communications",
        "HKLM:\Software\CptService",
        "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
        "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService",

        # WOW6432Node
        "HKLM:\Software\WOW6432Node\Zoom",
        "HKLM:\Software\WOW6432Node\ZoomUMX",
        "HKLM:\Software\WOW6432Node\zoom.us",

        # Uninstall entries
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX"
    )

    foreach ($path in $regPaths) {
        if (Test-Path $path) {
            Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
            Write-Status "  Removed: $path" "Success"
        }
    }

    # Remove Run entries
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Zoom" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ZoomUMX" -ErrorAction SilentlyContinue

    Write-Status "Registry cleanup complete" "Success"
}

function Remove-ZoomCredentials {
    Write-Status "Removing Windows credentials..." "Info"

    $targets = @("zoom.us", "Zoom", "ZoomVideo", "ZoomUMX")

    foreach ($target in $targets) {
        cmdkey /delete:$target 2>$null
    }

    Write-Status "Credentials removed" "Success"
}

function Remove-ZoomFolders {
    Write-Status "Removing Zoom data folders..." "Info"

    $appData = $env:APPDATA
    $localAppData = $env:LOCALAPPDATA
    $programData = $env:ProgramData
    $userProfile = $env:USERPROFILE
    $temp = $env:TEMP

    $folders = @(
        # AppData Roaming
        "$appData\Zoom",
        "$appData\Zoom Meetings",
        "$appData\zoomus",
        "$appData\ZoomLogs",
        "$appData\Zoom VDI",
        "$appData\ZoomOutlookPlugin",

        # LocalAppData
        "$localAppData\Zoom",
        "$localAppData\zoomus",
        "$localAppData\ZoomLogs",
        "$localAppData\Zoom VDI",
        "$localAppData\ZoomOutlookPlugin",
        "$localAppData\Programs\Zoom",
        "$localAppData\Programs\zoom.us",

        # ProgramData (system-wide - contains device identifiers)
        "$programData\Zoom",
        "$programData\ZoomVideo",
        "$programData\Zoom Video Communications",
        "$programData\CptService",
        "$programData\CptHost",
        "$programData\Zoom CptService",
        "$programData\Zoom VDI",

        # User profile
        "$userProfile\Documents\Zoom",
        "$userProfile\AppData\LocalLow\Zoom",

        # Temp
        "$temp\Zoom",
        "$temp\zoomus",
        "$temp\zoom_installer"
    )

    foreach ($folder in $folders) {
        if (Test-Path $folder) {
            Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue
            Write-Status "  Removed: $folder" "Success"
        }
    }

    # Scan C:\Users for Zoom profile folders (variant folders)
    $currentUser = $env:USERNAME.ToLower()
    Get-ChildItem "C:\Users" -Directory -ErrorAction SilentlyContinue | Where-Object {
        $name = $_.Name.ToLower()
        ($name -like "*zoom*" -and $name -ne $currentUser) -or $name -like "zg*"
    } | ForEach-Object {
        Write-Status "  Found Zoom profile folder: $($_.FullName)" "Warning"
        # Don't auto-delete user profile folders - just report them
    }

    Write-Status "Folder cleanup complete" "Success"
}

function Remove-ZoomTelemetry {
    Write-Status "Removing telemetry databases..." "Info"

    $telemetryPaths = @(
        "$env:APPDATA\Zoom\data\telemetrydata.db",
        "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
        "$env:APPDATA\Zoom\telemetrydata.db",
        "$env:LOCALAPPDATA\Zoom\telemetrydata.db"
    )

    foreach ($path in $telemetryPaths) {
        if (Test-Path $path) {
            Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
            Write-Status "  Removed: $path" "Success"
        }
    }
}

# Main execution
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "       1132 REMOVER - NUKE ZOOM        " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not $SkipConfirmation) {
    $confirm = Read-Host "This will completely remove all Zoom data. Continue? (Y/N)"
    if ($confirm -ne "Y" -and $confirm -ne "y") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host ""

# Execute cleanup steps
Stop-ZoomProcesses
Remove-ZoomServices
Remove-ZoomScheduledTasks
Remove-ZoomRegistry
Remove-ZoomCredentials
Remove-ZoomFolders
Remove-ZoomTelemetry

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "       ZOOM REMOVAL COMPLETE           " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "All Zoom data has been removed from the system." -ForegroundColor Green
Write-Host ""

if (-not $Silent) {
    Read-Host "Press Enter to exit"
}
