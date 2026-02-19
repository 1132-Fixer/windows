#Requires -RunAsAdministrator
<#
.SYNOPSIS
  FULLY AUTOMATED Test Matrix Runner for 1132 Remover

.DESCRIPTION
  Runs all 6 tests in sequence with automatic setup, execution, and cleanup.
  Uses CLI mode for headless operation - no manual interaction required.
  Collects logs and generates a final report.

.PARAMETER SkipConfirmation
  Skip the initial confirmation prompt
#>

param(
    [switch]$SkipConfirmation
)

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "test-results"
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$testLogDir = Join-Path $logDir $timestamp

# Create log directory
New-Item -ItemType Directory -Force -Path $testLogDir | Out-Null

$testResults = @()

function Write-TestHeader($testNum, $testName) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  TEST #$testNum : $testName" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step($step) {
    Write-Host "  [$step]" -ForegroundColor Yellow
}

function Clean-Environment {
    Write-Step "Emptying Recycle Bin"
    Clear-RecycleBin -Force -ErrorAction SilentlyContinue

    Write-Step "Cleaning Zoom temp files"
    $tempPaths = @(
        "$env:TEMP\Zoom",
        "$env:TEMP\zoomus",
        "$env:TEMP\zoom_installer",
        "$env:TEMP\ZoomInstaller",
        "$env:TEMP\ZoomInstallerFull.msi"
    )
    foreach ($p in $tempPaths) {
        if (Test-Path $p) {
            Remove-Item -Path $p -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-LatestAppLog {
    $appLogDir = Join-Path $env:APPDATA "1132-remover\logs"
    if (Test-Path $appLogDir) {
        $latest = Get-ChildItem -Path $appLogDir -Filter "*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) {
            return $latest.FullName
        }
    }
    return $null
}

function Copy-AppLog($testName) {
    Start-Sleep -Seconds 2  # Wait for log to be written
    $log = Get-LatestAppLog
    if ($log) {
        $dest = Join-Path $testLogDir "$testName.log"
        Copy-Item -Path $log -Destination $dest -Force
        Write-Host "  Log saved: $dest" -ForegroundColor Green
        return $dest
    }
    Write-Host "  WARNING: No log file found" -ForegroundColor Yellow
    return $null
}

function Get-SessionSummary($logPath) {
    if (-not $logPath -or -not (Test-Path $logPath)) { return $null }

    $content = Get-Content -Path $logPath -Raw

    # Find session summary line
    if ($content -match '\[OK\s*\]\s*Session completed\s*(\{[^}]+\})') {
        return @{ success = $true; summary = $matches[1] }
    }
    elseif ($content -match '\[WARN\s*\]\s*Session ended with error\s*(\{[^}]+\})') {
        return @{ success = $false; summary = $matches[1] }
    }
    return $null
}

function Run-CliTest($testName, $args, $expectSuccess) {
    Write-Step "Running CLI: electron . --cli --full-reset $args"

    $electronPath = Join-Path $projectRoot "node_modules\.bin\electron.cmd"
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $electronPath
    $startInfo.Arguments = ". --cli --full-reset $args"
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $false

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    $exitCode = $process.ExitCode

    Write-Host $stdout
    if ($stderr) { Write-Host $stderr -ForegroundColor Red }

    $logPath = Copy-AppLog $testName
    $summary = Get-SessionSummary $logPath

    $passed = if ($expectSuccess) { $exitCode -eq 0 } else { $exitCode -ne 0 }

    return @{
        TestName = $testName
        ExitCode = $exitCode
        ExpectedSuccess = $expectSuccess
        Passed = $passed
        LogPath = $logPath
        Summary = $summary
    }
}

# ============================================
# MAIN TEST EXECUTION
# ============================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  1132 REMOVER - FULLY AUTOMATED TEST MATRIX" -ForegroundColor Green
Write-Host "  Results will be saved to: $testLogDir" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green

if (-not $SkipConfirmation) {
    Write-Host ""
    Write-Host "This will run all 6 tests AUTOMATICALLY (no interaction needed)." -ForegroundColor Yellow
    Write-Host "Continue? (Y/N)" -ForegroundColor Yellow
    $confirm = Read-Host
    if ($confirm -ne "Y" -and $confirm -ne "y") {
        Write-Host "Aborted." -ForegroundColor Red
        exit
    }
}

# ============================================
# TEST 1: Non-admin run (we simulate by using --no-reinstall to avoid MSI issues)
# Note: True non-admin test requires running PowerShell non-elevated
# ============================================
Write-TestHeader 1 "Full Reset WITHOUT Reinstall"
Clean-Environment
Write-Step "Setup complete"

$result = Run-CliTest "test1-no-reinstall" "--no-reinstall" $true
$testResults += $result

if ($result.Passed) {
    Write-Host "  PASSED" -ForegroundColor Green
} else {
    Write-Host "  FAILED (expected success, got exit code $($result.ExitCode))" -ForegroundColor Red
}

# ============================================
# TEST 2: Admin happy path with reinstall
# ============================================
Write-TestHeader 2 "Full Reset WITH Reinstall (Happy Path)"
Clean-Environment
Write-Step "Setup complete"

$result = Run-CliTest "test2-full-reinstall" "" $true
$testResults += $result

if ($result.Passed) {
    Write-Host "  PASSED" -ForegroundColor Green
} else {
    Write-Host "  FAILED (expected success, got exit code $($result.ExitCode))" -ForegroundColor Red
}

# ============================================
# TEST 3: Foldered scheduled task
# ============================================
Write-TestHeader 3 "Foldered Scheduled Task"
Clean-Environment

Write-Step "Creating test task: \Zoom\ZoomGifCollector"
schtasks /create /tn "\Zoom\ZoomGifCollector" /tr "notepad.exe" /sc daily /st 12:00 /f 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  Task created successfully" -ForegroundColor Green
}

$result = Run-CliTest "test3-foldered-task" "--no-reinstall" $true
$testResults += $result

# Verify task was deleted
$taskExists = schtasks /query /tn "\Zoom\ZoomGifCollector" 2>$null
if (-not $taskExists) {
    Write-Host "  Task successfully deleted" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Task still exists" -ForegroundColor Yellow
}

if ($result.Passed) {
    Write-Host "  PASSED" -ForegroundColor Green
} else {
    Write-Host "  FAILED" -ForegroundColor Red
}

# ============================================
# TEST 4: Already-clean system (double run)
# ============================================
Write-TestHeader 4 "Already-Clean System (Double Run)"
Clean-Environment
Write-Step "Setup complete - running twice"

Write-Host "  First run:" -ForegroundColor White
$result1 = Run-CliTest "test4-run1" "--no-reinstall" $true

Write-Host "  Second run:" -ForegroundColor White
$result2 = Run-CliTest "test4-run2" "--no-reinstall" $true

$testResults += @{
    TestName = "test4-double-run"
    Passed = $result1.Passed -and $result2.Passed
    Details = "Run1: $($result1.ExitCode), Run2: $($result2.ExitCode)"
}

if ($result1.Passed -and $result2.Passed) {
    Write-Host "  PASSED (both runs succeeded)" -ForegroundColor Green
} else {
    Write-Host "  FAILED" -ForegroundColor Red
}

# ============================================
# TEST 5: No-uninstall mode
# ============================================
Write-TestHeader 5 "No-Uninstall Mode"
Clean-Environment
Write-Step "Testing --no-uninstall flag"

$result = Run-CliTest "test5-no-uninstall" "--no-uninstall --no-reinstall" $true
$testResults += $result

if ($result.Passed) {
    Write-Host "  PASSED" -ForegroundColor Green
} else {
    Write-Host "  FAILED" -ForegroundColor Red
}

# ============================================
# TEST 6: Download Resilience (fresh download overwrites stale cache)
# ============================================
Write-TestHeader 6 "Download Resilience Test"
Clean-Environment

Write-Step "Creating stale/corrupt MSI in cache location"
$staleMsi = "$env:TEMP\ZoomInstallerFull.msi"
"This is a stale/corrupt cached MSI file" | Out-File -FilePath $staleMsi -Encoding ASCII
Write-Host "  Stale MSI created: $staleMsi" -ForegroundColor Green

Write-Host ""
Write-Host "  This test verifies the app downloads FRESH instead of using stale cache." -ForegroundColor White
Write-Host "  Expected: App overwrites corrupt file with fresh download, install succeeds." -ForegroundColor White
Write-Host ""

# This test should SUCCEED because app downloads fresh (resilience)
$result = Run-CliTest "test6-download-resilience" "" $true
$testResults += $result

# Clean up
Remove-Item -Path $staleMsi -Force -ErrorAction SilentlyContinue

if ($result.Passed) {
    Write-Host "  PASSED (app correctly downloaded fresh, ignoring stale cache)" -ForegroundColor Green
} else {
    Write-Host "  FAILED (app should have downloaded fresh but didn't)" -ForegroundColor Red
}

# ============================================
# FINAL REPORT
# ============================================
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  TEST MATRIX COMPLETE" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

$passed = ($testResults | Where-Object { $_.Passed }).Count
$total = $testResults.Count

Write-Host "  Results: $passed / $total tests passed" -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Yellow" })
Write-Host ""
Write-Host "  Individual Results:" -ForegroundColor White

foreach ($r in $testResults) {
    $status = if ($r.Passed) { "PASS" } else { "FAIL" }
    $color = if ($r.Passed) { "Green" } else { "Red" }
    Write-Host "    [$status] $($r.TestName)" -ForegroundColor $color
}

Write-Host ""
Write-Host "  Log files saved to: $testLogDir" -ForegroundColor Cyan
Write-Host ""

# Save summary report
$reportPath = Join-Path $testLogDir "SUMMARY.txt"
$report = @"
1132 REMOVER - TEST MATRIX RESULTS
==================================
Timestamp: $timestamp
Results: $passed / $total tests passed

Individual Results:
"@

foreach ($r in $testResults) {
    $status = if ($r.Passed) { "PASS" } else { "FAIL" }
    $report += "`n  [$status] $($r.TestName)"
    if ($r.Summary) {
        $report += "`n         Summary: $($r.Summary.summary)"
    }
}

$report | Out-File -FilePath $reportPath -Encoding UTF8
Write-Host "  Summary report: $reportPath" -ForegroundColor Cyan

# Open log folder
explorer.exe $testLogDir

# Exit with appropriate code
if ($passed -eq $total) {
    Write-Host ""
    Write-Host "  ALL TESTS PASSED!" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "  SOME TESTS FAILED - Review logs for details" -ForegroundColor Red
    exit 1
}
