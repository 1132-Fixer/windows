# Manual cleanup test for 1132 Remover
# This tests: stop service -> delete folders -> verify

Write-Host "=== STEP 1: Stop ZoomCptService ===" -ForegroundColor Cyan
$svc = Get-Service -Name 'ZoomCptService' -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "Current status: $($svc.Status)"
    if ($svc.Status -eq 'Running') {
        Stop-Service -Name 'ZoomCptService' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name 'ZoomCptService' -ErrorAction SilentlyContinue
        Write-Host "After stop: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Stopped') { 'Green' } else { 'Red' })
    }
} else {
    Write-Host "Service not found" -ForegroundColor Gray
}

Write-Host "`n=== STEP 2: Kill remaining processes ===" -ForegroundColor Cyan
$procs = Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' }
if ($procs) {
    $procs | ForEach-Object {
        Write-Host "Killing: $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "No Zoom processes running" -ForegroundColor Green
}

Write-Host "`n=== STEP 3: Delete user profile Zoom folders ===" -ForegroundColor Cyan
$folders = @(
    "$env:APPDATA\Zoom",
    "$env:LOCALAPPDATA\Zoom"
)
foreach ($folder in $folders) {
    if (Test-Path $folder) {
        Write-Host "Deleting: $folder"
        try {
            Remove-Item -Path $folder -Recurse -Force -ErrorAction Stop
            Write-Host "  [DELETED]" -ForegroundColor Green
        } catch {
            Write-Host "  [FAILED] $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "Not found: $folder" -ForegroundColor Gray
    }
}

Write-Host "`n=== STEP 4: Delete HKCU\Software\Zoom registry ===" -ForegroundColor Cyan
$regPath = "HKCU:\Software\Zoom"
if (Test-Path $regPath) {
    Write-Host "Deleting: $regPath"
    try {
        Remove-Item -Path $regPath -Recurse -Force -ErrorAction Stop
        Write-Host "  [DELETED]" -ForegroundColor Green
    } catch {
        Write-Host "  [FAILED] $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "Not found: $regPath" -ForegroundColor Gray
}

Write-Host "`n=== STEP 5: Verify cleanup ===" -ForegroundColor Cyan

# Check processes
$procs = Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' }
Write-Host "Zoom processes remaining: $(if ($procs) { $procs.Count } else { 0 })"

# Check folders
foreach ($folder in $folders) {
    $exists = Test-Path $folder
    Write-Host "$folder exists: $exists"
}

# Check registry
$regExists = Test-Path "HKCU:\Software\Zoom"
Write-Host "HKCU\Software\Zoom exists: $regExists"

Write-Host "`n=== CLEANUP COMPLETE ===" -ForegroundColor $(if (-not $procs -and -not $regExists) { 'Green' } else { 'Yellow' })
