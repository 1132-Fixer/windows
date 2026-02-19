Write-Host "=== Post-Reset Verification ===" -ForegroundColor Cyan

# Check services
Write-Host "`n[Services]" -ForegroundColor Yellow
$svc = Get-Service -Name 'ZoomCptService' -ErrorAction SilentlyContinue
if ($svc) { Write-Host "  ZoomCptService: $($svc.Status)" -ForegroundColor Red }
else { Write-Host "  ZoomCptService: Not found" -ForegroundColor Green }

# Check processes
Write-Host "`n[Processes]" -ForegroundColor Yellow
$procs = Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' }
if ($procs) {
    $procs | ForEach-Object { Write-Host "  $($_.Name): Running" -ForegroundColor Red }
} else {
    Write-Host "  No Zoom processes" -ForegroundColor Green
}

# Check folders
Write-Host "`n[Folders]" -ForegroundColor Yellow
$folders = @(
    "$env:APPDATA\Zoom",
    "$env:LOCALAPPDATA\Zoom",
    "$env:PROGRAMDATA\Zoom",
    "C:\Program Files\Zoom",
    "C:\Program Files (x86)\Zoom"
)
foreach ($f in $folders) {
    if (Test-Path $f) { Write-Host "  EXISTS: $f" -ForegroundColor Red }
    else { Write-Host "  Clean: $f" -ForegroundColor Green }
}

# Check registry
Write-Host "`n[Registry]" -ForegroundColor Yellow
$regKeys = @(
    "HKCU:\Software\Zoom",
    "HKCU:\Software\CptService",
    "HKLM:\Software\Zoom",
    "HKLM:\Software\Zoom\Secrets",
    "HKCU:\Software\IM Providers\Zoom"
)
foreach ($key in $regKeys) {
    if (Test-Path $key) { Write-Host "  EXISTS: $key" -ForegroundColor Red }
    else { Write-Host "  Clean: $key" -ForegroundColor Green }
}

# Check scheduled tasks
Write-Host "`n[Scheduled Tasks]" -ForegroundColor Yellow
$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -like '*zoom*' } -ErrorAction SilentlyContinue
if ($tasks) {
    $tasks | ForEach-Object { Write-Host "  EXISTS: $($_.TaskName)" -ForegroundColor Red }
} else {
    Write-Host "  No Zoom tasks" -ForegroundColor Green
}

Write-Host "`n=== Verification Complete ===" -ForegroundColor Cyan
