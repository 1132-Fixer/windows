#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Launches Zoom under the ghost user account.

.DESCRIPTION
    Uses PsExec to run Zoom under an isolated user account, providing
    a clean identity separate from the main user.

.NOTES
    Run as Administrator.
#>

param(
    [string]$GhostUser = "zoom1132eliminator",
    [string]$GhostPass = "Z1132elim!",
    [switch]$Silent
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
    Write-Status "Stopping existing Zoom processes..." "Info"

    $processes = @("Zoom", "ZoomWebHost", "CptHost", "CptService", "zCrashReport")

    foreach ($proc in $processes) {
        Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force
    }

    Start-Sleep -Seconds 1
}

function Get-PsExec {
    $psexecPath = "$env:TEMP\PsExec64.exe"

    if (-not (Test-Path $psexecPath)) {
        Write-Status "Downloading PsExec..." "Info"
        try {
            Invoke-WebRequest -Uri "https://live.sysinternals.com/PsExec64.exe" -OutFile $psexecPath -UseBasicParsing
        }
        catch {
            Write-Status "Failed to download PsExec: $_" "Error"
            return $null
        }
    }

    return $psexecPath
}

function Find-ZoomExecutable {
    $paths = @(
        "C:\Program Files\Zoom\bin\Zoom.exe",
        "$env:APPDATA\Zoom\bin\Zoom.exe",
        "$env:LOCALAPPDATA\Zoom\bin\Zoom.exe",
        "C:\Program Files (x86)\Zoom\bin\Zoom.exe"
    )

    foreach ($path in $paths) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

function Test-GhostUser {
    $user = Get-LocalUser -Name $GhostUser -ErrorAction SilentlyContinue
    return $null -ne $user
}

# Main execution
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "    1132 REMOVER - GHOST ZOOM LAUNCH   " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if ghost user exists
if (-not (Test-GhostUser)) {
    Write-Status "Ghost user '$GhostUser' does not exist!" "Error"
    Write-Status "Run setup-ghost-user.ps1 first" "Warning"
    if (-not $Silent) { Read-Host "Press Enter to exit" }
    exit 1
}

# Stop any running Zoom
Stop-ZoomProcesses

# Get PsExec
$psexecPath = Get-PsExec
if (-not $psexecPath) {
    Write-Status "Cannot proceed without PsExec" "Error"
    if (-not $Silent) { Read-Host "Press Enter to exit" }
    exit 1
}

# Find Zoom
$zoomPath = Find-ZoomExecutable
if (-not $zoomPath) {
    Write-Status "Zoom executable not found!" "Error"
    Write-Status "Please install Zoom first" "Warning"
    if (-not $Silent) { Read-Host "Press Enter to exit" }
    exit 1
}

Write-Status "Found Zoom at: $zoomPath" "Success"
Write-Status "Launching Zoom as '$GhostUser'..." "Info"

# Launch Zoom via PsExec
try {
    $process = Start-Process -FilePath $psexecPath -ArgumentList @(
        "-accepteula",
        "-u", $GhostUser,
        "-p", $GhostPass,
        "-i",  # Interactive
        "-h",  # Elevated token
        $zoomPath
    ) -PassThru -WindowStyle Hidden

    Write-Status "Zoom launched successfully!" "Success"
    Write-Host ""
    Write-Host "Zoom is now running under the ghost user account." -ForegroundColor Green
    Write-Host "Close this window when you're done with Zoom." -ForegroundColor White
    Write-Host ""

    if (-not $Silent) {
        Write-Host "Waiting for Zoom to close..." -ForegroundColor Gray
        $process.WaitForExit()
        Write-Status "Zoom closed" "Info"
    }
}
catch {
    Write-Status "Failed to launch Zoom: $_" "Error"
}

if (-not $Silent) {
    Read-Host "Press Enter to exit"
}
