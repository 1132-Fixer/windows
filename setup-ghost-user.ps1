#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Sets up a ghost user account for running Zoom in an isolated environment.

.DESCRIPTION
    Creates a separate Windows user account that can be used to run Zoom
    with a clean profile. Sets up junction links to the main user's folders
    for convenient file access.

.NOTES
    Run as Administrator.
#>

param(
    [string]$GhostUser = "zoom1132eliminator",
    [string]$GhostPass = "Z1132elim!",
    [switch]$Silent
)

$ErrorActionPreference = "SilentlyContinue"
$MainUser = $env:USERNAME
$MainProfile = "C:\Users\$MainUser"

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

function Test-UserExists {
    param([string]$Username)
    $user = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue
    return $null -ne $user
}

function New-GhostUser {
    Write-Status "Creating ghost user account: $GhostUser" "Info"

    if (Test-UserExists -Username $GhostUser) {
        Write-Status "User already exists" "Warning"
        return $true
    }

    try {
        $securePass = ConvertTo-SecureString $GhostPass -AsPlainText -Force
        New-LocalUser -Name $GhostUser -Password $securePass -FullName "Zoom Ghost User" -Description "Isolated user for Zoom" -PasswordNeverExpires -ErrorAction Stop
        Add-LocalGroupMember -Group "Users" -Member $GhostUser -ErrorAction Stop
        Write-Status "User created successfully" "Success"
        return $true
    }
    catch {
        Write-Status "Failed to create user: $_" "Error"
        return $false
    }
}

function Initialize-UserProfile {
    Write-Status "Initializing user profile..." "Info"

    # Download PsExec if needed
    $psexecPath = "$env:TEMP\PsExec64.exe"
    if (-not (Test-Path $psexecPath)) {
        Write-Status "Downloading PsExec..." "Info"
        try {
            Invoke-WebRequest -Uri "https://live.sysinternals.com/PsExec64.exe" -OutFile $psexecPath -UseBasicParsing
        }
        catch {
            Write-Status "Failed to download PsExec: $_" "Error"
            return $false
        }
    }

    # Run a command as the ghost user to initialize the profile
    $process = Start-Process -FilePath $psexecPath -ArgumentList "-accepteula", "-u", $GhostUser, "-p", $GhostPass, "-w", "C:\", "cmd", "/c", "echo Profile initialized" -Wait -PassThru -WindowStyle Hidden

    Start-Sleep -Seconds 3

    Write-Status "Profile initialized" "Success"
    return $true
}

function New-JunctionLinks {
    Write-Status "Creating junction links to main user folders..." "Info"

    $ghostProfile = "C:\Users\$GhostUser"
    $folders = @("Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music")

    # Wait for profile folder to exist
    $attempts = 0
    while (-not (Test-Path $ghostProfile) -and $attempts -lt 10) {
        Start-Sleep -Seconds 1
        $attempts++
    }

    if (-not (Test-Path $ghostProfile)) {
        Write-Status "Ghost profile folder not found" "Error"
        return $false
    }

    foreach ($folder in $folders) {
        $targetPath = Join-Path $ghostProfile $folder
        $sourcePath = Join-Path $MainProfile $folder

        # Remove existing folder if it exists and is not a junction
        if (Test-Path $targetPath) {
            $item = Get-Item $targetPath -Force
            if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                Remove-Item $targetPath -Recurse -Force -ErrorAction SilentlyContinue
            }
            else {
                Write-Status "  $folder already linked" "Warning"
                continue
            }
        }

        # Create junction link
        cmd /c mklink /J "$targetPath" "$sourcePath" 2>$null

        if (Test-Path $targetPath) {
            Write-Status "  Linked: $folder -> $sourcePath" "Success"
        }
        else {
            Write-Status "  Failed to link: $folder" "Error"
        }
    }

    return $true
}

function Set-ProfilePermissions {
    Write-Status "Setting profile permissions..." "Info"

    $ghostProfile = "C:\Users\$GhostUser"

    if (Test-Path $ghostProfile) {
        icacls $ghostProfile /grant "Everyone:(OI)(CI)F" /T /Q
        Write-Status "Permissions set" "Success"
    }
}

# Main execution
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "     1132 REMOVER - GHOST USER SETUP   " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Ghost User: $GhostUser" -ForegroundColor White
Write-Host "Main User:  $MainUser" -ForegroundColor White
Write-Host ""

# Execute setup steps
$success = New-GhostUser
if (-not $success) {
    Write-Status "Setup failed at user creation" "Error"
    exit 1
}

$success = Initialize-UserProfile
if (-not $success) {
    Write-Status "Setup failed at profile initialization" "Error"
    exit 1
}

New-JunctionLinks
Set-ProfilePermissions

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "       GHOST USER SETUP COMPLETE       " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Ghost user '$GhostUser' is ready." -ForegroundColor Green
Write-Host "Use zoom-ghost-launcher.ps1 to run Zoom." -ForegroundColor White
Write-Host ""

if (-not $Silent) {
    Read-Host "Press Enter to exit"
}
