#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Complete uninstall - removes Zoom AND the ghost user account.

.DESCRIPTION
    Performs a full cleanup:
    1. Removes all Zoom data (same as nuke-zoom.ps1)
    2. Removes the ghost user account and profile
    3. Cleans up all related files

.NOTES
    Run as Administrator.
#>

param(
    [string]$GhostUser = "zoom1132eliminator",
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

    Stop-Service -Name "CptService" -Force -ErrorAction SilentlyContinue
    Stop-Service -Name "ZoomCptService" -Force -ErrorAction SilentlyContinue

    Start-Sleep -Seconds 2
}

function Remove-GhostUser {
    param([string]$Username)

    Write-Status "Removing ghost user: $Username" "Info"

    $user = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue
    if (-not $user) {
        Write-Status "User does not exist" "Warning"
        return
    }

    # Get profile path before deletion
    $sid = $user.SID.Value
    $profilePath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -ErrorAction SilentlyContinue).ProfileImagePath

    if (-not $profilePath) {
        # Fall back to scanning C:\Users
        $profilePath = (Get-ChildItem "C:\Users" -Directory | Where-Object { $_.Name -like "$Username*" } | Select-Object -First 1).FullName
    }

    # Remove junction links first (so we don't delete main user files)
    if ($profilePath -and (Test-Path $profilePath)) {
        $junctionFolders = @("Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music")
        foreach ($folder in $junctionFolders) {
            $jPath = Join-Path $profilePath $folder
            if (Test-Path $jPath) {
                cmd /c rmdir "$jPath" 2>$null
            }
        }
    }

    # Delete the user account
    Remove-LocalUser -Name $Username -ErrorAction SilentlyContinue
    Write-Status "User account deleted" "Success"

    # Delete profile folder
    if ($profilePath -and (Test-Path $profilePath)) {
        Remove-Item -Path $profilePath -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "Profile folder deleted: $profilePath" "Success"
    }

    # Clean up registry profile list
    if ($sid) {
        Remove-Item "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid" -Recurse -Force -ErrorAction SilentlyContinue
    }

    # Clean up any variant profile folders (User.COMPUTER.001, etc.)
    Get-ChildItem "C:\Users" -Directory | Where-Object { $_.Name -like "$Username*" } | ForEach-Object {
        # Remove junctions first
        foreach ($folder in @("Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music")) {
            $jPath = Join-Path $_.FullName $folder
            if (Test-Path $jPath) { cmd /c rmdir "$jPath" 2>$null }
        }
        Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        Write-Status "Removed variant folder: $($_.FullName)" "Success"
    }
}

function Remove-ZoomServices {
    Write-Status "Removing Zoom services..." "Info"

    $services = @("CptService", "ZoomCptService", "Zoom Sharing Service")

    foreach ($svc in $services) {
        Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
        sc.exe delete $svc 2>$null
    }
}

function Remove-ZoomScheduledTasks {
    Write-Status "Removing Zoom scheduled tasks..." "Info"

    Get-ScheduledTask | Where-Object { $_.TaskName -like "*Zoom*" } | ForEach-Object {
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Remove-ZoomRegistry {
    Write-Status "Removing Zoom registry entries..." "Info"

    $regPaths = @(
        "HKCU:\Software\Zoom",
        "HKCU:\Software\ZoomUMX",
        "HKCU:\Software\zoom.us",
        "HKCU:\Software\Zoom Video Communications",
        "HKCU:\Software\CptService",
        "HKLM:\Software\Zoom",
        "HKLM:\Software\ZoomUMX",
        "HKLM:\Software\zoom.us",
        "HKLM:\Software\Zoom Video Communications",
        "HKLM:\Software\CptService",
        "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
        "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService",
        "HKLM:\Software\WOW6432Node\Zoom",
        "HKLM:\Software\WOW6432Node\ZoomUMX",
        "HKLM:\Software\WOW6432Node\zoom.us",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX",
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX"
    )

    foreach ($path in $regPaths) {
        if (Test-Path $path) {
            Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Zoom" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ZoomUMX" -ErrorAction SilentlyContinue
}

function Remove-ZoomCredentials {
    Write-Status "Removing Windows credentials..." "Info"

    foreach ($target in @("zoom.us", "Zoom", "ZoomVideo", "ZoomUMX")) {
        cmdkey /delete:$target 2>$null
    }
}

function Remove-ZoomFolders {
    Write-Status "Removing Zoom data folders..." "Info"

    $folders = @(
        "$env:APPDATA\Zoom",
        "$env:APPDATA\Zoom Meetings",
        "$env:APPDATA\zoomus",
        "$env:APPDATA\ZoomLogs",
        "$env:APPDATA\Zoom VDI",
        "$env:APPDATA\ZoomOutlookPlugin",
        "$env:LOCALAPPDATA\Zoom",
        "$env:LOCALAPPDATA\zoomus",
        "$env:LOCALAPPDATA\ZoomLogs",
        "$env:LOCALAPPDATA\Zoom VDI",
        "$env:LOCALAPPDATA\ZoomOutlookPlugin",
        "$env:LOCALAPPDATA\Programs\Zoom",
        "$env:LOCALAPPDATA\Programs\zoom.us",
        "$env:ProgramData\Zoom",
        "$env:ProgramData\ZoomVideo",
        "$env:ProgramData\Zoom Video Communications",
        "$env:ProgramData\CptService",
        "$env:ProgramData\CptHost",
        "$env:ProgramData\Zoom CptService",
        "$env:ProgramData\Zoom VDI",
        "$env:USERPROFILE\Documents\Zoom",
        "$env:USERPROFILE\AppData\LocalLow\Zoom",
        "$env:TEMP\Zoom",
        "$env:TEMP\zoomus",
        "$env:TEMP\zoom_installer"
    )

    foreach ($folder in $folders) {
        if (Test-Path $folder) {
            Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Remove-OldGhostUsers {
    Write-Status "Cleaning up old ghost user accounts..." "Info"

    # Remove old-style ghost users
    $oldUsers = @("ZoomUser", "ZoomGhost", "Zoom")
    foreach ($user in $oldUsers) {
        $exists = Get-LocalUser -Name $user -ErrorAction SilentlyContinue
        if ($exists) {
            Remove-GhostUser -Username $user
        }
    }

    # Remove ZG* users
    Get-LocalUser | Where-Object { $_.Name -like "ZG*" } | ForEach-Object {
        Remove-GhostUser -Username $_.Name
    }
}

# Main execution
Write-Host ""
Write-Host "========================================" -ForegroundColor Red
Write-Host "    1132 REMOVER - FULL UNINSTALL      " -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Red
Write-Host ""
Write-Host "This will completely remove:" -ForegroundColor Yellow
Write-Host "  - All Zoom data and registry entries" -ForegroundColor White
Write-Host "  - Ghost user account ($GhostUser)" -ForegroundColor White
Write-Host "  - All Zoom services and scheduled tasks" -ForegroundColor White
Write-Host ""

if (-not $SkipConfirmation) {
    $confirm = Read-Host "Are you sure you want to continue? (Y/N)"
    if ($confirm -ne "Y" -and $confirm -ne "y") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host ""

# Execute cleanup
Stop-ZoomProcesses
Remove-GhostUser -Username $GhostUser
Remove-OldGhostUsers
Remove-ZoomServices
Remove-ZoomScheduledTasks
Remove-ZoomRegistry
Remove-ZoomCredentials
Remove-ZoomFolders

# Also remove the "Zoom" user if it exists
$zoomUserExists = Get-LocalUser -Name "Zoom" -ErrorAction SilentlyContinue
if ($zoomUserExists) {
    Remove-GhostUser -Username "Zoom"
}

# Clean up PsExec
$psexecPath = "$env:TEMP\PsExec64.exe"
if (Test-Path $psexecPath) {
    Remove-Item $psexecPath -Force -ErrorAction SilentlyContinue
    Write-Status "Removed PsExec" "Success"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "       FULL UNINSTALL COMPLETE         " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "All Zoom data and ghost users have been removed." -ForegroundColor Green
Write-Host ""

if (-not $Silent) {
    Read-Host "Press Enter to exit"
}
